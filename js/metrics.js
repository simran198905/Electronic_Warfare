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

export class MetricsTracker {
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

  /** Percentage of Correct Decisions / Predictions (CPC / Accuracy) */
  get cpc() {
    if (this.totalSamples === 0) return 0;
    return ((this.hits + this.trueNegatives) / (this.totalSamples + this.misses)) * 100;
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

