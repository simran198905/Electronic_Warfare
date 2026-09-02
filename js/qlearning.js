/**
 * Closed-Loop Schedulers & Machine Learning Agents:
 * 1. Optimal Periodic Coincidence Estimator (Period & Phase Tracker)
 * 2. Q-Learning Reinforcement Learning Agent (TD-Learning with Epsilon Decay & Train/Eval Modes)
 * 3. UCB-1 Multi-Armed Bandit Agent
 */

import { globalRNG } from './simulator.js';

// ─── 1. Optimal Periodic Scan Estimator (Radar PRI & Phase Tracker) ────────────
export class OptimalPeriodicEstimator {
  constructor(numBands, config = {}) {
    this.numBands = numBands;
    this.minSamplesForFit = config.minSamplesForFit ?? 3;
    this.maxTrackedPeriod = config.maxTrackedPeriod ?? 40;
    this.reset();
  }

  reset() {
    // Per-band arrival timestamps history
    this.pulseHistory = Array.from({ length: this.numBands }, () => []);
    // Estimated period T_hat and phase phi_hat
    this.estimatedPeriod = new Array(this.numBands).fill(null);
    this.estimatedPhase = new Array(this.numBands).fill(null);
    this.confidence = new Array(this.numBands).fill(0);
    this.currentStep = 0;
  }

  /**
   * Observe whether the currently tuned band was active at time t
   * @param {number} band - Channel index
   * @param {boolean} wasHit - True if signal detected
   * @param {number} t - Current time step
   */
  observe(band, wasHit, t) {
    this.currentStep = t;
    if (wasHit) {
      const history = this.pulseHistory[band];
      // Avoid duplicate timestamps
      if (history.length === 0 || history[history.length - 1] !== t) {
        history.push(t);
        if (history.length > 30) history.shift();
      }

      // If we have at least 3 pulses, compute period & phase estimate
      if (history.length >= this.minSamplesForFit) {
        this._estimatePeriodPhase(band);
      }
    }
  }

  _estimatePeriodPhase(band) {
    const history = this.pulseHistory[band];
    if (history.length < 2) return;

    // Calculate inter-pulse arrival intervals (delta t)
    const deltas = [];
    for (let i = 1; i < history.length; i++) {
      const dt = history[i] - history[i - 1];
      if (dt > 0 && dt <= this.maxTrackedPeriod) {
        deltas.push(dt);
      }
    }

    if (deltas.length === 0) return;

    // Mode / Median histogram for dominant fundamental period
    const counts = {};
    deltas.forEach(d => { counts[d] = (counts[d] || 0) + 1; });
    let bestDelta = deltas[0], maxCount = 0;
    Object.keys(counts).forEach(d => {
      const numD = parseInt(d);
      if (counts[d] > maxCount) {
        maxCount = counts[d];
        bestDelta = numD;
      }
    });

    this.estimatedPeriod[band] = bestDelta;
    // Phase phi: remainder modulo estimated period
    const lastTime = history[history.length - 1];
    this.estimatedPhase[band] = lastTime % bestDelta;
    this.confidence[band] = Math.min(1.0, history.length / 6);
  }

  /**
   * Predict which band has an incoming periodic pulse at time t
   * If multiple bands are expected, prioritize the one with highest confidence or earliest deadline
   */
  selectBand(t, fallbackBand = 0) {
    let bestBand = null;
    let maxConf = -1;

    for (let b = 0; b < this.numBands; b++) {
      const T = this.estimatedPeriod[b];
      const phi = this.estimatedPhase[b];
      if (T !== null && phi !== null) {
        // Check if pulse is expected at time t
        if (t % T === phi) {
          if (this.confidence[b] > maxConf) {
            maxConf = this.confidence[b];
            bestBand = b;
          }
        }
      }
    }

    if (bestBand !== null) return bestBand;

    // If no periodic pulse expected at exact step t, explore channels with fewest observations
    let minObs = Infinity, leastExploredBand = fallbackBand;
    for (let b = 0; b < this.numBands; b++) {
      const obsCount = this.pulseHistory[b].length;
      if (obsCount < minObs) {
        minObs = obsCount;
        leastExploredBand = b;
      }
    }
    return leastExploredBand;
  }
}

// ─── 2. Q-Learning Agent ──────────────────────────────────────────────────────
export class QLearningAgent {
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
export class UCBAgent {
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

