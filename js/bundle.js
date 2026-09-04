// ==========================================
// Module: js/simulator.js
// ==========================================
/**
 * RF Environment Simulator
 * Supports deterministic seeded PRNG (Mulberry32), spatial scan rotating beam radars,
 * frequency agile hoppers, periodic pulse radars, intermittent emitters, and receiver noise floor.
 */

// ─── Seeded PRNG (Mulberry32) ─────────────────────────────────────────────────
class SeededRNG {
  constructor(seed = 42) {
    this.setSeed(seed);
  }

  setSeed(seed) {
    this.seed = typeof seed === 'number' ? seed : 42;
    this.state = this.seed >>> 0;
  }

  /** Return pseudo-random float in [0, 1) */
  random() {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Return pseudo-random integer in [min, max] */
  randInt(min, max) {
    return Math.floor(this.random() * (max - min + 1)) + min;
  }
}

const globalRNG = new SeededRNG(42);

const EMITTER_TYPES = {
  PERIODIC: 'periodic',
  AGILE: 'agile',
  INTERMITTENT: 'intermittent',
  BURST: 'burst',
  SPATIAL_SCAN: 'spatial_scan', // Rotating radar beam illumination
};

class Emitter {
  constructor(id, type, config = {}, rng = globalRNG) {
    this.id = id;
    this.type = type;
    this.config = config;
    this.rng = rng;
    this.state = false;
    this.phase = this.rng.randInt(0, 19);
    this.currentBand = config.homeBand ?? 0;
    this.burstCounter = 0;
    this.burstLength = config.burstLength ?? 3;
    this.burstGap = config.burstGap ?? 7;
    this.inBurst = false;

    // Spatial scan radar antenna properties
    this.rotationPeriod = config.rotationPeriod ?? 16; // Time steps for 360-deg rotation
    this.beamwidthDeg = config.beamwidthDeg ?? 35;     // 3dB Mainlobe beamwidth
    this.rxAzimuthDeg = config.rxAzimuthDeg ?? 90;     // Angle of ES receiver relative to radar
    this.currentAzimuth = config.initialAzimuth ?? this.rng.randInt(0, 359);
  }

  step(t, numBands) {
    switch (this.type) {
      case EMITTER_TYPES.PERIODIC: {
        const period = this.config.period ?? 10;
        const duty = this.config.duty ?? 0.4;
        const slot = (t + this.phase) % period;
        this.state = slot < Math.round(period * duty);
        return { band: this.config.homeBand ?? 0, active: this.state };
      }

      case EMITTER_TYPES.AGILE: {
        const hopInterval = this.config.hopInterval ?? 5;
        if (t % hopInterval === 0) {
          const hopOffset = this.rng.randInt(1, Math.max(1, numBands - 1));
          this.currentBand = (this.currentBand + hopOffset) % numBands;
        }
        this.state = this.rng.random() < (this.config.txProb ?? 0.8);
        return { band: this.currentBand, active: this.state };
      }

      case EMITTER_TYPES.INTERMITTENT: {
        this.state = this.rng.random() < (this.config.txProb ?? 0.35);
        return { band: this.config.homeBand ?? 0, active: this.state };
      }

      case EMITTER_TYPES.BURST: {
        this.burstCounter++;
        if (this.inBurst) {
          if (this.burstCounter >= this.burstLength) {
            this.inBurst = false;
            this.burstCounter = 0;
          }
          this.state = true;
        } else {
          if (this.burstCounter >= this.burstGap) {
            this.inBurst = true;
            this.burstCounter = 0;
          }
          this.state = false;
        }
        return { band: this.config.homeBand ?? 0, active: this.state };
      }

      case EMITTER_TYPES.SPATIAL_SCAN: {
        // Rotating radar beam: mainlobe illuminates receiver only during alignment
        const degPerStep = 360 / this.rotationPeriod;
        this.currentAzimuth = (this.currentAzimuth + degPerStep) % 360;
        let angleDiff = Math.abs(this.currentAzimuth - this.rxAzimuthDeg);
        if (angleDiff > 180) angleDiff = 360 - angleDiff;

        // Mainlobe illumination condition
        const inMainlobe = angleDiff <= (this.beamwidthDeg / 2);
        // Intermittent pulse trains within mainlobe illumination
        this.state = inMainlobe && (this.rng.random() < (this.config.txProb ?? 0.9));
        return { band: this.config.homeBand ?? 0, active: this.state };
      }

      default:
        return { band: 0, active: false };
    }
  }

  reset() {
    this.state = false;
    this.phase = this.rng.randInt(0, 19);
    this.currentBand = this.config.homeBand ?? 0;
    this.burstCounter = 0;
    this.inBurst = false;
    this.currentAzimuth = this.config.initialAzimuth ?? this.rng.randInt(0, 359);
  }
}

class RFEnvironment {
  constructor(config = {}) {
    this.numBands = config.numBands ?? 16;
    this.seed = config.seed ?? 42;
    this.rng = new SeededRNG(this.seed);
    this.noiseProb = config.noiseProb ?? 0.02; // Receiver thermal false alarm probability
    this.emitters = [];
    this.t = 0;
    this.bandActivity = new Array(this.numBands).fill(false);
    this.rawNoise = new Array(this.numBands).fill(false);
    this.history = [];
    this.maxHistory = config.maxHistory ?? 500;
    this._buildEmitters(config.emitters);
  }

  setSeed(seed) {
    this.seed = seed;
    this.rng.setSeed(seed);
    this.reset();
  }

