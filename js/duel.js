/**
 * Interactive Operator Station & Duel Controller
 * Allows human operator to manually scan RF channels by ear and keypress,
 * competing directly against AI schedulers in real-time.
 */

import { MetricsTracker } from './metrics.js';
import { globalAudio } from './audio.js';

export const DUEL_MODES = {
  PRACTICE: 'practice',
  SORTIE_30: 'sortie_30',
  SORTIE_60: 'sortie_60',
};

export class OperatorDuelController {
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
