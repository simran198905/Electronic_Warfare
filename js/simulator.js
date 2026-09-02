/**
 * RF Environment Simulator
 */

export const EMITTER_TYPES = {
  PERIODIC: 'periodic',
  AGILE: 'agile',
  INTERMITTENT: 'intermittent',
  BURST: 'burst',
};

export class Emitter {
  constructor(id, type, config = {}) {
    this.id = id;
    this.type = type;
    this.config = config;
    this.state = false;
    this.phase = Math.floor(Math.random() * 20);
    this.currentBand = config.homeBand ?? 0;
    this.burstCounter = 0;
    this.burstLength = config.burstLength ?? 3;
    this.burstGap = config.burstGap ?? 7;
    this.inBurst = false;
  }

  step(t, numBands) {
    switch (this.type) {
      case EMITTER_TYPES.PERIODIC: {
        const period = this.config.period ?? 10;
        const duty = this.config.duty ?? 0.4;
        const slot = (t + this.phase) % period;
        this.state = slot < Math.round(period * duty);
        return { band: this.config.homeBand ?? 0, active: this.state };
      }
      case EMITTER_TYPES.AGILE: {
        const hopInterval = this.config.hopInterval ?? 5;
        if (t % hopInterval === 0) {
          this.currentBand = (this.currentBand + Math.floor(Math.random() * (numBands - 1)) + 1) % numBands;
        }
        this.state = Math.random() < (this.config.txProb ?? 0.8);
        return { band: this.currentBand, active: this.state };
      }
      case EMITTER_TYPES.INTERMITTENT: {
        this.state = Math.random() < (this.config.txProb ?? 0.3);
        return { band: this.config.homeBand ?? 0, active: this.state };
      }
      case EMITTER_TYPES.BURST: {
        this.burstCounter++;
        if (this.inBurst) {
          if (this.burstCounter >= this.burstLength) { this.inBurst = false; this.burstCounter = 0; }
          this.state = true;
        } else {
          if (this.burstCounter >= this.burstGap) { this.inBurst = true; this.burstCounter = 0; }
          this.state = false;
        }
        return { band: this.config.homeBand ?? 0, active: this.state };
      }
      default: return { band: 0, active: false };
    }
  }
}

export class RFEnvironment {
  constructor(config = {}) {
    this.numBands = config.numBands ?? 16;
    this.emitters = [];
    this.t = 0;
    this.bandActivity = new Array(this.numBands).fill(false);
    this.history = [];
    this.maxHistory = config.maxHistory ?? 500;
    this._buildEmitters(config.emitters);
  }

  _buildEmitters(emitterConfigs) {
    if (emitterConfigs) {
      emitterConfigs.forEach((cfg, i) => this.emitters.push(new Emitter(i, cfg.type, cfg)));
      return;
    }
    const defaults = [
      { type: EMITTER_TYPES.PERIODIC, homeBand: 0,  period: 8,  duty: 0.5  },
      { type: EMITTER_TYPES.PERIODIC, homeBand: 3,  period: 12, duty: 0.3  },
      { type: EMITTER_TYPES.PERIODIC, homeBand: 7,  period: 6,  duty: 0.6  },
      { type: EMITTER_TYPES.PERIODIC, homeBand: 11, period: 20, duty: 0.25 },
      { type: EMITTER_TYPES.PERIODIC, homeBand: 14, period: 9,  duty: 0.45 },
      { type: EMITTER_TYPES.AGILE,    hopInterval: 4, txProb: 0.75 },
      { type: EMITTER_TYPES.AGILE,    hopInterval: 7, txProb: 0.65 },
      { type: EMITTER_TYPES.AGILE,    hopInterval: 3, txProb: 0.80 },
      { type: EMITTER_TYPES.INTERMITTENT, homeBand: 5,  txProb: 0.35 },
      { type: EMITTER_TYPES.INTERMITTENT, homeBand: 9,  txProb: 0.45 },
      { type: EMITTER_TYPES.INTERMITTENT, homeBand: 13, txProb: 0.25 },
      { type: EMITTER_TYPES.BURST, homeBand: 2,  burstLength: 3, burstGap: 10 },
      { type: EMITTER_TYPES.BURST, homeBand: 10, burstLength: 5, burstGap: 8  },
    ];
    defaults.forEach((cfg, i) => this.emitters.push(new Emitter(i, cfg.type, cfg)));
  }

  step() {
    const activity = new Array(this.numBands).fill(false);
    this.emitters.forEach(e => {
      const { band, active } = e.step(this.t, this.numBands);
      if (active) activity[band] = true;
    });
    this.bandActivity = activity;
    if (this.history.length >= this.maxHistory) this.history.shift();
    this.history.push([...activity]);
    this.t++;
    return activity;
  }

  reset() {
    this.t = 0;
    this.bandActivity = new Array(this.numBands).fill(false);
    this.history = [];
    this.emitters.forEach(e => {
      e.state = false;
      e.phase = Math.floor(Math.random() * 20);
      e.currentBand = e.config.homeBand ?? 0;
      e.burstCounter = 0;
      e.inBurst = false;
    });
  }

  getBandDensity() {
    if (this.history.length === 0) return new Array(this.numBands).fill(0);
    const counts = new Array(this.numBands).fill(0);
    this.history.forEach(snap => snap.forEach((v, b) => { if (v) counts[b]++; }));
    return counts.map(c => c / this.history.length);
  }

  getEmitterSummary() {
    return this.emitters.map(e => ({
      id: e.id, type: e.type, band: e.currentBand, active: e.state, config: e.config,
    }));
  }
}
