/**
 * Closed-Loop Schedulers & Machine Learning Agents:
 * 1. Optimal Periodic Coincidence Estimator (Period & Phase Tracker)
 * 2. Q-Learning Reinforcement Learning Agent (TD-Learning with Epsilon Decay & Train/Eval Modes)
 * 3. UCB-1 Multi-Armed Bandit Agent
 */

import { globalRNG } from './simulator.js';

// ─── 1. Optimal Periodic Scan Estimator (Radar PRI & Phase Tracker) ────────────
// ─── 1. Optimal Periodic Scan Estimator (Radar PRI & Phase Tracker) ────────────
export class OptimalPeriodicEstimator {
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