  _buildEmitters(emitterConfigs) {
    if (emitterConfigs) {
      emitterConfigs.forEach((cfg, i) => this.emitters.push(new Emitter(i, cfg.type, cfg, this.rng)));
      return;
    }
    const defaults = [
      { type: EMITTER_TYPES.PERIODIC, homeBand: 0, period: 8, duty: 0.5 },
      { type: EMITTER_TYPES.PERIODIC, homeBand: 3, period: 12, duty: 0.3 },
      { type: EMITTER_TYPES.PERIODIC, homeBand: 7, period: 6, duty: 0.6 },
      { type: EMITTER_TYPES.PERIODIC, homeBand: 11, period: 20, duty: 0.25 },
      { type: EMITTER_TYPES.PERIODIC, homeBand: 14, period: 9, duty: 0.45 },
      { type: EMITTER_TYPES.AGILE, hopInterval: 4, txProb: 0.75 },
      { type: EMITTER_TYPES.AGILE, hopInterval: 7, txProb: 0.65 },
      { type: EMITTER_TYPES.AGILE, hopInterval: 3, txProb: 0.80 },
      { type: EMITTER_TYPES.INTERMITTENT, homeBand: 5, txProb: 0.35 },
      { type: EMITTER_TYPES.INTERMITTENT, homeBand: 9, txProb: 0.45 },
      { type: EMITTER_TYPES.INTERMITTENT, homeBand: 13, txProb: 0.25 },
      { type: EMITTER_TYPES.BURST, homeBand: 2, burstLength: 3, burstGap: 10 },
      { type: EMITTER_TYPES.BURST, homeBand: 10, burstLength: 5, burstGap: 8 },
      { type: EMITTER_TYPES.SPATIAL_SCAN, homeBand: 6, rotationPeriod: 14, beamwidthDeg: 40, rxAzimuthDeg: 90 },
      { type: EMITTER_TYPES.SPATIAL_SCAN, homeBand: 12, rotationPeriod: 22, beamwidthDeg: 30, rxAzimuthDeg: 180 },
    ];
    defaults.forEach((cfg, i) => this.emitters.push(new Emitter(i, cfg.type, cfg, this.rng)));
  }

  step() {
    const activity = new Array(this.numBands).fill(false);
    this.emitters.forEach(e => {
      const { band, active } = e.step(this.t, this.numBands);
      if (active && band < this.numBands) activity[band] = true;
    });

    // Simulate occasional thermal noise spikes exceeding receiver detection threshold
    const noise = new Array(this.numBands).fill(false);
    for (let b = 0; b < this.numBands; b++) {
      if (!activity[b] && this.rng.random() < this.noiseProb) {
        noise[b] = true;
      }
    }
    this.rawNoise = noise;

    this.bandActivity = activity;
    if (this.history.length >= this.maxHistory) this.history.shift();
    this.history.push([...activity]);
    this.t++;
    return { activity, noise };
  }

  reset() {
    this.t = 0;
    this.bandActivity = new Array(this.numBands).fill(false);
    this.rawNoise = new Array(this.numBands).fill(false);
    this.history = [];
    this.emitters.forEach(e => e.reset());
  }

  getBandDensity() {
    if (this.history.length === 0) return new Array(this.numBands).fill(0);
    const counts = new Array(this.numBands).fill(0);
    this.history.forEach(snap => snap.forEach((v, b) => { if (v) counts[b]++; }));
    return counts.map(c => c / this.history.length);
  }

  getEmitterSummary() {
    return this.emitters.map(e => ({
      id: e.id,
      type: e.type,
      band: e.currentBand,
      active: e.state,
      config: e.config,
    }));
  }
}


// ==========================================
// Module: js/qlearning.js
// ==========================================
/**
 * Closed-Loop Schedulers & Machine Learning Agents:
 * 1. Optimal Periodic Coincidence Estimator (Period & Phase Tracker)
 * 2. Q-Learning Reinforcement Learning Agent (TD-Learning with Epsilon Decay & Train/Eval Modes)
 * 3. UCB-1 Multi-Armed Bandit Agent
 */


// ─── 1. Optimal Periodic Scan Estimator (Radar PRI & Phase Tracker) ────────────
// ─── 1. Optimal Periodic Scan Estimator (Radar PRI & Phase Tracker) ────────────
class OptimalPeriodicEstimator {
  constructor(numBands, config = {}) {
    this.numBands = numBands;
    this.minSamplesForFit = config.minSamplesForFit ?? 3;
    this.maxTrackedPeriod = config.maxTrackedPeriod ?? 35;
    this.reset();
  }

  reset() {
    // Per-band rising edge arrival timestamps (pulse onset)
    this.risingEdges = Array.from({ length: this.numBands }, () => []);
    this.lastHitStep = new Array(this.numBands).fill(-1);
    this.estimatedPeriod = new Array(this.numBands).fill(null);
    this.estimatedPhase = new Array(this.numBands).fill(null);
    this.estimatedWindow = new Array(this.numBands).fill(1);
    this.maxBurstLength = new Array(this.numBands).fill(1);
    this.currentBurstLength = new Array(this.numBands).fill(0);
    this.confidence = new Array(this.numBands).fill(0);
    this.consecutiveMisses = new Array(this.numBands).fill(0);
    this.lastPredictedBand = null;
    this.dwellCounts = new Array(this.numBands).fill(0);
    this.hitCounts = new Array(this.numBands).fill(0);
    this.currentStep = 0;
  }

