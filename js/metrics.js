/**
 * Performance Metrics (Figures of Merit)
 */

export class MetricsTracker {
  constructor(name, color) {
    this.name = name;
    this.color = color;
    this.reset();
  }

  reset() {
    this.hits = 0;           // receiver on active band
    this.misses = 0;         // receiver on silent band when others active
    this.falseAlarms = 0;    // receiver sees nothing but registered attempt
    this.totalTransmissions = 0; // total band-steps where ANY band was active
    this.totalSamples = 0;
    this.interceptTimes = []; // steps from emission start to detection
    this.emissionStartTimes = {}; // bandIdx -> step when emission started
    this.rewardHistory = [];
    this.pdHistory = [];
    this.interceptRateHistory = [];
    this.interceptTimeHistory = [];
    this.cumulativeReward = 0;
    this.lastActivity = [];
  }

  /**
   * Record one step result
   * @param {number} band - band the receiver was tuned to
   * @param {boolean[]} activity - truth: which bands were active
   * @param {number} t - current time step
   */
  record(band, activity, t) {
    this.totalSamples++;
    const anyActive = activity.some(v => v);
    const bandActive = activity[band];

    if (anyActive) this.totalTransmissions++;

    // Track emission start times for intercept time error
    activity.forEach((active, b) => {
      if (active && !(this.lastActivity[b])) {
        this.emissionStartTimes[b] = t; // new emission started
      }
    });

    let reward = 0;
    if (bandActive) {
      this.hits++;
      reward = 1.0;
      // Record intercept time
      if (this.emissionStartTimes[band] !== undefined) {
        this.interceptTimes.push(t - this.emissionStartTimes[band]);
        delete this.emissionStartTimes[band];
      }
    } else if (anyActive) {
      this.misses++;
      reward = -0.1; // small penalty for missing active band
    } else {
      reward = 0.0; // no penalty for quiet band
    }

    this.cumulativeReward += reward;
    this.rewardHistory.push(this.cumulativeReward);

    // Pd (rolling window of 50)
    const window = 50;
    if (this.totalTransmissions > 0) {
      this.pdHistory.push(this.hits / this.totalTransmissions);
    }

    // Intercept rate (hits per 10 steps)
    this.interceptRateHistory.push(this.hits / this.totalSamples);

    // Avg intercept time error
    const avgIntTime = this.interceptTimes.length > 0
      ? this.interceptTimes.reduce((a, b) => a + b, 0) / this.interceptTimes.length
      : 0;
    this.interceptTimeHistory.push(avgIntTime);

    this.lastActivity = [...activity];
    return reward;
  }

  get pd() {
    return this.totalTransmissions > 0 ? this.hits / this.totalTransmissions : 0;
  }

  get pfa() {
    const total = this.totalSamples - this.totalTransmissions;
    return total > 0 ? this.falseAlarms / total : 0;
  }

  get avgInterceptRate() {
    return this.totalSamples > 0 ? this.hits / this.totalSamples : 0;
  }

  get avgInterceptTimeError() {
    if (this.interceptTimes.length === 0) return 0;
    return this.interceptTimes.reduce((a, b) => a + b, 0) / this.interceptTimes.length;
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
      missRate: this.missRate,
      hits: this.hits,
      misses: this.misses,
      totalSamples: this.totalSamples,
      cumulativeReward: this.cumulativeReward,
    };
  }
}
