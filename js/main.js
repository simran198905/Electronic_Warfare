import { RFEnvironment } from './simulator.js';
import { createAllStrategies } from './strategies.js';
import { MetricsTracker } from './metrics.js';

// ─── State ────────────────────────────────────────────────────────────────────
const NUM_BANDS = 16;
const WATERFALL_COLS = 80; // time steps visible in waterfall

let env = new RFEnvironment({ numBands: NUM_BANDS });
let strategies = createAllStrategies(NUM_BANDS);
let metrics = strategies.map(s => new MetricsTracker(s.name, s.color));
let running = false;
let simInterval = null;
let stepCount = 0;
let simSpeed = 100; // ms per step
let activeTab = 'dashboard';

// Waterfall buffer: [time][band] = { activity: bool, receiver: strategyIndex[] }
let waterfallBuffer = [];
let receiverPositions = strategies.map(() => []); // per strategy, last N band positions

// Chart instances
let pdChart, rewardChart, bandDensityChart, interceptRateChart, compareChart;

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initUI();
  initCharts();
  renderQTable();
  updateMetricCards();
  renderEmitterTable();
  updateStrategyCards();
  updateHeaderState();
});

function initUI() {
  // Tab navigation
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  document.getElementById('btn-start').addEventListener('click', startSim);
  document.getElementById('btn-pause').addEventListener('click', pauseSim);
  document.getElementById('btn-reset').addEventListener('click', () => resetSim());
  document.getElementById('btn-step').addEventListener('click', () => stepOnce());

  document.getElementById('speed-slider').addEventListener('input', e => {
    simSpeed = 1005 - parseInt(e.target.value);
    document.getElementById('speed-label').textContent = `${Math.round(1000 / simSpeed)} Hz`;
    if (running) {
      clearInterval(simInterval);
      simInterval = setInterval(stepOnce, simSpeed);
    }
  });

  document.getElementById('bands-select').addEventListener('change', e => {
    resetSim(parseInt(e.target.value));
  });
}

function updateHeaderState() {
  const badge = document.getElementById('live-badge');
  const liveText = document.getElementById('live-text');
  const engineStatus = document.getElementById('engine-status');
  const headerChannels = document.getElementById('header-channels');

  if (headerChannels) headerChannels.textContent = `${env.numBands} CHANNELS`;
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
  const activity = env.step();
  stepCount++;

  // Each strategy independently picks a band and receives reward
  strategies.forEach((strat, i) => {
    const band = strat.selectBand();
    const reward = metrics[i].record(band, activity, stepCount);
    strat.update(band, reward, activity);
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
  }
  if (activeTab === 'ml') renderQTable();

  const stepCounter = document.getElementById('step-counter');
  if (stepCounter) stepCounter.textContent = `T = ${stepCount}`;
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
  env = new RFEnvironment({ numBands: nb });
  strategies = createAllStrategies(nb);
  metrics = strategies.map(s => new MetricsTracker(s.name, s.color));
  receiverPositions = strategies.map(() => []);
  waterfallBuffer = [];
  stepCount = 0;
  const stepCounter = document.getElementById('step-counter');
  if (stepCounter) stepCounter.textContent = 'T = 0';
  updateHeaderState();
  drawWaterfall();
  updateMetricCards();
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
        // High-contrast tactical green phosphor glow
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
  const seqIdx = 0;
  const qm = metrics[qIdx >= 0 ? qIdx : 0];
  const sm = metrics[seqIdx];

  const cards = [
    { id: 'kpi-pd', value: (qm.pd * 100).toFixed(1) + '%' },
    { id: 'kpi-seq-pd', value: (sm.pd * 100).toFixed(1) + '%' },
    { id: 'kpi-reward', value: qm.cumulativeReward.toFixed(1) },
    { id: 'kpi-intercept-rate', value: (qm.avgInterceptRate * 100).toFixed(1) + '%' },
    { id: 'kpi-intercept-time', value: qm.avgInterceptTimeError.toFixed(2) + ' steps' },
    { id: 'kpi-steps', value: stepCount.toLocaleString() },
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
  if (stepCount % CHART_SUBSAMPLE !== 0) return;
  const label = stepCount.toString();

  // Pd chart
  pdChart.data.labels.push(label);
  strategies.forEach((s, i) => pdChart.data.datasets[i].data.push((metrics[i].pd * 100).toFixed(2)));
  if (pdChart.data.labels.length > 150) {
    pdChart.data.labels.shift();
    pdChart.data.datasets.forEach(d => d.data.shift());
  }
  pdChart.update('none');

  // Reward chart
  rewardChart.data.labels.push(label);
  strategies.forEach((s, i) => rewardChart.data.datasets[i].data.push(metrics[i].cumulativeReward.toFixed(2)));
  if (rewardChart.data.labels.length > 150) {
    rewardChart.data.labels.shift();
    rewardChart.data.datasets.forEach(d => d.data.shift());
  }
  rewardChart.update('none');

  // Intercept rate chart
  interceptRateChart.data.labels.push(label);
  strategies.forEach((s, i) => interceptRateChart.data.datasets[i].data.push((metrics[i].avgInterceptRate * 100).toFixed(2)));
  if (interceptRateChart.data.labels.length > 150) {
    interceptRateChart.data.labels.shift();
    interceptRateChart.data.datasets.forEach(d => d.data.shift());
  }
  interceptRateChart.update('none');

  // Band density
  const density = env.getBandDensity();
  bandDensityChart.data.datasets[0].data = density.map(d => (d * 100).toFixed(1));
  bandDensityChart.data.datasets[0].backgroundColor = density.map(d => {
    const v = Math.min(d * 3, 1);
    return `rgba(59, 130, 246, ${0.3 + v * 0.6})`;
  });
  bandDensityChart.update('none');
}

function updateCompareChart() {
  if (compareChart) compareChart.destroy();
  const ctx = document.getElementById('chart-compare');
  if (!ctx) return;

  const labels = ['Pd (%)', 'AIR (%)', 'Efficiency (%)', 'Low Latency Score'];
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
          (100 - metrics[i].missRate * 100).toFixed(1),
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
          pointLabels: { color: '#cbd5e1', font: { family: 'Plus Jakarta Sans', size: 11, weight: 600 } },
        },
      },
    },
  });
}