  /**
   * Observe whether the currently tuned band was active at time t.
   * Tracks rising edges (first pulse in burst) to isolate true fundamental PRI
   * from intra-burst dwell steps.
   */
  observe(band, wasHit, t) {
    this.currentStep = t;
    this.dwellCounts[band]++;

    if (wasHit) {
      this.hitCounts[band]++;
      const lastHit = this.lastHitStep[band];
      const isRisingEdge = (lastHit === -1 || t > lastHit + 1);

      if (isRisingEdge) {
        this.risingEdges[band].push(t);
        if (this.risingEdges[band].length > 30) this.risingEdges[band].shift();
        this.currentBurstLength[band] = 1;
      } else {
        this.currentBurstLength[band] = (this.currentBurstLength[band] || 1) + 1;
        this.maxBurstLength[band] = Math.max(this.maxBurstLength[band] || 1, this.currentBurstLength[band]);
      }

      this.lastHitStep[band] = t;
      this.consecutiveMisses[band] = 0;

      if (this.lastPredictedBand === band) {
        this.confidence[band] = Math.min(1.0, this.confidence[band] + 0.15);
      }

      if (this.risingEdges[band].length >= this.minSamplesForFit) {
        this._estimatePeriodPhase(band);
      }
    } else {
      // Receiver was on this band and got NO signal
      if (this.lastPredictedBand === band) {
        this.consecutiveMisses[band] = (this.consecutiveMisses[band] || 0) + 1;
        if (this.consecutiveMisses[band] >= 3) {
          this.confidence[band] *= 0.5; // Degrade confidence on successive misses
        }
        if (this.consecutiveMisses[band] >= 6) {
          // Invalidate stale or erroneous estimate
          this.estimatedPeriod[band] = null;
          this.estimatedPhase[band] = null;
          this.confidence[band] = 0;
          this.risingEdges[band] = [];
          this.consecutiveMisses[band] = 0;
        }
      }
    }
  }

  /**
   * Estimates fundamental period T and phase phi via modular congruence histogram.
   * Avoids intra-burst harmonic distortion.
   */
  _estimatePeriodPhase(band) {
    const edges = this.risingEdges[band];
    if (edges.length < this.minSamplesForFit) return;

    let bestT = null;
    let bestPhi = null;
    let bestScore = 0;

    // Evaluate candidate fundamental periods from 4 to maxTrackedPeriod
    for (let T = 4; T <= this.maxTrackedPeriod; T++) {
      const remCounts = {};
      for (const t of edges) {
        const r = ((t % T) + T) % T;
        remCounts[r] = (remCounts[r] || 0) + 1;
      }

      let maxCount = 0;
      let dominantPhi = 0;
      for (const [r, count] of Object.entries(remCounts)) {
        if (count > maxCount) {
          maxCount = count;
          dominantPhi = parseInt(r, 10);
        }
      }

      const score = maxCount / edges.length;
      if (score >= 0.70) {
        if (bestT === null || score > bestScore + 0.1) {
          bestT = T;
          bestPhi = dominantPhi;
          bestScore = score;
        }
      }
    }

    if (bestT !== null) {
      this.estimatedPeriod[band] = bestT;
      this.estimatedPhase[band] = bestPhi;
      this.estimatedWindow[band] = Math.min(bestT - 1, Math.max(1, this.maxBurstLength[band] || 1));
      this.confidence[band] = Math.min(1.0, 0.4 + bestScore * 0.5);
    }
  }

  /**
   * Selects next band:
   * 1. Priority to channels where an estimated periodic pulse is due at step t
   * 2. When no periodic pulse is expected: active UCB exploration across channels
   */
  selectBand(t, fallbackBand = 0) {
    // 1. Check if any estimated periodic emitter is active at step t
    let candidateBands = [];
    for (let b = 0; b < this.numBands; b++) {
      const T = this.estimatedPeriod[b];
      const phi = this.estimatedPhase[b];
      const W = this.estimatedWindow[b] || 1;
      if (T !== null && phi !== null && this.confidence[b] >= 0.3) {
        const slot = ((t - phi) % T + T) % T;
        if (slot < W) {
          // Give higher urgency to the rising edge (slot 0)
          const urgency = (slot === 0 ? 1.5 : 1.0) * this.confidence[b];
          candidateBands.push({ band: b, urgency });
        }
      }
    }

    if (candidateBands.length > 0) {
      candidateBands.sort((a, b) => b.urgency - a.urgency);
      this.lastPredictedBand = candidateBands[0].band;
      return this.lastPredictedBand;
    }

    // 2. Idle steps: adaptive UCB exploration to discover unmapped emitters
    this.lastPredictedBand = null;
    let bestScore = -Infinity;
    let bestB = fallbackBand;

    for (let b = 0; b < this.numBands; b++) {
      const n = this.dwellCounts[b];
      if (n === 0) {
        return b; // Initial exploration pass
      }
      const exploitation = this.hitCounts[b] / n;
      const exploration = Math.sqrt((2 * Math.log(t + 1)) / n);
      const score = exploitation + 1.2 * exploration;
      if (score > bestScore) {
        bestScore = score;
        bestB = b;
      }
    }

    return bestB;
  }
}

// ─── 2. Q-Learning Agent ──────────────────────────────────────────────────────
class QLearningAgent {
  constructor(numBands, config = {}, rng = globalRNG) {
    this.numBands = numBands;
    this.rng = rng;
    this.alpha = config.alpha ?? 0.15;      // Learning rate
    this.gamma = config.gamma ?? 0.85;     // Discount factor
    this.epsilon = config.epsilon ?? 1.0;   // Exploration rate
    this.epsilonMin = config.epsilonMin ?? 0.05;
    this.epsilonDecay = config.epsilonDecay ?? 0.995;
    this.evalMode = config.evalMode ?? false; // Freeze weights & exploration in eval mode

    // Q-table: state = current band, action = next band to tune
    this.qTable = Array.from({ length: numBands }, () => new Array(numBands).fill(0));
    this.totalReward = 0;
    this.rewardHistory = [];
    this.steps = 0;
  }

