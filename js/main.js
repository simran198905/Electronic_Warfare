import { RFEnvironment, SeededRNG } from './simulator.js';
import { createAllStrategies } from './strategies.js';
import { MetricsTracker } from './metrics.js';
import { globalAudio } from './audio.js';
import { OperatorDuelController } from './duel.js';

// ─── State ────────────────────────────────────────────────────────────────────
let NUM_BANDS = 16;
const WATERFALL_COLS = 80; // time steps visible in waterfall

let currentSeed = 42;
let isEvalMode = false;
let env = new RFEnvironment({ numBands: NUM_BANDS, seed: currentSeed });
let strategies = createAllStrategies(NUM_BANDS, currentSeed);
let metrics = strategies.map(s => new MetricsTracker(s.name, s.color));
let duelController = new OperatorDuelController(NUM_BANDS);

let running = false;
let simInterval = null;
let stepCount = 0;
let simSpeed = 100; // ms per step
let activeTab = 'dashboard';

// Waterfall buffer: [time][band] = { activity: bool, receiver: strategyIndex[] }
let waterfallBuffer = [];
let receiverPositions = strategies.map(() => []);

// Chart instances
let pdChart, rewardChart, bandDensityChart, interceptRateChart, compareChart;

// ─── Init ─────────────────────────────────────────────────────────────────────
function boot() {
  initUI();
  initAudio();
  initDuelController();
  renderChannelKeysDeck();
  initCharts();
  renderQTable();
  updateMetricCards();
  renderEmitterTable();
  updateStrategyCards();
  updateHeaderState();
  startOscilloscopeLoop();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

function initUI() {
  // Tab navigation
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  document.getElementById('btn-start').addEventListener('click', startSim);
  document.getElementById('btn-pause').addEventListener('click', pauseSim);
  document.getElementById('btn-reset').addEventListener('click', () => resetSim());
  document.getElementById('btn-step').addEventListener('click', () => stepOnce());

  // Train vs Evaluation mode toggle
  const modeBtn = document.getElementById('btn-mode-toggle');
  if (modeBtn) {
    modeBtn.addEventListener('click', () => {
      isEvalMode = !isEvalMode;
      const qStrat = strategies.find(s => s.name.includes('Q-Learning'));
      if (qStrat) qStrat.getAgent().setEvaluationMode(isEvalMode);

      const modeBadge = document.getElementById('mode-badge');
      const modeLabel = document.getElementById('btn-mode-label');
      if (modeBadge) {
        modeBadge.textContent = isEvalMode ? 'EVALUATION (FROZEN)' : 'TRAINING (EXPLORE)';
        modeBadge.style.color = isEvalMode ? 'var(--accent-green)' : 'var(--accent-blue)';
      }
      if (modeLabel) {
        modeLabel.textContent = isEvalMode ? 'Mode: Eval (Frozen)' : 'Mode: Train (Explore)';
      }
    });
  }

  // PRNG Seed Selector
  const seedSelect = document.getElementById('seed-select');
  if (seedSelect) {
    seedSelect.addEventListener('change', e => {
      if (e.target.value === 'random') {
        currentSeed = Math.floor(Math.random() * 100000);
      } else {
        currentSeed = parseInt(e.target.value, 10);
      }
      const seedDisplay = document.getElementById('current-seed-display');
      if (seedDisplay) seedDisplay.textContent = currentSeed;
      resetSim();
    });
  }

  // Export CSV
  const exportBtn = document.getElementById('btn-export-csv');
  if (exportBtn) {
    exportBtn.addEventListener('click', exportCSVReport);
  }

  // Model Persistence: Save & Load
  const exportWeightsBtn = document.getElementById('btn-export-weights');
  if (exportWeightsBtn) {
    exportWeightsBtn.addEventListener('click', exportModelWeights);
  }

  const importWeightsBtn = document.getElementById('btn-import-weights');
  if (importWeightsBtn) {
    importWeightsBtn.addEventListener('click', importModelWeights);
  }

  // Speed Slider
  document.getElementById('speed-slider').addEventListener('input', e => {
    simSpeed = 1005 - parseInt(e.target.value);
    document.getElementById('speed-label').textContent = `${Math.round(1000 / simSpeed)} Hz`;
    if (running) {
      clearInterval(simInterval);
      simInterval = setInterval(stepOnce, simSpeed);
    }
  });

  // Channel Count Selector
  document.getElementById('bands-select').addEventListener('change', e => {
    NUM_BANDS = parseInt(e.target.value);
    duelController.setNumBands(NUM_BANDS);
    renderChannelKeysDeck();
    resetSim(NUM_BANDS);
  });

  // Dismiss Debrief
  const dismissBtn = document.getElementById('btn-close-debrief');
  if (dismissBtn) {
    dismissBtn.addEventListener('click', () => {
      const panel = document.getElementById('debrief-panel');
      if (panel) panel.style.display = 'none';
    });
  }
}

// ─── Audio Engine Integration ─────────────────────────────────────────────────
function initAudio() {
  const audioBtn = document.getElementById('btn-audio-toggle');
  const audioLabel = document.getElementById('audio-status-label');
  const volumeSlider = document.getElementById('audio-volume');

  if (audioBtn) {
    audioBtn.addEventListener('click', () => {
      const isMuted = globalAudio.enabled;
      globalAudio.setMuted(isMuted);
      audioBtn.classList.toggle('active', !isMuted);
      if (audioLabel) {
        audioLabel.textContent = !isMuted ? 'Headphones: LIVE (Sonified)' : 'Headphones: Muted';
      }
    });
  }

  if (volumeSlider) {
    volumeSlider.addEventListener('input', e => {
      globalAudio.setVolume(parseFloat(e.target.value));
    });
  }
}

function startOscilloscopeLoop() {
  const canvas = document.getElementById('audio-scope');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  function draw() {
    requestAnimationFrame(draw);
    const data = globalAudio.getWaveformData();
    ctx.fillStyle = '#080c14';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.lineWidth = 1.5;
    ctx.strokeStyle = globalAudio.enabled ? '#10b981' : '#475569';
    ctx.beginPath();

    const sliceWidth = canvas.width / data.length;
    let x = 0;
    for (let i = 0; i < data.length; i++) {
      const v = data[i] / 128.0;
      const y = (v * canvas.height) / 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      x += sliceWidth;
    }
    ctx.stroke();
  }
  draw();
}

// ─── Human Operator Duel Controller ───────────────────────────────────────────
function initDuelController() {
  const btn30 = document.getElementById('btn-duel-30');
  const btn60 = document.getElementById('btn-duel-60');
  const timerBadge = document.getElementById('duel-timer-badge');
  const timerVal = document.getElementById('duel-timer-val');

  if (btn30) {
    btn30.addEventListener('click', () => {
      duelController.startSortie(30);
      if (timerBadge) timerBadge.style.display = 'flex';
      if (!running) startSim();
    });
  }

  if (btn60) {
    btn60.addEventListener('click', () => {
      duelController.startSortie(60);
      if (timerBadge) timerBadge.style.display = 'flex';
      if (!running) startSim();
    });
  }

  duelController.onStateChange = (state) => {
    if (timerVal) timerVal.textContent = `${state.timeRemaining}s`;
    if (!state.isActive && timerBadge) {
      timerBadge.style.display = 'none';
    }
    updateHumanTunedDisplay(state.humanBand);
  };

  duelController.onDebriefReady = (debrief) => {
    showDebriefModal(debrief);
  };
}

function renderChannelKeysDeck() {
  const deck = document.getElementById('channel-keys-deck');
  if (!deck) return;

  const hotkeys = ['1','2','3','4','5','6','7','8','Q','W','E','R','T','Y','U','I'];
  let html = '';

  for (let b = 0; b < NUM_BANDS; b++) {
    const hk = hotkeys[b] || `${b}`;
    html += `
      <div class="channel-key" data-band="${b}" id="chkey-${b}">
        <div class="key-id">CH${b.toString().padStart(2, '0')}</div>
        <div class="key-hotkey">[${hk}]</div>
        <div class="key-signal-dot" id="chdot-${b}"></div>
      </div>
    `;
  }

  deck.innerHTML = html;

  deck.querySelectorAll('.channel-key').forEach(el => {
    el.addEventListener('click', () => {
      const b = parseInt(el.dataset.band, 10);
      duelController.tuneTo(b);
      // If audio is muted, auto-unmute on user interaction so they can hear immediately
      if (!globalAudio.enabled) {
        const audioBtn = document.getElementById('btn-audio-toggle');
        if (audioBtn) audioBtn.click();
      }
    });
  });

  updateHumanTunedDisplay(duelController.humanBand);
}

function updateHumanTunedDisplay(tunedBand) {
  const label = document.getElementById('current-human-band-label');
  if (label) label.textContent = `CH${tunedBand.toString().padStart(2, '0')}`;

  document.querySelectorAll('.channel-key').forEach((el, idx) => {
    el.classList.toggle('active-human', idx === tunedBand);
  });
}

function showDebriefModal(debrief) {
  const panel = document.getElementById('debrief-panel');
  const body = document.getElementById('debrief-body');
  if (!panel || !body) return;

  const qIdx = strategies.findIndex(s => s.name.includes('Q-Learning'));
  const pIdx = strategies.findIndex(s => s.name.includes('Periodic'));
  const qm = qIdx >= 0 ? metrics[qIdx].getSummary() : { pd: 0, avgInterceptTimeError: 0, hits: 0 };
  const pm = pIdx >= 0 ? metrics[pIdx].getSummary() : { pd: 0, avgInterceptTimeError: 0, hits: 0 };

  const humanPd = parseFloat(debrief.humanPd);
  const aiPd = (qm.pd * 100).toFixed(1);
  const pPd = (pm.pd * 100).toFixed(1);

  const delta = (parseFloat(aiPd) - humanPd).toFixed(1);

  body.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1.2fr;gap:1.25rem;margin-top:0.5rem">
      <div>
        <div style="font-size:0.75rem;text-transform:uppercase;color:var(--text-muted);font-weight:700;margin-bottom:0.4rem">Sortie Performance Comparison</div>
        <table style="width:100%;font-size:0.78rem;font-family:var(--font-mono)">
          <tr><td style="color:#fb7185">👤 Human Operator:</td><td><strong>${humanPd}% Pd</strong> (${debrief.humanHits} hits · ${debrief.humanLatency} lag)</td></tr>
          <tr><td style="color:var(--accent-blue)">🧠 Q-Learning AI:</td><td><strong>${aiPd}% Pd</strong> (${qm.hits} hits · ${qm.avgInterceptTimeError.toFixed(2)} lag)</td></tr>
          <tr><td style="color:var(--accent-cyan)">🎯 Periodic Tracker:</td><td><strong>${pPd}% Pd</strong> (${pm.hits} hits · ${pm.avgInterceptTimeError.toFixed(2)} lag)</td></tr>
        </table>
        <div style="margin-top:0.75rem;padding:0.5rem;background:rgba(59,130,246,0.1);border-radius:4px;border-left:3px solid var(--accent-blue);font-size:0.75rem">
          <strong>Margin:</strong> AI intercepted <strong>${delta}% more pulses</strong> with sub-epoch response lag.
        </div>
      </div>
      <div>
        <div style="font-size:0.75rem;text-transform:uppercase;color:var(--text-muted);font-weight:700;margin-bottom:0.4rem">Scientific Post-Mortem: Why the Machine Won</div>
        <p style="font-size:0.76rem;color:var(--text-muted);line-height:1.5;margin-bottom:0.4rem">
          <strong>1. Cognitive Reaction Floor:</strong> Human visual & audio reaction time has an irreducible latency of ~250–350ms, causing late dwell arrival on short radar bursts.
        </p>
        <p style="font-size:0.76rem;color:var(--text-muted);line-height:1.5;margin-bottom:0.4rem">
          <strong>2. Mathematical Coincidence Prediction:</strong> The AI Periodic Estimator calculated exact pulse arrival phase (<code>t ≡ φ̂<sub>p</sub> (mod T̂<sub>p</sub>)</code>), tuning to channels <em>before</em> the pulse even fired.
        </p>
        <p style="font-size:0.76rem;color:var(--text-muted);line-height:1.5">
          <strong>3. Frequency Agile Tracking:</strong> Q-Learning adapted state-transition probability matrices to track frequency hoppers that humans could not predict.
        </p>
      </div>
    </div>
  `;

  panel.style.display = 'block';
}

function updateHeaderState() {
  const badge = document.getElementById('live-badge');
  const liveText = document.getElementById('live-text');
  const engineStatus = document.getElementById('engine-status');

  if (badge && liveText && engineStatus) {
    if (running) {
      badge.classList.remove('paused');
      liveText.textContent = 'RUNNING';
      engineStatus.textContent = 'ENGAGED';
      engineStatus.style.color = 'var(--accent-green)';
    } else {
      badge.classList.add('paused');
      liveText.textContent = 'PAUSED';
      engineStatus.textContent = 'STANDBY';
      engineStatus.style.color = 'var(--text-muted)';
    }
  }
}

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));
  if (tab === 'ml') renderQTable();
  if (tab === 'compare') {
    updateCompareSummaryTable();
    updateCompareChart();
  }
  if (tab === 'analysis') renderAnalysis();
}

// ─── Simulation Loop ──────────────────────────────────────────────────────────
function stepOnce() {
  const { activity, noise } = env.step();
  stepCount++;

  // 1. Human Operator step & audio synthesis
  const humanStep = duelController.step(activity, stepCount, noise, env.emitters);

  // Update channel key visual signals
  activity.forEach((active, b) => {
    const dot = document.getElementById(`chdot-${b}`);
    const key = document.getElementById(`chkey-${b}`);
    if (dot) dot.classList.toggle('live', active);
    if (key) {
      key.classList.toggle('rf-transmitting', active);
      if (b === humanStep.band && humanStep.wasHit) {
        key.classList.add('rf-hit');
        setTimeout(() => key.classList.remove('rf-hit'), 300);
      }
    }
  });

  // 2. Each AI strategy independently picks a band and receives reward
  strategies.forEach((strat, i) => {
    const band = strat.selectBand(stepCount);
    const reward = metrics[i].record(band, activity, stepCount, noise);
    strat.update(band, reward, activity, stepCount);
    receiverPositions[i].push(band);
    if (receiverPositions[i].length > WATERFALL_COLS) receiverPositions[i].shift();
  });

  // Waterfall buffer
  waterfallBuffer.push({
    activity: [...activity],
    receivers: strategies.map((_, i) => receiverPositions[i].slice(-1)[0]),
  });
  if (waterfallBuffer.length > WATERFALL_COLS) waterfallBuffer.shift();

  if (activeTab === 'dashboard') {
    drawWaterfall();
    updateMetricCards();
    updateLiveCharts();
    updateDuelScoreboard();
  }
  if (activeTab === 'ml') renderQTable();

  const stepCounter = document.getElementById('step-counter');
  if (stepCounter) stepCounter.textContent = `T = ${stepCount}`;
}

function updateDuelScoreboard() {
  const hm = duelController.humanMetrics.getSummary();
  const qIdx = strategies.findIndex(s => s.name.includes('Q-Learning'));
  const pIdx = strategies.findIndex(s => s.name.includes('Periodic'));
  const qm = qIdx >= 0 ? metrics[qIdx].getSummary() : null;
  const pm = pIdx >= 0 ? metrics[pIdx].getSummary() : null;
  const sm = metrics[0].getSummary();

  // Human
  const hPd = document.getElementById('duel-human-pd');
  const hHits = document.getElementById('duel-human-hits');
  const hLat = document.getElementById('duel-human-lat');
  const hRew = document.getElementById('duel-human-rew');
  if (hPd) hPd.textContent = (hm.pd * 100).toFixed(1) + '%';
  if (hHits) hHits.textContent = hm.hits;
  if (hLat) hLat.textContent = hm.avgInterceptTimeError.toFixed(2);
  if (hRew) hRew.textContent = hm.cumulativeReward.toFixed(1);

  // Q-Learning
  if (qm) {
    const qPd = document.getElementById('duel-ai-pd');
    const qHits = document.getElementById('duel-ai-hits');
    const qLat = document.getElementById('duel-ai-lat');
    const qRew = document.getElementById('duel-ai-rew');
    if (qPd) qPd.textContent = (qm.pd * 100).toFixed(1) + '%';
    if (qHits) qHits.textContent = qm.hits;
    if (qLat) qLat.textContent = qm.avgInterceptTimeError.toFixed(2);
    if (qRew) qRew.textContent = qm.cumulativeReward.toFixed(1);
  }

  // Periodic
  if (pm) {
    const pPd = document.getElementById('duel-periodic-pd');
    const pHits = document.getElementById('duel-periodic-hits');
    const pLat = document.getElementById('duel-periodic-lat');
    const pRew = document.getElementById('duel-periodic-rew');
    if (pPd) pPd.textContent = (pm.pd * 100).toFixed(1) + '%';
    if (pHits) pHits.textContent = pm.hits;
    if (pLat) pLat.textContent = pm.avgInterceptTimeError.toFixed(2);
    if (pRew) pRew.textContent = pm.cumulativeReward.toFixed(1);
  }

  // Sequential
  const sPd = document.getElementById('duel-seq-pd');
  const sHits = document.getElementById('duel-seq-hits');
  const sLat = document.getElementById('duel-seq-lat');
  const sRew = document.getElementById('duel-seq-rew');
  if (sPd) sPd.textContent = (sm.pd * 100).toFixed(1) + '%';
  if (sHits) sHits.textContent = sm.hits;
  if (sLat) sLat.textContent = sm.avgInterceptTimeError.toFixed(2);
  if (sRew) sRew.textContent = sm.cumulativeReward.toFixed(1);
}

function startSim() {
  if (running) return;
  running = true;
  document.getElementById('btn-start').disabled = true;
  document.getElementById('btn-pause').disabled = false;
  updateHeaderState();
  simInterval = setInterval(stepOnce, simSpeed);
}

function pauseSim() {
  running = false;
  clearInterval(simInterval);
  document.getElementById('btn-start').disabled = false;
  document.getElementById('btn-pause').disabled = true;
  updateHeaderState();
}

function resetSim(numBands) {
  pauseSim();
  const nb = numBands ?? NUM_BANDS;
  env = new RFEnvironment({ numBands: nb, seed: currentSeed });
  strategies = createAllStrategies(nb, currentSeed);
  duelController.setNumBands(nb);

  const qStrat = strategies.find(s => s.name.includes('Q-Learning'));
  if (qStrat) qStrat.getAgent().setEvaluationMode(isEvalMode);

  metrics = strategies.map(s => new MetricsTracker(s.name, s.color));
  receiverPositions = strategies.map(() => []);
  waterfallBuffer = [];
  stepCount = 0;
  const stepCounter = document.getElementById('step-counter');
  if (stepCounter) stepCounter.textContent = 'T = 0';
  updateHeaderState();
  drawWaterfall();
  updateMetricCards();
  updateDuelScoreboard();
  updateStrategyCards();
  renderEmitterTable();
  renderQTable();
  initCharts();
}


// ─── Waterfall Canvas ─────────────────────────────────────────────────────────
function drawWaterfall() {
  const canvas = document.getElementById('waterfall-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const numBands = env.numBands;
  const cellW = W / WATERFALL_COLS;
  const cellH = H / numBands;

  ctx.clearRect(0, 0, W, H);

  // Draw tactical background
  ctx.fillStyle = '#060a12';
  ctx.fillRect(0, 0, W, H);

  // Draw subtle horizontal grid divider lines
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.05)';
  ctx.lineWidth = 1;
  for (let b = 0; b <= numBands; b++) {
    const y = b * cellH;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }

  // Draw activity raster
  waterfallBuffer.forEach((frame, col) => {
    frame.activity.forEach((active, band) => {
      const x = col * cellW;
      const y = (numBands - 1 - band) * cellH;
      if (active) {
        ctx.fillStyle = '#10b981';
        ctx.fillRect(x + 0.5, y + 0.5, cellW - 0.5, cellH - 0.5);
      } else {
        ctx.fillStyle = 'rgba(14, 21, 36, 0.6)';
        ctx.fillRect(x + 0.5, y + 0.5, cellW - 0.5, cellH - 0.5);
      }
    });

    // Draw receiver tuned cursors (last column only)
    if (col === waterfallBuffer.length - 1) {
      const colors = strategies.map(s => s.color);
      frame.receivers.forEach((band, si) => {
        if (band === undefined) return;
        const x = col * cellW;
        const y = (numBands - 1 - band) * cellH;
        ctx.strokeStyle = colors[si];
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 1, y + 1, Math.max(cellW - 2, 4), cellH - 2);
      });
    }
  });

  // Draw Frequency Sub-Band Annotations
  ctx.fillStyle = 'rgba(148, 163, 184, 0.7)';
  ctx.font = '10px JetBrains Mono, monospace';
  for (let b = 0; b < numBands; b++) {
    const y = (numBands - 1 - b) * cellH + cellH / 2 + 3.5;
    ctx.fillText(`CH${b.toString().padStart(2, '0')}`, 6, y);
  }
}

// ─── Metric Cards ─────────────────────────────────────────────────────────────
function updateMetricCards() {
  const qIdx = strategies.findIndex(s => s.name.includes('Q-Learning'));
  const periodicIdx = strategies.findIndex(s => s.name.includes('Periodic'));
  const seqIdx = 0;
  const qm = metrics[qIdx >= 0 ? qIdx : 0];
  const pm = periodicIdx >= 0 ? metrics[periodicIdx] : qm;
  const sm = metrics[seqIdx];

  const cards = [
    { id: 'kpi-pd', value: (qm.pd * 100).toFixed(1) + '%' },
    { id: 'kpi-periodic-pd', value: (pm.pd * 100).toFixed(1) + '%' },
    { id: 'kpi-seq-pd', value: (sm.pd * 100).toFixed(1) + '%' },
    { id: 'kpi-cpc', value: qm.cpc.toFixed(1) + '%' },
    { id: 'kpi-intercept-time', value: qm.avgInterceptTimeError.toFixed(2) + ' steps' },
    { id: 'kpi-reward', value: qm.cumulativeReward.toFixed(1) },
  ];

  cards.forEach(c => {
    const el = document.getElementById(c.id);
    if (!el) return;
    const valEl = el.querySelector('.kpi-value');
    if (valEl) valEl.textContent = c.value;
  });
}

// ─── Charts ───────────────────────────────────────────────────────────────────
function initCharts() {
  if (typeof Chart === 'undefined') {
    console.warn('Chart.js not loaded. Live charts disabled.');
    return;
  }
  [pdChart, rewardChart, bandDensityChart, interceptRateChart].forEach(c => c?.destroy());

  const chartDefaults = {
    animation: false,
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        position: 'top',
        labels: {
          color: '#94a3b8',
          font: { family: 'Plus Jakarta Sans', size: 11, weight: 600 },
          boxWidth: 10,
          boxHeight: 10,
          usePointStyle: true,
          pointStyle: 'circle',
        },
      },
    },
    scales: {
      x: {
        ticks: { color: '#64748b', font: { family: 'JetBrains Mono', size: 10 } },
        grid: { color: 'rgba(148, 163, 184, 0.06)' },
      },
      y: {
        ticks: { color: '#64748b', font: { family: 'JetBrains Mono', size: 10 } },
        grid: { color: 'rgba(148, 163, 184, 0.06)' },
      },
    },
  };

  pdChart = new Chart(document.getElementById('chart-pd'), {
    type: 'line',
    data: {
      labels: [],
      datasets: strategies.map((s) => ({
        label: s.name,
        borderColor: s.color,
        backgroundColor: s.color + '15',
        data: [],
        tension: 0.2,
        fill: false,
        pointRadius: 0,
        borderWidth: 1.8,
      })),
    },
    options: {
      ...chartDefaults,
      plugins: {
        ...chartDefaults.plugins,
        title: {
          display: true,
          text: 'PROBABILITY OF DETECTION (Pd)',
          color: '#e2e8f0',
          font: { family: 'Plus Jakarta Sans', size: 12, weight: 700 },
          align: 'start',
          padding: { bottom: 12 },
        },
      },
    },
  });

  rewardChart = new Chart(document.getElementById('chart-reward'), {
    type: 'line',
    data: {
      labels: [],
      datasets: strategies.map((s) => ({
        label: s.name,
        borderColor: s.color,
        backgroundColor: s.color + '15',
        data: [],
        tension: 0.2,
        fill: false,
        pointRadius: 0,
        borderWidth: 1.8,
      })),
    },
    options: {
      ...chartDefaults,
      plugins: {
        ...chartDefaults.plugins,
        title: {
          display: true,
          text: 'CUMULATIVE OBJECTIVE REWARD',
          color: '#e2e8f0',
          font: { family: 'Plus Jakarta Sans', size: 12, weight: 700 },
          align: 'start',
          padding: { bottom: 12 },
        },
      },
    },
  });

  interceptRateChart = new Chart(document.getElementById('chart-intercept'), {
    type: 'line',
    data: {
      labels: [],
      datasets: strategies.map((s) => ({
        label: s.name,
        borderColor: s.color,
        backgroundColor: s.color + '15',
        data: [],
        tension: 0.2,
        fill: false,
        pointRadius: 0,
        borderWidth: 1.8,
      })),
    },
    options: {
      ...chartDefaults,
      plugins: {
        ...chartDefaults.plugins,
        title: {
          display: true,
          text: 'AVERAGE INTERCEPT RATE (AIR)',
          color: '#e2e8f0',
          font: { family: 'Plus Jakarta Sans', size: 12, weight: 700 },
          align: 'start',
          padding: { bottom: 12 },
        },
      },
    },
  });

  bandDensityChart = new Chart(document.getElementById('chart-band-density'), {
    type: 'bar',
    data: {
      labels: Array.from({ length: env.numBands }, (_, i) => `CH${i.toString().padStart(2, '0')}`),
      datasets: [{ label: 'Pulse Activity Density (%)', backgroundColor: [], data: [] }],
    },
    options: {
      ...chartDefaults,
      plugins: {
        ...chartDefaults.plugins,
        title: {
          display: true,
          text: 'CHANNEL TRANSMISSION DENSITY',
          color: '#e2e8f0',
          font: { family: 'Plus Jakarta Sans', size: 12, weight: 700 },
          align: 'start',
          padding: { bottom: 12 },
        },
      },
    },
  });
}

const CHART_SUBSAMPLE = 5;

function updateLiveCharts() {
  if (typeof Chart === 'undefined' || !pdChart) return;
  if (stepCount % CHART_SUBSAMPLE !== 0) return;
  const label = stepCount.toString();

  pdChart.data.labels.push(label);
  strategies.forEach((s, i) => {
    if (pdChart.data.datasets[i]) pdChart.data.datasets[i].data.push((metrics[i].pd * 100).toFixed(2));
  });
  if (pdChart.data.labels.length > 150) {
    pdChart.data.labels.shift();
    pdChart.data.datasets.forEach(d => d.data.shift());
  }
  pdChart.update('none');

  rewardChart.data.labels.push(label);
  strategies.forEach((s, i) => {
    if (rewardChart.data.datasets[i]) rewardChart.data.datasets[i].data.push(metrics[i].cumulativeReward.toFixed(2));
  });
  if (rewardChart.data.labels.length > 150) {
    rewardChart.data.labels.shift();
    rewardChart.data.datasets.forEach(d => d.data.shift());
  }
  rewardChart.update('none');

  interceptRateChart.data.labels.push(label);
  strategies.forEach((s, i) => {
    if (interceptRateChart.data.datasets[i]) interceptRateChart.data.datasets[i].data.push((metrics[i].avgInterceptRate * 100).toFixed(2));
  });
  if (interceptRateChart.data.labels.length > 150) {
    interceptRateChart.data.labels.shift();
    interceptRateChart.data.datasets.forEach(d => d.data.shift());
  }
  interceptRateChart.update('none');

  const density = env.getBandDensity();
  bandDensityChart.data.datasets[0].data = density.map(d => (d * 100).toFixed(1));
  bandDensityChart.data.datasets[0].backgroundColor = density.map(d => {
    const v = Math.min(d * 3, 1);
    return `rgba(59, 130, 246, ${0.3 + v * 0.6})`;
  });
  bandDensityChart.update('none');
}

function updateCompareChart() {
  if (typeof Chart === 'undefined') return;
  if (compareChart) compareChart.destroy();
  const ctx = document.getElementById('chart-compare');
  if (!ctx) return;

  const labels = ['Pd (%)', 'AIR (%)', 'Sensitivity (%)', 'CPC (%)', 'Low Latency Score'];
  compareChart = new Chart(ctx, {
    type: 'radar',
    data: {
      labels,
      datasets: strategies.map((s, i) => ({
        label: s.name,
        borderColor: s.color,
        backgroundColor: s.color + '25',
        data: [
          (metrics[i].pd * 100).toFixed(1),
          (metrics[i].avgInterceptRate * 100).toFixed(1),
          (metrics[i].sensitivity * 100).toFixed(1),
          metrics[i].cpc.toFixed(1),
          Math.max(0, 10 - metrics[i].avgInterceptTimeError).toFixed(1),
        ],
        pointBackgroundColor: s.color,
        pointRadius: 3,
        borderWidth: 1.8,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'top',
          labels: {
            color: '#94a3b8',
            font: { family: 'Plus Jakarta Sans', size: 11, weight: 600 },
            boxWidth: 8,
            boxHeight: 8,
          },
        },
      },
      scales: {
        r: {
          ticks: { color: '#64748b', backdropColor: 'transparent', font: { family: 'JetBrains Mono', size: 9 } },
          grid: { color: 'rgba(148, 163, 184, 0.12)' },
          pointLabels: { color: '#cbd5e1', font: { family: 'Plus Jakarta Sans', size: 10, weight: 600 } },
        },
      },
    },
  });
}

// ─── Q-Table & Periodic Tracker Visualization ─────────────────────────────────
function renderQTable() {
  const qIdx = strategies.findIndex(s => s.name.includes('Q-Learning'));
  if (qIdx >= 0) {
    const agent = strategies[qIdx].getAgent();
    const qTable = agent.getQTableFlat();
    const container = document.getElementById('qtable-container');
    if (container) {
      const numBands = qTable.length;
      let maxQ = 0, minQ = 0;
      qTable.forEach(row => row.forEach(v => {
        maxQ = Math.max(maxQ, v);
        minQ = Math.min(minQ, v);
      }));

      let html = '<table class="qtable"><thead><tr><th>From \\ To</th>';
      for (let b = 0; b < numBands; b++) html += `<th>CH${b}</th>`;
      html += '</tr></thead><tbody>';

      qTable.forEach((row, from) => {
        html += `<tr><td class="qtable-header">CH${from}</td>`;
        row.forEach((q, to) => {
          const norm = maxQ > minQ ? (q - minQ) / (maxQ - minQ) : 0;
          const alpha = 0.08 + norm * 0.75;
          const bg = norm > 0 ? `rgba(59, 130, 246, ${alpha})` : 'rgba(15, 23, 42, 0.4)';
          const textColor = norm > 0.5 ? '#ffffff' : 'var(--text-muted)';
          html += `<td style="background:${bg};color:${textColor}" title="Q[CH${from} → CH${to}] = ${q.toFixed(3)}">${q.toFixed(2)}</td>`;
        });
        html += '</tr>';
      });
      html += '</tbody></table>';
      container.innerHTML = html;
    }

    const epEl = document.getElementById('epsilon-display');
    if (epEl) epEl.textContent = (agent.evalMode ? 0.0 : agent.epsilon * 100).toFixed(1) + '%';
  }

  // Periodic Tracker Estimates
  const periodicIdx = strategies.findIndex(s => s.name.includes('Periodic'));
  if (periodicIdx >= 0) {
    const est = strategies[periodicIdx].getEstimator();
    const pEl = document.getElementById('periodic-estimates');
    if (pEl && est) {
      let rows = '';
      for (let b = 0; b < est.numBands; b++) {
        const T = est.estimatedPeriod[b];
        const phi = est.estimatedPhase[b];
        const conf = est.confidence[b];
        if (T !== null) {
          rows += `<div style="display:flex;justify-content:space-between;padding:0.25rem 0;border-bottom:1px solid rgba(148,163,184,0.08)">
            <span style="color:var(--accent-cyan);font-weight:600">CH${b.toString().padStart(2, '0')}:</span>
            <span>T_est = ${T} steps</span>
            <span>Phase = ${phi}</span>
            <span style="color:var(--accent-green)">Conf = ${(conf * 100).toFixed(0)}%</span>
          </div>`;
        }
      }
      pEl.innerHTML = rows || '<div style="color:var(--text-dim);padding:0.4rem 0">Observing RF spectrum for pulse arrivals...</div>';
    }
  }
}

// ─── Strategy Cards ───────────────────────────────────────────────────────────
function updateStrategyCards() {
  const container = document.getElementById('strategy-cards');
  if (!container) return;
  container.innerHTML = strategies.map((s) => `
    <div class="strategy-card" style="--accent:${s.color}">
      <div class="sc-header">
        <div class="sc-name">${s.name}</div>
        <div style="width:8px;height:8px;border-radius:50%;background:${s.color}"></div>
      </div>
      <div class="sc-desc">${s.description}</div>
    </div>
  `).join('');
}

// ─── Emitter Table ────────────────────────────────────────────────────────────
function renderEmitterTable() {
  const tbody = document.getElementById('emitter-tbody');
  if (!tbody) return;
  const typeMap = {
    periodic: { bg: 'rgba(59, 130, 246, 0.15)', color: '#60a5fa', label: 'PERIODIC RADAR' },
    spatial_scan: { bg: 'rgba(6, 182, 212, 0.15)', color: '#22d3ee', label: 'SPATIAL SCAN 360°' },
    agile: { bg: 'rgba(245, 158, 11, 0.15)', color: '#fbbf24', label: 'AGILE HOPPER' },
    intermittent: { bg: 'rgba(139, 92, 246, 0.15)', color: '#c084fc', label: 'INTERMITTENT' },
    burst: { bg: 'rgba(239, 68, 68, 0.15)', color: '#f87171', label: 'BURST EMITTER' },
  };

  tbody.innerHTML = env.getEmitterSummary().map(e => {
    const meta = typeMap[e.type] || { bg: 'rgba(148,163,184,0.1)', color: '#cbd5e1', label: e.type.toUpperCase() };
    const timing = e.config.period
      ? `${e.config.period} steps`
      : e.config.rotationPeriod
      ? `Rot: ${e.config.rotationPeriod} steps (${e.config.beamwidthDeg}° beam)`
      : e.config.hopInterval
      ? `Hop: ${e.config.hopInterval} steps`
      : '—';
    const prob = e.config.duty
      ? (e.config.duty * 100).toFixed(0) + '% (Duty)'
      : e.config.txProb
      ? (e.config.txProb * 100).toFixed(0) + '% (Prob)'
      : '—';

    return `<tr>
      <td style="font-weight:600;color:var(--text-muted)">#${e.id}</td>
      <td><span class="badge" style="background:${meta.bg};color:${meta.color};border:1px solid ${meta.color}40">${meta.label}</span></td>
      <td>CH${e.band.toString().padStart(2, '0')}</td>
      <td>${timing}</td>
      <td>${prob}</td>
      <td><span class="status-dot ${e.active ? 'active' : ''}"></span><span style="color:${e.active ? 'var(--accent-green)' : 'var(--text-dim)'};font-weight:600">${e.active ? 'TRANSMITTING' : 'QUIET'}</span></td>
    </tr>`;
  }).join('');
}

// ─── Analysis Tab (All 7 Figures of Merit) ──────────────────────────────────────
function renderAnalysis() {
  const tbody = document.getElementById('analysis-tbody');
  if (!tbody) return;
  tbody.innerHTML = strategies.map((s, i) => {
    const m = metrics[i].getSummary();
    return `<tr>
      <td><span style="color:${s.color};font-weight:700">${s.name}</span></td>
      <td>${(m.pd * 100).toFixed(1)}%</td>
      <td>${(m.pfa * 100).toFixed(2)}%</td>
      <td>${(m.avgInterceptRate * 100).toFixed(1)}%</td>
      <td>${m.avgInterceptTimeError.toFixed(2)}</td>
      <td>${(m.sensitivity * 100).toFixed(1)}%</td>
      <td>${m.cpc.toFixed(1)}%</td>
      <td>${m.hits}</td>
      <td>${m.misses}</td>
      <td>${m.falseAlarms}</td>
      <td>${m.cumulativeReward.toFixed(1)}</td>
    </tr>`;
  }).join('');
}

function updateCompareSummaryTable() {
  const tbody = document.getElementById('analysis-tbody-compare');
  if (!tbody) return;
  tbody.innerHTML = strategies.map((s, i) => {
    const m = metrics[i].getSummary();
    return `<tr>
      <td><span style="color:${s.color};font-weight:700">${s.name}</span></td>
      <td>${(m.pd * 100).toFixed(1)}%</td>
      <td>${(m.pfa * 100).toFixed(2)}%</td>
      <td>${(m.avgInterceptRate * 100).toFixed(1)}%</td>
      <td>${m.avgInterceptTimeError.toFixed(2)}</td>
      <td>${(m.sensitivity * 100).toFixed(1)}%</td>
      <td>${m.cpc.toFixed(1)}%</td>
      <td>${m.cumulativeReward.toFixed(1)}</td>
    </tr>`;
  }).join('');
}

// ─── CSV & Model Weight Exporters ─────────────────────────────────────────────
function exportCSVReport() {
  let csv = 'Strategy,Pd (%),Pfa (%),AIR (%),AITE (steps),Sensitivity (%),CPC (%),Hits,Misses,False Alarms,Reward\n';
  strategies.forEach((s, i) => {
    const m = metrics[i].getSummary();
    csv += `"${s.name}",${(m.pd*100).toFixed(2)},${(m.pfa*100).toFixed(2)},${(m.avgInterceptRate*100).toFixed(2)},${m.avgInterceptTimeError.toFixed(2)},${(m.sensitivity*100).toFixed(2)},${m.cpc.toFixed(2)},${m.hits},${m.misses},${m.falseAlarms},${m.cumulativeReward.toFixed(2)}\n`;
  });

  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `EW_SmartScan_Metrics_T${stepCount}_Seed${currentSeed}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function exportModelWeights() {
  const qStrat = strategies.find(s => s.name.includes('Q-Learning'));
  if (!qStrat) return;
  const json = qStrat.getAgent().exportModelJSON();
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `qlearning_model_weights_T${stepCount}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importModelWeights() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const qStrat = strategies.find(s => s.name.includes('Q-Learning'));
      if (qStrat && qStrat.getAgent().importModelJSON(ev.target.result)) {
        alert('Model weights imported successfully!');
        renderQTable();
      } else {
        alert('Invalid model weights file.');
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

// ─── Interval Timers ──────────────────────────────────────────────────────────
setInterval(() => {
  if (running && activeTab === 'dashboard') renderEmitterTable();
  if (activeTab === 'analysis') renderAnalysis();
}, 500);

setInterval(() => {
  if (activeTab === 'compare') {
    updateCompareSummaryTable();
    updateCompareChart();
  }
}, 1000);