// ─── Q-Table Visualization ────────────────────────────────────────────────────
function renderQTable() {
  const qIdx = strategies.findIndex(s => s.name.includes('Q-Learning'));
  if (qIdx < 0) return;
  const agent = strategies[qIdx].getAgent();
  const qTable = agent.getQTableFlat();
  const container = document.getElementById('qtable-container');
  if (!container) return;

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

  // Epsilon display
  const epEl = document.getElementById('epsilon-display');
  if (epEl) epEl.textContent = (agent.epsilon * 100).toFixed(1) + '%';
  const ucbIdx = strategies.findIndex(s => s.name.includes('UCB'));
  const ucbAgent = strategies[ucbIdx]?.getAgent();
  if (ucbAgent) {
    const countsEl = document.getElementById('ucb-counts');
    if (countsEl) {
      const maxCount = Math.max(...ucbAgent.counts, 1);
      countsEl.innerHTML = ucbAgent.counts.map((c, i) =>
        `<div class="ucb-bar"><span style="width:36px">CH${i}</span><div class="ucb-fill" style="width:${Math.min((c / maxCount) * 100, 100)}%;background:${strategies[ucbIdx].color}"></div><span style="width:28px;text-align:right">${c}</span></div>`
      ).join('');
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
    agile: { bg: 'rgba(245, 158, 11, 0.15)', color: '#fbbf24', label: 'AGILE HOPPER' },
    intermittent: { bg: 'rgba(139, 92, 246, 0.15)', color: '#c084fc', label: 'INTERMITTENT' },
    burst: { bg: 'rgba(239, 68, 68, 0.15)', color: '#f87171', label: 'BURST EMITTER' },
  };

  tbody.innerHTML = env.getEmitterSummary().map(e => {
    const meta = typeMap[e.type] || { bg: 'rgba(148,163,184,0.1)', color: '#cbd5e1', label: e.type.toUpperCase() };
    return `<tr>
      <td style="font-weight:600;color:var(--text-muted)">#${e.id}</td>
      <td><span class="badge" style="background:${meta.bg};color:${meta.color};border:1px solid ${meta.color}40">${meta.label}</span></td>
      <td>CH${e.band.toString().padStart(2, '0')}</td>
      <td>${e.config.period ? e.config.period + ' steps' : e.config.hopInterval ? e.config.hopInterval + ' steps' : '—'}</td>
      <td>${e.config.duty ? (e.config.duty * 100).toFixed(0) + '% (Duty)' : e.config.txProb ? (e.config.txProb * 100).toFixed(0) + '% (Prob)' : '—'}</td>
      <td><span class="status-dot ${e.active ? 'active' : ''}"></span><span style="color:${e.active ? 'var(--accent-green)' : 'var(--text-dim)'};font-weight:600">${e.active ? 'TRANSMITTING' : 'QUIET'}</span></td>
    </tr>`;
  }).join('');
}

// ─── Analysis Tab ─────────────────────────────────────────────────────────────
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
      <td>${m.hits}</td>
      <td>${m.misses}</td>
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
      <td>${m.hits}</td>
      <td>${m.misses}</td>
      <td>${m.cumulativeReward.toFixed(1)}</td>
    </tr>`;
  }).join('');
}

// Interval updates
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