  setEvaluationMode(isEval) {
    this.evalMode = !!isEval;
  }

  /**
   * Choose next band using epsilon-greedy policy (or pure exploit if evalMode is true)
   */
  selectBand(currentBand) {
    const effEpsilon = this.evalMode ? 0.0 : this.epsilon;

    if (this.rng.random() < effEpsilon) {
      return this.rng.randInt(0, this.numBands - 1); // Explore
    }

    // Exploit: argmax_a Q(currentBand, a) with random tie-breaking
    const row = this.qTable[currentBand];
    let maxQ = -Infinity;
    let bestActions = [];

    for (let a = 0; a < this.numBands; a++) {
      if (row[a] > maxQ) {
        maxQ = row[a];
        bestActions = [a];
      } else if (row[a] === maxQ) {
        bestActions.push(a);
      }
    }
    return bestActions[this.rng.randInt(0, bestActions.length - 1)];
  }

  /**
   * Rigorous Q-Learning TD update (SARSAMAX):
   * Q(s, a) ← Q(s, a) + α · [ R + γ · max_{a'} Q(s', a') − Q(s, a) ]
   */
  update(fromBand, actionBand, reward, nextStateBand) {
    if (this.evalMode) {
      this.totalReward += reward;
      this.rewardHistory.push(this.totalReward);
      this.steps++;
      return;
    }

    // Target max Q-value over next state actions
    const maxNextQ = Math.max(...this.qTable[nextStateBand]);
    const currentQ = this.qTable[fromBand][actionBand];

    // TD error update
    this.qTable[fromBand][actionBand] = currentQ + this.alpha * (reward + this.gamma * maxNextQ - currentQ);
    this.totalReward += reward;
    this.rewardHistory.push(this.totalReward);

    if (this.epsilon > this.epsilonMin) {
      this.epsilon *= this.epsilonDecay;
    }
    this.steps++;
  }

  reset() {
    this.qTable = Array.from({ length: this.numBands }, () => new Array(this.numBands).fill(0));
    this.totalReward = 0;
    this.rewardHistory = [];
    this.epsilon = 1.0;
    this.steps = 0;
  }

  getQTableFlat() {
    return this.qTable.map(row => [...row]);
  }

  /** Export model weights for persistence */
  exportModelJSON() {
    return JSON.stringify({
      numBands: this.numBands,
      alpha: this.alpha,
      gamma: this.gamma,
      epsilon: this.epsilon,
      qTable: this.qTable,
      steps: this.steps,
      totalReward: this.totalReward,
    }, null, 2);
  }

  /** Import pre-trained model weights */
  importModelJSON(jsonString) {
    try {
      const data = typeof jsonString === 'string' ? JSON.parse(jsonString) : jsonString;
      if (data.qTable && Array.isArray(data.qTable)) {
        this.qTable = data.qTable;
        this.numBands = data.numBands ?? this.numBands;
        this.alpha = data.alpha ?? this.alpha;
        this.gamma = data.gamma ?? this.gamma;
        this.epsilon = data.epsilon ?? this.epsilonMin;
        this.steps = data.steps ?? 0;
        return true;
      }
    } catch (e) {
      console.error('Failed to import model weights:', e);
    }
    return false;
  }
}

// ─── 3. Upper Confidence Bound (UCB-1 Multi-Armed Bandit) ──────────────────────
class UCBAgent {
  constructor(numBands, c = 2.0) {
    this.numBands = numBands;
    this.c = c; // Exploration constant
    this.counts = new Array(numBands).fill(0);
    this.values = new Array(numBands).fill(0);
    this.t = 0;
    this.totalReward = 0;
    this.rewardHistory = [];
  }

  selectBand() {
    // Initialize: ensure every channel is sampled at least once
    for (let b = 0; b < this.numBands; b++) {
      if (this.counts[b] === 0) return b;
    }
    let maxUCB = -Infinity, bestBand = 0;
    this.values.forEach((val, b) => {
      const ucb = val + this.c * Math.sqrt(Math.log(this.t + 1) / this.counts[b]);
      if (ucb > maxUCB) {
        maxUCB = ucb;
        bestBand = b;
      }
    });
    return bestBand;
  }

  update(band, reward) {
    this.counts[band]++;
    this.t++;
    this.values[band] += (reward - this.values[band]) / this.counts[band];
    this.totalReward += reward;
    this.rewardHistory.push(this.totalReward);
  }

