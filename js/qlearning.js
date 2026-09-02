/**
 * Q-Learning Agent for EW Scan Scheduling
 */

export class QLearningAgent {
  constructor(numBands, config = {}) {
    this.numBands = numBands;
    this.alpha = config.alpha ?? 0.15;    // learning rate
    this.gamma = config.gamma ?? 0.85;   // discount factor
    this.epsilon = config.epsilon ?? 1.0; // exploration rate
    this.epsilonMin = config.epsilonMin ?? 0.05;
    this.epsilonDecay = config.epsilonDecay ?? 0.995;
    // Q-table: state = current band, action = next band
    this.qTable = Array.from({ length: numBands }, () => new Array(numBands).fill(0));
    this.lastBand = 0;
    this.totalReward = 0;
    this.rewardHistory = [];
    this.episodeRewards = [];
    this.steps = 0;
  }

  /** Choose next band using epsilon-greedy policy */
  selectBand(currentBand) {
    if (Math.random() < this.epsilon) {
      return Math.floor(Math.random() * this.numBands); // explore
    }
    // exploit: pick band with highest Q-value from current state
    const row = this.qTable[currentBand];
    let maxQ = -Infinity, bestBand = 0;
    row.forEach((q, b) => { if (q > maxQ) { maxQ = q; bestBand = b; } });
    return bestBand;
  }

  /** Update Q-table based on reward received */
  update(fromBand, toBand, reward, nextBand) {
    const maxNextQ = Math.max(...this.qTable[nextBand]);
    const currentQ = this.qTable[fromBand][toBand];
    this.qTable[fromBand][toBand] = currentQ + this.alpha * (reward + this.gamma * maxNextQ - currentQ);
    this.totalReward += reward;
    this.rewardHistory.push(this.totalReward);
    if (this.epsilon > this.epsilonMin) {
      this.epsilon *= this.epsilonDecay;
    }
    this.steps++;
  }

  reset() {
    this.qTable = Array.from({ length: this.numBands }, () => new Array(this.numBands).fill(0));
    this.lastBand = 0;
    this.totalReward = 0;
    this.rewardHistory = [];
    this.epsilon = 1.0;
    this.steps = 0;
  }

  getQTableFlat() {
    return this.qTable.map(row => [...row]);
  }

  getMaxQPerBand() {
    return this.qTable.map(row => Math.max(...row));
  }
}

/**
 * Upper Confidence Bound (UCB) Agent — Multi-Armed Bandit
 */
export class UCBAgent {
  constructor(numBands, c = 2.0) {
    this.numBands = numBands;
    this.c = c;  // exploration constant
    this.counts = new Array(numBands).fill(0);
    this.values = new Array(numBands).fill(0);
    this.t = 0;
    this.totalReward = 0;
    this.rewardHistory = [];
  }

  selectBand() {
    // Ensure each band is tried at least once
    for (let b = 0; b < this.numBands; b++) {
      if (this.counts[b] === 0) return b;
    }
    let maxUCB = -Infinity, bestBand = 0;
    this.values.forEach((val, b) => {
      const ucb = val + this.c * Math.sqrt(Math.log(this.t + 1) / this.counts[b]);
      if (ucb > maxUCB) { maxUCB = ucb; bestBand = b; }
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
