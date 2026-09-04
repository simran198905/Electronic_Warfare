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
   * Estimates fundamental period T and phase phi via modular congruence and
   * delta-gap cross-checking to eliminate subharmonic aliasing.
   */
  _estimatePeriodPhase(band) {
    const edges = this.risingEdges[band];
    if (edges.length < this.minSamplesForFit) return;

    // Calculate inter-arrival intervals between consecutive rising edges
    const deltas = [];
    for (let i = 1; i < edges.length; i++) {
      const dt = edges[i] - edges[i - 1];
      if (dt > 1) { // ignore intra-burst dwell clicks
        deltas.push(dt);
      }
    }
    if (deltas.length === 0) return;

    // Radar PRI de-interleaving: the true fundamental period cannot be smaller
    // than the minimum observed arrival gap between distinct bursts.
    // This strictly prevents locking onto subharmonics (e.g. T=4 when true T=8).
    const minObservedGap = Math.min(...deltas);
    const minSearchT = Math.max(4, Math.floor(minObservedGap * 0.75));

    let bestT = null;
    let bestPhi = null;
    let bestScore = 0;

    for (let T = minSearchT; T <= this.maxTrackedPeriod; T++) {
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

      const congruenceScore = maxCount / edges.length;
      if (congruenceScore >= 0.70) {
        // Cross-check: true period must be consistent with observed inter-arrival gaps
        const dividesDeltas = deltas.filter(d => (d % T <= 1) || ((T - (d % T)) <= 1)).length / deltas.length;
        const totalScore = congruenceScore * 0.6 + dividesDeltas * 0.4;
        if (totalScore > bestScore) {
          bestT = T;
          bestPhi = dominantPhi;
          bestScore = totalScore;
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
      if (n === 0) return b;
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

  /**
   * Forward-Looking Prediction Engine:
   * Predicts intercept opportunities and expected arrival slots over a future horizon.
   * Enables ES scheduler to project intercept times and interception ratios before dwell.
   * @param {number} horizon - Number of future time steps to forecast (default: 10)
   * @returns {Object} Forecast containing predicted hits, expected arrival times, and confidence
   */
  predictNextIntercepts(horizon = 10) {
    const curT = this.currentStep;
    const predictions = [];
    let expectedIntercepts = 0;

    for (let b = 0; b < this.numBands; b++) {
      const T = this.estimatedPeriod[b];
      const phi = this.estimatedPhase[b];
      const conf = this.confidence[b];
      if (T !== null && phi !== null && conf >= 0.25) {
        const arrivalSlots = [];
        for (let dt = 1; dt <= horizon; dt++) {
          const tFuture = curT + dt;
          const slot = ((tFuture - phi) % T + T) % T;
          if (slot === 0) {
            arrivalSlots.push({ tFuture, dt });
          }
        }
        if (arrivalSlots.length > 0) {
          const nextArrival = arrivalSlots[0];
          predictions.push({
            band: b,
            expectedArrivalStep: nextArrival.tFuture,
            timeToNextIntercept: nextArrival.dt,
            period: T,
            confidence: conf,
          });
          expectedIntercepts += arrivalSlots.length * conf;
        }
      }
    }

    predictions.sort((a, b) => a.timeToNextIntercept - b.timeToNextIntercept);
    const predictedInterceptionRatio = horizon > 0 ? expectedIntercepts / horizon : 0;

    return {
      currentStep: curT,
      horizon,
      predictions,
      predictedInterceptionRatio: Math.min(1.0, predictedInterceptionRatio),
      expectedInterceptCount: expectedIntercepts,
    };
  }
}

// ─── 2. Full-Spectrum Belief-State Q-Learning Agent ───────────────────────────
export class QLearningAgent {
  constructor(numBands, config = {}, rng = globalRNG) {
    this.numBands = numBands;
    this.rng = rng;
    this.alpha = config.alpha ?? 0.06;       // Learning rate
    this.gamma = config.gamma ?? 0.85;      // Discount factor
    this.epsilon = config.epsilon ?? 1.0;    // Exploration rate
    this.epsilonMin = config.epsilonMin ?? 0.05;
    this.epsilonDecay = config.epsilonDecay ?? 0.996;
    this.evalMode = config.evalMode ?? false; // Freeze weights in eval mode
    this.numFeatures = 6;

    // Linear weights per band: [numBands][numFeatures]
    this.weights = Array.from({ length: numBands }, () => new Float64Array(this.numFeatures).fill(0.1));
    this.dwellCounts = new Array(numBands).fill(0);
    this.hitCounts = new Array(numBands).fill(0);
    this.lastDwellStep = new Array(numBands).fill(0);
    this.consecutiveMisses = new Array(numBands).fill(0);
    this.lastActionBand = 0;

    this.totalReward = 0;
    this.rewardHistory = [];
    this.steps = 0;
    this.currentStep = 0;
  }

  setEvaluationMode(isEval) {
    this.evalMode = !!isEval;
  }

  /**
   * Constructs full-spectrum situational awareness feature vector for candidate band
   * @param {number} band - Channel index
   * @param {number} t - Current mission time step
   */
  getFeatures(band, t) {
    const staleness = Math.min(2.5, (t - this.lastDwellStep[band]) / this.numBands);
    const empiricalRate = (this.hitCounts[band] + 0.5) / (this.dwellCounts[band] + 1.0);
    const missPenalty = Math.min(1.0, this.consecutiveMisses[band] / 4.0);
    const urgency = staleness * empiricalRate;
    const hopPenalty = Math.abs(band - this.lastActionBand) / this.numBands;
    const bias = 1.0;
    return [staleness, empiricalRate, urgency, missPenalty, hopPenalty, bias];
  }

  /** Compute action-value Q(s, band) = w_band^T * phi(band) */
  computeQ(band, t) {
    const phi = this.getFeatures(band, t);
    const w = this.weights[band];
    let q = 0;
    for (let j = 0; j < this.numFeatures; j++) q += w[j] * phi[j];
    return q;
  }

  /**
   * Choose next band using epsilon-greedy policy over full-spectrum Q-values
   */
  selectBand(currentBand, t = 0) {
    this.currentStep = t;
    const effEpsilon = this.evalMode ? 0.0 : this.epsilon;

    if (this.rng.random() < effEpsilon) {
      return this.rng.randInt(0, this.numBands - 1);
    }

    let maxQ = -Infinity;
    let bestActions = [];

    for (let b = 0; b < this.numBands; b++) {
      const q = this.computeQ(b, t);
      if (q > maxQ) {
        maxQ = q;
        bestActions = [b];
      } else if (q === maxQ) {
        bestActions.push(b);
      }
    }

    return bestActions[this.rng.randInt(0, bestActions.length - 1)];
  }

  /**
   * Rigorous Q-Learning Gradient Temporal Difference Update:
   * w_a <- w_a + alpha * [ R + gamma * max_{a'} Q(s', a') - Q(s, a) ] * phi(s, a)
   */
  update(fromBand, actionBand, reward, nextStateBand, activity = null, t = null) {
    const curT = t !== null ? t : this.currentStep;
    this.dwellCounts[actionBand]++;
    this.lastDwellStep[actionBand] = curT;
    this.lastActionBand = actionBand;

    const wasHit = (activity && activity[actionBand]) || reward > 0;
    if (wasHit) {
      this.hitCounts[actionBand]++;
      this.consecutiveMisses[actionBand] = 0;
    } else {
      this.consecutiveMisses[actionBand]++;
    }

    if (this.evalMode) {
      this.totalReward += reward;
      this.rewardHistory.push(this.totalReward);
      this.steps++;
      return;
    }

    // Compute Q(s, a)
    const phi = this.getFeatures(actionBand, curT);
    const currentQ = this.computeQ(actionBand, curT);

    // Compute max Q(s', a') for next step curT + 1
    let maxNextQ = -Infinity;
    for (let b = 0; b < this.numBands; b++) {
      const qNext = this.computeQ(b, curT + 1);
      if (qNext > maxNextQ) maxNextQ = qNext;
    }

    // TD Error
    const tdError = reward + this.gamma * maxNextQ - currentQ;
    const w = this.weights[actionBand];
    for (let j = 0; j < this.numFeatures; j++) {
      w[j] += this.alpha * tdError * phi[j];
    }

    this.totalReward += reward;
    this.rewardHistory.push(this.totalReward);

    if (this.epsilon > this.epsilonMin) {
      this.epsilon *= this.epsilonDecay;
    }
    this.steps++;
  }

  reset() {
    this.weights = Array.from({ length: this.numBands }, () => new Float64Array(this.numFeatures).fill(0.1));
    this.dwellCounts = new Array(this.numBands).fill(0);
    this.hitCounts = new Array(this.numBands).fill(0);
    this.lastDwellStep = new Array(this.numBands).fill(0);
    this.consecutiveMisses = new Array(this.numBands).fill(0);
    this.lastActionBand = 0;
    this.totalReward = 0;
    this.rewardHistory = [];
    this.epsilon = 1.0;
    this.steps = 0;
    this.currentStep = 0;
  }

  /**
   * Forward-Looking Prediction Engine:
   * Uses learned Q-values and staleness dynamics to project next high-probability intercept bands.
   */
  predictNextIntercepts(horizon = 10) {
    const curT = this.currentStep;
    const bandScores = [];
    for (let b = 0; b < this.numBands; b++) {
      const q = this.computeQ(b, curT);
      const empiricalRate = (this.hitCounts[b] + 0.5) / (this.dwellCounts[b] + 1.0);
      const staleness = (curT - this.lastDwellStep[b]);
      bandScores.push({
        band: b,
        qValue: q,
        empiricalRate,
        staleness,
        confidence: Math.min(1.0, this.dwellCounts[b] / 15.0),
      });
    }
    bandScores.sort((a, b) => b.qValue - a.qValue);
    const topCandidates = bandScores.slice(0, 3);
    const avgTopRate = topCandidates.reduce((sum, c) => sum + c.empiricalRate, 0) / topCandidates.length;

    return {
      currentStep: curT,
      horizon,
      topCandidates,
      predictedInterceptionRatio: Math.min(1.0, avgTopRate),
    };
  }

  /** Returns flat N x N representation for UI heatmap visualizer */
  getQTableFlat() {
    const curT = this.currentStep;
    return Array.from({ length: this.numBands }, (row, from) => {
      return Array.from({ length: this.numBands }, (col, to) => {
        return this.computeQ(to, curT);
      });
    });
  }

  /** Export model weights for persistence */
  exportModelJSON() {
    return JSON.stringify({
      numBands: this.numBands,
      alpha: this.alpha,
      gamma: this.gamma,
      epsilon: this.epsilon,
      weights: this.weights.map(w => Array.from(w)),
      dwellCounts: this.dwellCounts,
      hitCounts: this.hitCounts,
      steps: this.steps,
      totalReward: this.totalReward,
    }, null, 2);
  }

  /** Import pre-trained model weights */
  importModelJSON(jsonString) {
    try {
      const data = typeof jsonString === 'string' ? JSON.parse(jsonString) : jsonString;
      if (data.weights && Array.isArray(data.weights)) {
        this.weights = data.weights.map(w => new Float64Array(w));
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

// ─── 4. Restless Multi-Armed Bandit (Whittle Index Policy) ───────────────────
/**
 * Whittle Index Policy for Restless Multi-Armed Bandit (RMAB) Spectrum Search.
 * Models each frequency channel as an evolving two-state Markov process:
 * - State 1: Radiating (Active)
 * - State 0: Silent (Idle)
 * Even when unobserved, channels transition according to estimated rates P(0->1) and P(1->1).
 * The Whittle index quantifies the marginal subsidy for passivity:
 * W_b(pi_b, tau_b) = Threat_b * [ pi_b(t) + c * sqrt(ln(t)/N_b) ] - C_retune * |b - b_current| / N
 */
export class WhittleIndexAgent {
  constructor(numBands, config = {}, rng = globalRNG) {
    this.numBands = numBands;
    this.rng = rng;
    this.explorationConst = config.explorationConst ?? 1.2;
    this.retuneWeight = config.retuneWeight ?? 0.15;
    this.reset();
  }

  reset() {
    this.dwellCounts = new Array(this.numBands).fill(0);
    this.hitCounts = new Array(this.numBands).fill(0);
    this.lastDwellStep = new Array(this.numBands).fill(0);
    this.lastObservedState = new Array(this.numBands).fill(false);
    this.threatEstimates = new Array(this.numBands).fill(1.0);
    this.p01 = new Array(this.numBands).fill(0.15); // P(idle -> active)
    this.p11 = new Array(this.numBands).fill(0.40); // P(active -> active)
    this.currentStep = 0;
    this.lastTunedBand = 0;
    this.totalReward = 0;
    this.rewardHistory = [];
  }

  /**
   * Compute restless Markov belief state pi_b(t) = P(channel b is active at time t)
   */
  getBelief(b, t) {
    const tau = Math.max(0, t - this.lastDwellStep[b]);
    const pi0 = this.lastObservedState[b] ? 1.0 : 0.0;
    const p01 = this.p01[b];
    const p10 = Math.max(0.01, 1.0 - this.p11[b]);
    const stationaryProb = p01 / (p01 + p10);

    // Dynamic Markov propagation across tau idle steps
    const lambda = 1.0 - p01 - p10;
    return stationaryProb + Math.pow(lambda, tau) * (pi0 - stationaryProb);
  }

  /**
   * Compute closed-form Whittle index for channel b
   */
  computeWhittleIndex(b, currentBand, t) {
    const belief = this.getBelief(b, t);
    const n = this.dwellCounts[b];
    const threatMult = this.threatEstimates[b];
    const exploration = Math.sqrt((2 * Math.log(t + 2)) / (n + 1));
    const retunePenalty = this.retuneWeight * (Math.abs(b - currentBand) / this.numBands);

    // Whittle index: threat-scaled active belief + exploration bonus - retune latency subsidy
    return (threatMult * (belief + this.explorationConst * exploration)) - retunePenalty;
  }

  selectBand(currentBand = 0, t = 0) {
    this.currentStep = t;
    this.lastTunedBand = currentBand;

    // Ensure all channels are initially probed
    for (let b = 0; b < this.numBands; b++) {
      if (this.dwellCounts[b] === 0) return b;
    }

    let maxIndex = -Infinity;
    let bestBands = [];

    for (let b = 0; b < this.numBands; b++) {
      const idx = this.computeWhittleIndex(b, currentBand, t);
      if (idx > maxIndex) {
        maxIndex = idx;
        bestBands = [b];
      } else if (Math.abs(idx - maxIndex) < 1e-6) {
        bestBands.push(b);
      }
    }

    return bestBands[this.rng.randInt(0, bestBands.length - 1)];
  }

  update(band, reward, activity = null, t = null, envDetails = null) {
    const curT = t !== null ? t : this.currentStep;
    const wasHit = (activity && activity[band]) || reward > 0;

    // Update transition statistics
    const prevObs = this.lastObservedState[band];
    if (this.dwellCounts[band] > 0) {
      if (!prevObs && wasHit) {
        this.p01[band] = 0.9 * this.p01[band] + 0.1 * 1.0;
      } else if (prevObs && wasHit) {
        this.p11[band] = 0.9 * this.p11[band] + 0.1 * 1.0;
      }
    }

    this.dwellCounts[band]++;
    if (wasHit) this.hitCounts[band]++;
    this.lastDwellStep[band] = curT;
    this.lastObservedState[band] = wasHit;

    if (envDetails && envDetails.maxThreatPerBand && envDetails.maxThreatPerBand[band] > 0) {
      this.threatEstimates[band] = Math.max(1.0, envDetails.maxThreatPerBand[band] / 2.0);
    }

    this.totalReward += reward;
    this.rewardHistory.push(this.totalReward);
  }

  /**
   * Forward-Looking Prediction: forecast high-probability intercept channels over horizon
   */
  predictNextIntercepts(horizon = 10) {
    const curT = this.currentStep;
    const predictions = [];
    for (let b = 0; b < this.numBands; b++) {
      const belief = this.getBelief(b, curT);
      const threat = this.threatEstimates[b];
      predictions.push({
        band: b,
        beliefActive: belief,
        threatLevel: threat,
        expectedScore: belief * threat,
      });
    }
    predictions.sort((a, b) => b.expectedScore - a.expectedScore);
    const topCandidates = predictions.slice(0, 3);
    const predictedInterceptionRatio = topCandidates.reduce((s, c) => s + c.beliefActive, 0) / topCandidates.length;

    return {
      currentStep: curT,
      horizon,
      topCandidates,
      predictedInterceptionRatio: Math.min(1.0, predictedInterceptionRatio),
    };
  }
}