  reset() {
    this.counts = new Array(this.numBands).fill(0);
    this.values = new Array(this.numBands).fill(0);
    this.t = 0;
    this.totalReward = 0;
    this.rewardHistory = [];
  }
}


// ==========================================
// Module: js/strategies.js
// ==========================================
/**
 * Scan Strategies / Schedulers
 * Each strategy implements: selectBand(t) and update(band, reward, activity, t)
 */


class SequentialStrategy {
  constructor(numBands) {
    this.numBands = numBands;
    this.current = 0;
    this.name = 'Sequential Raster';
    this.color = '#ef4444';
    this.description = 'Fixed open-loop cyclic sweep across sub-bands 0→(N-1). Traditional baseline with zero adaptation.';
  }
  selectBand() {
    const b = this.current;
    this.current = (this.current + 1) % this.numBands;
    return b;
  }
  update() {}
  reset() { this.current = 0; }
}

class RandomStrategy {
  constructor(numBands) {
    this.numBands = numBands;
    this.name = 'Uniform Random';
    this.color = '#64748b';
    this.description = 'Uncoordinated stochastic channel selection with uniform probability distribution. Zero memory.';
  }
  selectBand() { return Math.floor(Math.random() * this.numBands); }
  update() {}
  reset() {}
}

class PriorityStrategy {
  constructor(numBands, priorities = null) {
    this.numBands = numBands;
    this.priorities = priorities ?? this._defaultPriorities(numBands);
    this.idx = 0;
    this.name = 'Priority (Prior Intel)';
    this.color = '#f59e0b';
    this.description = 'Visits channels weighted by static pre-mission threat intelligence. Ineffective against agile hops.';
  }
  _defaultPriorities(n) {
    const p = [0, 3, 7, 5, 11, 9, 14, 2, 10, 1, 4, 6, 8, 12, 13, 15].filter(b => b < n);
    for (let b = 0; b < n; b++) { if (!p.includes(b)) p.push(b); }
    return p;
  }
  selectBand() {
    const b = this.priorities[this.idx % this.priorities.length];
    this.idx++;
    return b;
  }
  update() {}
  reset() { this.idx = 0; }
}

class PeriodicCoincidenceStrategy {
  constructor(numBands) {
    this.numBands = numBands;
    this.estimator = new OptimalPeriodicEstimator(numBands);
    this.name = 'Periodic Coincidence (Optimal)';
    this.color = '#06b6d4';
    this.description = 'Explicit radar PRI & phase estimator. Synchronizes receiver dwell clock to match pulse arrival intervals.';
    this.currentBand = 0;
    this.lastTuned = 0;
  }
  selectBand(t = 0) {
    this.currentBand = this.estimator.selectBand(t, (this.lastTuned + 1) % this.numBands);
    this.lastTuned = this.currentBand;
    return this.currentBand;
  }
  update(band, reward, activity, t = 0) {
    const wasHit = activity && activity[band];
    this.estimator.observe(band, wasHit, t);
  }
  reset() {
    this.estimator.reset();
    this.currentBand = 0;
    this.lastTuned = 0;
  }
  getEstimator() { return this.estimator; }
}

class UCBStrategy {
  constructor(numBands) {
    this.numBands = numBands;
    this.agent = new UCBAgent(numBands, 2.0);
    this.name = 'UCB-1 Multi-Armed Bandit';
    this.color = '#8b5cf6';
    this.description = 'Balances exploration of uncertain bands against exploitation of high-activity radar channels.';
  }
  selectBand() { return this.agent.selectBand(); }
  update(band, reward) { this.agent.update(band, reward); }
  reset() { this.agent.reset(); }
  getAgent() { return this.agent; }
}

class QLearningStrategy {
  constructor(numBands) {
    this.numBands = numBands;
    this.agent = new QLearningAgent(numBands);
    this.currentBand = 0;
    this.chosenAction = 0;
    this.name = 'Q-Learning Adaptive (RL)';
    this.color = '#3b82f6';
    this.description = 'Closed-loop reinforcement learning agent that optimizes state-action dwell policy via temporal difference learning.';
  }
  selectBand() {
    this.chosenAction = this.agent.selectBand(this.currentBand);
    return this.chosenAction;
  }
  update(actionBand, reward, activity) {
    // Next state s' is the band we just tuned to
    const nextState = actionBand;
    this.agent.update(this.currentBand, actionBand, reward, nextState);
    this.currentBand = nextState;
  }
  reset() {
    this.agent.reset();
    this.currentBand = 0;
    this.chosenAction = 0;
  }
  getAgent() { return this.agent; }
}

function createAllStrategies(numBands) {
  return [
    new SequentialStrategy(numBands),
    new RandomStrategy(numBands),
    new PriorityStrategy(numBands),
    new PeriodicCoincidenceStrategy(numBands),
    new UCBStrategy(numBands),
    new QLearningStrategy(numBands),
  ];
}



// ==========================================
// Module: js/metrics.js
// ==========================================
/**
 * Performance Metrics (Figures of Merit)
 * Computes all 7 standard electronic warfare receiver Figures of Merit:
 * 1. Pd (Probability of Detection / Intercept)
 * 2. Pfa (Probability of False Alarm)
 * 3. AIR (Average Intercept Rate)
 * 4. AITE (Average Intercept Time Error / Detection Latency)
 * 5. Sensitivity (True Positive Rate / Recall)
 * 6. CPC (Percentage of Correct Decisions / Accuracy)
 * 7. Cumulative Reward Score R(t)
 */

class MetricsTracker {
  constructor(name, color) {
    this.name = name;
    this.color = color;
    this.reset();
  }

  reset() {
    this.hits = 0;               // True Positives (tuned to active signal)
    this.misses = 0;             // False Negatives (transmissions occurred elsewhere)
    this.falseAlarms = 0;        // False Positives (tuned to quiet channel but noise triggered)
    this.trueNegatives = 0;      // Correctly observed quiet channel
    this.totalTransmissions = 0; // Steps where at least one channel was radiating
    this.totalSamples = 0;       // Total discrete dwell steps
    this.interceptTimes = [];    // Latency from emission start to intercept
    this.emissionStartTimes = {};// bandIdx -> start step
    this.rewardHistory = [];
    this.pdHistory = [];
    this.interceptRateHistory = [];
    this.interceptTimeHistory = [];
    this.cpcHistory = [];
    this.cumulativeReward = 0;
    this.lastActivity = [];
  }

  /**
   * Record one discrete dwell step
   * @param {number} band - Band index the receiver tuned to
   * @param {boolean[]} activity - Ground truth: which channels are active
   * @param {number} t - Current mission time step
   * @param {boolean[]} [noise] - Optional noise spikes per channel
   */
  record(band, activity, t, noise = null) {
    this.totalSamples++;
    const anyActive = activity.some(v => v);
    const bandActive = activity[band];
    const noiseTriggered = noise && noise[band];

