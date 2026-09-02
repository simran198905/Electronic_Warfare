/**
 * Scan Strategies / Schedulers
 * Each strategy implements: selectBand(state) and update(band, reward, activity)
 */

import { QLearningAgent, UCBAgent } from './qlearning.js';

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
    this.name = 'Q-Learning Adaptive (RL)';
    this.color = '#3b82f6';
    this.description = 'Closed-loop reinforcement learning agent that synchronizes dwell timing to learned emitter PRI cycles.';
  }
  selectBand() {
    const next = this.agent.selectBand(this.currentBand);
    this._prevBand = this.currentBand;
    this.currentBand = next;
    return next;
  }
  update(band, reward, activity) {
    const nextBand = this.agent.selectBand(band);
    this.agent.update(this._prevBand ?? 0, band, reward, nextBand);
  }
  reset() {
    this.agent.reset();
    this.currentBand = 0;
    this._prevBand = 0;
  }
  getAgent() { return this.agent; }
}

export function createAllStrategies(numBands) {
  return [
    new SequentialStrategy(numBands),
    new RandomStrategy(numBands),
    new PriorityStrategy(numBands),
    new UCBStrategy(numBands),
    new QLearningStrategy(numBands),
  ];
}

