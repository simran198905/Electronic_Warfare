/**
 * Scan Strategies / Schedulers
 * Each strategy implements: selectBand(t) and update(band, reward, activity, t)
 */

import { QLearningAgent, UCBAgent, OptimalPeriodicEstimator, WhittleIndexAgent } from './qlearning.js';
import { SeededRNG } from './simulator.js';

export class SequentialStrategy {
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

export class RandomStrategy {
  constructor(numBands, rng = new SeededRNG(42)) {
    this.numBands = numBands;
    this.rng = rng;
    this.name = 'Uniform Random';
    this.color = '#64748b';
    this.description = 'Uncoordinated stochastic channel selection with uniform probability distribution. Zero memory.';
  }
  selectBand() {
    return this.rng.randInt(0, this.numBands - 1);
  }
  update() {}
  reset() {}
}

export class PriorityStrategy {
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

export class PeriodicCoincidenceStrategy {
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

export class UCBStrategy {
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

export class QLearningStrategy {
  constructor(numBands, rng = new SeededRNG(42)) {
    this.numBands = numBands;
    this.agent = new QLearningAgent(numBands, {}, rng);
    this.currentBand = 0;
    this.chosenAction = 0;
    this.name = 'Q-Learning Adaptive (RL)';
    this.color = '#3b82f6';
    this.description = 'Belief-state reinforcement learning agent that optimizes dwell policy via full-spectrum temporal difference learning.';
  }
  selectBand(t = 0) {
    this.chosenAction = this.agent.selectBand(this.currentBand, t);
    return this.chosenAction;
  }
  update(actionBand, reward, activity, t = 0) {
    const nextState = actionBand;
    this.agent.update(this.currentBand, actionBand, reward, nextState, activity, t);
    this.currentBand = nextState;
  }
  reset() {
    this.agent.reset();
    this.currentBand = 0;
    this.chosenAction = 0;
  }
  getAgent() { return this.agent; }
}

export class WhittleIndexStrategy {
  constructor(numBands, rng = new SeededRNG(42)) {
    this.numBands = numBands;
    this.agent = new WhittleIndexAgent(numBands, {}, rng);
    this.currentBand = 0;
    this.chosenAction = 0;
    this.name = 'Whittle-Index (Restless MAB)';
    this.color = '#10b981';
    this.description = 'Restless Multi-Armed Bandit with dynamic Markov belief state, threat-weighted index, and retune penalty.';
  }
  selectBand(t = 0) {
    this.chosenAction = this.agent.selectBand(this.currentBand, t);
    return this.chosenAction;
  }
  update(actionBand, reward, activity, t = 0, envDetails = null) {
    this.agent.update(actionBand, reward, activity, t, envDetails);
    this.currentBand = actionBand;
  }
  reset() {
    this.agent.reset();
    this.currentBand = 0;
    this.chosenAction = 0;
  }
  getAgent() { return this.agent; }
}

export function createAllStrategies(numBands, seed = 42) {
  const rngRandom = new SeededRNG(seed + 101);
  const rngQ = new SeededRNG(seed + 202);
  const rngWhittle = new SeededRNG(seed + 303);

  return [
    new SequentialStrategy(numBands),
    new RandomStrategy(numBands, rngRandom),
    new PriorityStrategy(numBands),
    new PeriodicCoincidenceStrategy(numBands),
    new UCBStrategy(numBands),
    new QLearningStrategy(numBands, rngQ),
    new WhittleIndexStrategy(numBands, rngWhittle),
  ];
}