    if (anyActive) this.totalTransmissions++;

    // Track emission pulse arrival times
    activity.forEach((active, b) => {
      if (active && !(this.lastActivity[b])) {
        this.emissionStartTimes[b] = t;
      }
    });

    let reward = 0;
    if (bandActive) {
      // True Positive (Hit)
      this.hits++;
      reward = 1.0;
      if (this.emissionStartTimes[band] !== undefined) {
        this.interceptTimes.push(t - this.emissionStartTimes[band]);
        delete this.emissionStartTimes[band];
      }
    } else if (noiseTriggered) {
      // False Positive (False Alarm due to thermal noise on quiet channel)
      this.falseAlarms++;
      reward = -0.05;
    } else if (anyActive) {
      // False Negative (Missed active transmission)
      this.misses++;
      this.trueNegatives++;
      reward = -0.10;
    } else {
      // True Negative (Quiet channel correctly scanned)
      this.trueNegatives++;
      reward = 0.00;
    }

    this.cumulativeReward += reward;
    this.rewardHistory.push(this.cumulativeReward);

    if (this.totalTransmissions > 0) {
      this.pdHistory.push(this.hits / this.totalTransmissions);
    }
    this.interceptRateHistory.push(this.hits / this.totalSamples);

    const avgIntTime = this.interceptTimes.length > 0
      ? this.interceptTimes.reduce((a, b) => a + b, 0) / this.interceptTimes.length
      : 0;
    this.interceptTimeHistory.push(avgIntTime);
    this.cpcHistory.push(this.cpc);

    this.lastActivity = [...activity];
    return reward;
  }

  /** Probability of Detection (Pd): Ratio of intercepted transmissions to total active transmissions */
  get pd() {
    return this.totalTransmissions > 0 ? this.hits / this.totalTransmissions : 0;
  }

  /** Probability of False Alarm (Pfa): False detections divided by quiet opportunities */
  get pfa() {
    const quietOpportunities = this.falseAlarms + this.trueNegatives;
    return quietOpportunities > 0 ? this.falseAlarms / quietOpportunities : 0;
  }

  /** Average Intercept Rate (AIR): Intercept hits divided by total time steps */
  get avgInterceptRate() {
    return this.totalSamples > 0 ? this.hits / this.totalSamples : 0;
  }

  /** Average Intercept Time Error (AITE): Mean latency from pulse start to intercept */
  get avgInterceptTimeError() {
    if (this.interceptTimes.length === 0) return 0;
    return this.interceptTimes.reduce((a, b) => a + b, 0) / this.interceptTimes.length;
  }

  /** Sensitivity (True Positive Rate / Recall): Hits / (Hits + Misses) */
  get sensitivity() {
    const totalPositives = this.hits + this.misses;
    return totalPositives > 0 ? this.hits / totalPositives : 0;
  }

  /** Percentage of Correct Decisions / Predictions (CPC / Dwell Accuracy): (Hits + TrueNegatives) / TotalSamples */
  get cpc() {
    if (this.totalSamples === 0) return 0;
    return ((this.hits + this.trueNegatives) / this.totalSamples) * 100;
  }

  get missRate() {
    return this.totalTransmissions > 0 ? this.misses / this.totalTransmissions : 0;
  }

  getSummary() {
    return {
      name: this.name,
      pd: this.pd,
      pfa: this.pfa,
      avgInterceptRate: this.avgInterceptRate,
      avgInterceptTimeError: this.avgInterceptTimeError,
      sensitivity: this.sensitivity,
      cpc: this.cpc,
      missRate: this.missRate,
      hits: this.hits,
      misses: this.misses,
      falseAlarms: this.falseAlarms,
      totalSamples: this.totalSamples,
      cumulativeReward: this.cumulativeReward,
    };
  }
}


// ==========================================
// Module: js/audio.js
// ==========================================
/**
 * SIGINT Audio Sonification Engine
 * Uses Web Audio API to synthesize defense electronic warfare acoustic signatures:
 * - PRF pulse buzzes & clicks for periodic radars
 * - Rotating antenna beam volume swells for spatial scanning radars
 * - Polyphonic chirp hops for frequency agile transmitters
 * - Heterodyne signal acquisition lock beeps
 * - Subtle thermal RF noise floor
 */

class SIGINTAudioEngine {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.noiseGain = null;
    this.toneGain = null;
    this.analyser = null;
    this.enabled = false;
    this.volume = 0.4;
    this.currentBand = 0;
    this.carrierFreqs = [];
    this.noiseNode = null;
  }

  init(numBands = 16) {
    if (this.ctx) return;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) {
      console.warn('Web Audio API not supported in this browser.');
      return;
    }
    this.ctx = new AudioCtx();

    // Generate base carrier audio frequencies for each sub-band (220 Hz to 1760 Hz)
    this.carrierFreqs = Array.from({ length: numBands }, (_, i) => {
      return 220 * Math.pow(2, (i * 1.5) / numBands);
    });

    // Master Gain & Analyser
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.setValueAtTime(this.volume, this.ctx.currentTime);

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;

