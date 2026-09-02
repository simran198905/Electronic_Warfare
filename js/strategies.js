/**
 * Scan Strategies / Schedulers
 * Each strategy implements: selectBand(t) and update(band, reward, activity, t)
 */

import { QLearningAgent, UCBAgent, OptimalPeriodicEstimator } from './qlearning.js';

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

export function createAllStrategies(numBands) {
  return [
    new SequentialStrategy(numBands),
    new RandomStrategy(numBands),
    new PriorityStrategy(numBands),
    new PeriodicCoincidenceStrategy(numBands),
    new UCBStrategy(numBands),
    new QLearningStrategy(numBands),
  ];
}