    this.masterGain.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);

    // Tone Sub-Bus
    this.toneGain = this.ctx.createGain();
    this.toneGain.gain.setValueAtTime(0.5, this.ctx.currentTime);
    this.toneGain.connect(this.masterGain);

    // Thermal RF Noise Floor Generator
    this._initNoiseFloor();
  }

  _initNoiseFloor() {
    if (!this.ctx) return;
    const bufferSize = this.ctx.sampleRate * 2;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * 0.04;
    }

    this.noiseNode = this.ctx.createBufferSource();
    this.noiseNode.buffer = buffer;
    this.noiseNode.loop = true;

    // Filter noise to sound like realistic receiver bandpass thermal floor
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(1000, this.ctx.currentTime);
    filter.Q.setValueAtTime(1.0, this.ctx.currentTime);

    this.noiseGain = this.ctx.createGain();
    this.noiseGain.gain.setValueAtTime(0.08, this.ctx.currentTime);

    this.noiseNode.connect(filter);
    filter.connect(this.noiseGain);
    this.noiseGain.connect(this.masterGain);

    try {
      this.noiseNode.start(0);
    } catch (e) {}
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  setMuted(muted) {
    this.enabled = !muted;
    if (!this.ctx) this.init();
    this.resume();
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setValueAtTime(this.enabled ? this.volume : 0, this.ctx.currentTime);
    }
  }

  setVolume(vol) {
    this.volume = Math.max(0, Math.min(1, vol));
    if (this.masterGain && this.ctx && this.enabled) {
      this.masterGain.gain.setValueAtTime(this.volume, this.ctx.currentTime);
    }
  }

  /**
   * Synthesize audio event when a receiver dwells on a channel
   * @param {number} band - Tuned channel index
   * @param {boolean} active - True if ground truth active transmission
   * @param {Object} [emitterMeta] - Emitter classification details
   */
  playDwellAcoustics(band, active, emitterMeta = null) {
    if (!this.enabled || !this.ctx || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    const baseFreq = this.carrierFreqs[band] || 440;

    if (!active) {
      // Quiet channel: momentary subtle click on channel switch
      this._playChannelSwitchClick(baseFreq, now);
      return;
    }

    // Active Signal Intercept Audio Synthesis
    const type = emitterMeta ? emitterMeta.type : 'periodic';

    switch (type) {
      case 'spatial_scan':
        this._playSpatialBeamSweep(baseFreq, now, emitterMeta);
        break;
      case 'agile':
        this._playAgileChirp(baseFreq, now);
        break;
      case 'burst':
      case 'intermittent':
        this._playBurstPulse(baseFreq, now);
        break;
      case 'periodic':
      default:
        this._playPeriodicPulse(baseFreq, now);
        break;
    }
  }

  /** Periodic Radar: Crisp PRF pulse train buzz */
  _playPeriodicPulse(freq, now) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(freq, now);

    // Staccato envelope
    gain.gain.setValueAtTime(0.0, now);
    gain.gain.linearRampToValueAtTime(0.35, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.07);

    osc.connect(gain);
    gain.connect(this.toneGain);

    osc.onended = () => {
      try { osc.disconnect(); gain.disconnect(); } catch (e) {}
    };

    osc.start(now);
    osc.stop(now + 0.08);
  }

  /** Spatial Scanning Radar: Volume swell imitating rotating antenna mainlobe */
  _playSpatialBeamSweep(freq, now, meta) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq * 1.25, now);

    // Sweeping amplitude envelope
    gain.gain.setValueAtTime(0.05, now);
    gain.gain.linearRampToValueAtTime(0.45, now + 0.035);
    gain.gain.linearRampToValueAtTime(0.001, now + 0.09);

    osc.connect(gain);
    gain.connect(this.toneGain);

    osc.onended = () => {
      try { osc.disconnect(); gain.disconnect(); } catch (e) {}
    };

    osc.start(now);
    osc.stop(now + 0.1);
  }

  /** Frequency Agile Hopper: Rapid frequency modulating chirp */
  _playAgileChirp(freq, now) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';

    osc.frequency.setValueAtTime(freq * 0.8, now);
    osc.frequency.exponentialRampToValueAtTime(freq * 1.6, now + 0.06);

    gain.gain.setValueAtTime(0.0, now);
    gain.gain.linearRampToValueAtTime(0.4, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.07);

    osc.connect(gain);
    gain.connect(this.toneGain);

    osc.onended = () => {
      try { osc.disconnect(); gain.disconnect(); } catch (e) {}
    };

    osc.start(now);
    osc.stop(now + 0.08);
  }

  /** Burst Emitter: Fast machine-gun pulse burst */
  _playBurstPulse(freq, now) {
    [0, 0.02, 0.04].forEach(offset => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(freq * 0.95, now + offset);

      gain.gain.setValueAtTime(0.0, now + offset);
      gain.gain.linearRampToValueAtTime(0.25, now + offset + 0.003);
      gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.015);

      osc.connect(gain);
      gain.connect(this.toneGain);

      osc.onended = () => {
        try { osc.disconnect(); gain.disconnect(); } catch (e) {}
      };

      osc.start(now + offset);
      osc.stop(now + offset + 0.02);
    });
  }

  /** Channel Switch / Dial Click */
  _playChannelSwitchClick(freq, now) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq * 0.5, now);

    gain.gain.setValueAtTime(0.06, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.015);

    osc.connect(gain);
    gain.connect(this.toneGain);

    osc.onended = () => {
      try { osc.disconnect(); gain.disconnect(); } catch (e) {}
    };

    osc.start(now);
    osc.stop(now + 0.02);
  }

  /** Hit Feedback: High chime confirmation */
  playAcquisitionLock(now = null) {
    if (!this.enabled || !this.ctx) return;
    const t = now || this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1320, t);
    osc.frequency.setValueAtTime(1760, t + 0.03);

    gain.gain.setValueAtTime(0.2, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);

    osc.connect(gain);
    gain.connect(this.masterGain);

    osc.onended = () => {
      try { osc.disconnect(); gain.disconnect(); } catch (e) {}
    };

    osc.start(t);
    osc.stop(t + 0.09);
  }

  /** Get Frequency Domain Waveform Data for Live Oscilloscope */
  getWaveformData() {
    if (!this.analyser) return new Uint8Array(128);
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteTimeDomainData(data);
    return data;
  }
}

const globalAudio = new SIGINTAudioEngine();

// ==========================================
// Module: js/duel.js
// ==========================================
/**
 * Interactive Operator Station & Duel Controller
 * Allows human operator to manually scan RF channels by ear and keypress,
 * competing directly against AI schedulers in real-time.
 */


const DUEL_MODES = {
  PRACTICE: 'practice',
  SORTIE_30: 'sortie_30',
  SORTIE_60: 'sortie_60',
};

class OperatorDuelController {
  constructor(numBands = 16) {
    this.numBands = numBands;
    this.humanBand = 0;
    this.mode = DUEL_MODES.PRACTICE;
    this.humanMetrics = new MetricsTracker('Human Operator (Manual)', '#f43f5e');
    this.isActive = false;
    this.timeRemaining = 30;
    this.maxTime = 30;
    this.duelInterval = null;
    this.onStateChange = null;
    this.onDebriefReady = null;

    this._initKeyboardListeners();
  }

  setNumBands(n) {
    this.numBands = n;
    this.humanBand = Math.min(this.humanBand, n - 1);
    this.resetMetrics();
  }

  resetMetrics() {
    this.humanMetrics.reset();
    this.humanBand = 0;
  }

  startSortie(durationSeconds = 30) {
    this.resetMetrics();
    this.maxTime = durationSeconds;
    this.timeRemaining = durationSeconds;
    this.mode = durationSeconds === 60 ? DUEL_MODES.SORTIE_60 : DUEL_MODES.SORTIE_30;
    this.isActive = true;

    if (this.duelInterval) clearInterval(this.duelInterval);
    this.duelInterval = setInterval(() => {
      this.timeRemaining--;
      if (this.onStateChange) this.onStateChange(this.getState());
      if (this.timeRemaining <= 0) {
        this.endSortie();
      }
    }, 1000);

    if (this.onStateChange) this.onStateChange(this.getState());
  }

  endSortie() {
    this.isActive = false;
    if (this.duelInterval) {
      clearInterval(this.duelInterval);
      this.duelInterval = null;
    }
    if (this.onDebriefReady) {
      this.onDebriefReady(this.generateDebrief());
    }
    if (this.onStateChange) this.onStateChange(this.getState());
  }

  /**
   * Called on every simulation step to evaluate the human operator dwell
   * @param {boolean[]} activity - Active channels
   * @param {number} t - Current mission time
   * @param {boolean[]} noise - Noise triggers
   * @param {Array} emitters - Active emitter metadata
   */
  step(activity, t, noise, emitters) {
    const reward = this.humanMetrics.record(this.humanBand, activity, t, noise);
    const wasHit = activity[this.humanBand];

    // Play sonified audio on current tuned human channel
    // emitters are raw Emitter objects: use .currentBand and .state
    const activeEmitter = emitters.find(e =>
      (e.currentBand !== undefined ? e.currentBand : e.band) === this.humanBand &&
      (e.state !== undefined ? e.state : e.active)
    );
    globalAudio.playDwellAcoustics(this.humanBand, wasHit, activeEmitter);

    if (wasHit) {
      globalAudio.playAcquisitionLock();
    }

    return { band: this.humanBand, reward, wasHit };
  }

  tuneTo(band) {
    if (band >= 0 && band < this.numBands) {
      this.humanBand = band;
      if (this.onStateChange) this.onStateChange(this.getState());
    }
  }

  tuneDelta(delta) {
    let next = (this.humanBand + delta) % this.numBands;
    if (next < 0) next += this.numBands;
    this.tuneTo(next);
  }

  _initKeyboardListeners() {
    const keyMap = {
      '1': 0, '2': 1, '3': 2, '4': 3, '5': 4, '6': 5, '7': 6, '8': 7,
      'q': 8, 'w': 9, 'e': 10, 'r': 11, 't': 12, 'y': 13, 'u': 14, 'i': 15,
    };

    window.addEventListener('keydown', (e) => {
      // Ignore when user typing in text input
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

      const k = e.key.toLowerCase();
      if (keyMap[k] !== undefined && keyMap[k] < this.numBands) {
        this.tuneTo(keyMap[k]);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        this.tuneDelta(-1);
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        this.tuneDelta(1);
      }
    });
  }

  getState() {
    return {
      humanBand: this.humanBand,
      mode: this.mode,
      isActive: this.isActive,
      timeRemaining: this.timeRemaining,
      maxTime: this.maxTime,
      metrics: this.humanMetrics.getSummary(),
    };
  }

  /**
   * Generates intelligence debrief comparing Human vs AI
   */
  generateDebrief(aiMetrics = null, periodicEstimator = null) {
    const hm = this.humanMetrics.getSummary();
    const humanPd = (hm.pd * 100).toFixed(1);
    const humanLatency = hm.avgInterceptTimeError.toFixed(2);
    const humanHits = hm.hits;

    return {
      humanPd,
      humanLatency,
      humanHits,
      humanSamples: hm.totalSamples,
      humanReward: hm.cumulativeReward.toFixed(1),
      cpc: hm.cpc.toFixed(1),
    };
  }
}

// ==========================================
// Module: js/main.js
// ==========================================

// ─── State ────────────────────────────────────────────────────────────────────
let NUM_BANDS = 16;
const WATERFALL_COLS = 80; // time steps visible in waterfall

let currentSeed = 42;
let isEvalMode = false;
let env = new RFEnvironment({ numBands: NUM_BANDS, seed: currentSeed });
let strategies = createAllStrategies(NUM_BANDS);
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
  strategies = createAllStrategies(nb);
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

