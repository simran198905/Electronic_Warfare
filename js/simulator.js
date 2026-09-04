/**
 * RF Environment Simulator
 * Supports deterministic seeded PRNG (Mulberry32), spatial scan rotating beam radars,
 * frequency agile hoppers, periodic pulse radars, intermittent emitters, and receiver noise floor.
 */

// ─── Seeded PRNG (Mulberry32) ─────────────────────────────────────────────────
export class SeededRNG {
  constructor(seed = 42) {
    this.setSeed(seed);
  }

  setSeed(seed) {
    this.seed = typeof seed === 'number' ? seed : 42;
    this.state = this.seed >>> 0;
  }

  /** Return pseudo-random float in [0, 1) */
  random() {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Return pseudo-random integer in [min, max] */
  randInt(min, max) {
    return Math.floor(this.random() * (max - min + 1)) + min;
  }
}

export const globalRNG = new SeededRNG(42);

export const EMITTER_TYPES = {
  PERIODIC: 'periodic',
  AGILE: 'agile',
  INTERMITTENT: 'intermittent',
  BURST: 'burst',
  SPATIAL_SCAN: 'spatial_scan', // Rotating radar beam illumination
};

export class Emitter {
  constructor(id, type, config = {}, rng = globalRNG) {
    this.id = id;
    this.type = type;
    this.config = config;
    this.rng = rng;
    this.state = false;
    this.phase = this.rng.randInt(0, 19);
    this.currentBand = config.homeBand ?? 0;
    this.burstCounter = 0;
    this.burstLength = config.burstLength ?? 3;
    this.burstGap = config.burstGap ?? 7;
    this.inBurst = false;

    // Spatial scan radar antenna properties
    this.rotationPeriod = config.rotationPeriod ?? 16; // Time steps for 360-deg rotation
    this.beamwidthDeg = config.beamwidthDeg ?? 35;     // 3dB Mainlobe beamwidth
    this.rxAzimuthDeg = config.rxAzimuthDeg ?? 90;     // Angle of ES receiver relative to radar
    this.currentAzimuth = config.initialAzimuth ?? this.rng.randInt(0, 359);
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
          const hopOffset = this.rng.randInt(1, Math.max(1, numBands - 1));
          this.currentBand = (this.currentBand + hopOffset) % numBands;
        }
        this.state = this.rng.random() < (this.config.txProb ?? 0.8);
        return { band: this.currentBand, active: this.state };
      }

      case EMITTER_TYPES.INTERMITTENT: {
        this.state = this.rng.random() < (this.config.txProb ?? 0.35);
        return { band: this.config.homeBand ?? 0, active: this.state };
      }

      case EMITTER_TYPES.BURST: {
        this.burstCounter++;
        if (this.inBurst) {
          if (this.burstCounter >= this.burstLength) {
            this.inBurst = false;
            this.burstCounter = 0;
          }
          this.state = true;
        } else {
          if (this.burstCounter >= this.burstGap) {
            this.inBurst = true;
            this.burstCounter = 0;
          }
          this.state = false;
        }
        return { band: this.config.homeBand ?? 0, active: this.state };
      }

      case EMITTER_TYPES.SPATIAL_SCAN: {
        // Rotating radar beam: mainlobe illuminates receiver only during alignment
        const degPerStep = 360 / this.rotationPeriod;
        this.currentAzimuth = (this.currentAzimuth + degPerStep) % 360;
        let angleDiff = Math.abs(this.currentAzimuth - this.rxAzimuthDeg);
        if (angleDiff > 180) angleDiff = 360 - angleDiff;

        // Mainlobe illumination condition
        const inMainlobe = angleDiff <= (this.beamwidthDeg / 2);
        // Intermittent pulse trains within mainlobe illumination
        this.state = inMainlobe && (this.rng.random() < (this.config.txProb ?? 0.9));
        return { band: this.config.homeBand ?? 0, active: this.state };
      }

      default:
        return { band: 0, active: false };
    }
  }

  reset() {
    this.state = false;
    this.phase = this.rng.randInt(0, 19);
    this.currentBand = this.config.homeBand ?? 0;
    this.burstCounter = 0;
    this.inBurst = false;
    this.currentAzimuth = this.config.initialAzimuth ?? this.rng.randInt(0, 359);
  }
}

export class RFEnvironment {
  constructor(config = {}) {
    this.numBands = config.numBands ?? 16;
    this.seed = config.seed ?? 42;
    this.rng = new SeededRNG(this.seed);
    this.noiseProb = config.noiseProb ?? 0.02; // Receiver thermal false alarm probability
    this.emitters = [];
    this.t = 0;
    this.bandActivity = new Array(this.numBands).fill(false);
    this.rawNoise = new Array(this.numBands).fill(false);
    this.history = [];
    this.maxHistory = config.maxHistory ?? 500;
    this._buildEmitters(config.emitters);
  }

  setSeed(seed) {
    this.seed = seed;
    this.rng.setSeed(seed);
    this.reset();
  }

  _buildEmitters(emitterConfigs) {
    if (emitterConfigs) {
      emitterConfigs.forEach((cfg, i) => this.emitters.push(new Emitter(i, cfg.type, cfg, this.rng)));
      return;
    }
    const defaults = [
      { type: EMITTER_TYPES.PERIODIC, homeBand: 1, period: 10, duty: 0.20 },
      { type: EMITTER_TYPES.PERIODIC, homeBand: 9, period: 15, duty: 0.20 },
      { type: EMITTER_TYPES.SPATIAL_SCAN, homeBand: 4, rotationPeriod: 18, beamwidthDeg: 30, rxAzimuthDeg: 90 },
      { type: EMITTER_TYPES.SPATIAL_SCAN, homeBand: 12, rotationPeriod: 24, beamwidthDeg: 25, rxAzimuthDeg: 180 },
      { type: EMITTER_TYPES.AGILE, hopInterval: 5, txProb: 0.65 },
      { type: EMITTER_TYPES.AGILE, hopInterval: 8, txProb: 0.50 },
      { type: EMITTER_TYPES.BURST, homeBand: 7, burstLength: 3, burstGap: 12 },
      { type: EMITTER_TYPES.INTERMITTENT, homeBand: 14, txProb: 0.30 },
    ];
    defaults.forEach((cfg, i) => this.emitters.push(new Emitter(i, cfg.type, cfg, this.rng)));
  }

  step() {
    const activity = new Array(this.numBands).fill(false);
    this.emitters.forEach(e => {
      const { band, active } = e.step(this.t, this.numBands);
      if (active && band < this.numBands) activity[band] = true;
    });

    // Simulate occasional thermal noise spikes exceeding receiver detection threshold
    const noise = new Array(this.numBands).fill(false);
    for (let b = 0; b < this.numBands; b++) {
      if (!activity[b] && this.rng.random() < this.noiseProb) {
        noise[b] = true;
      }
    }
    this.rawNoise = noise;

    this.bandActivity = activity;
    if (this.history.length >= this.maxHistory) this.history.shift();
    this.history.push([...activity]);
    this.t++;
    return { activity, noise };
  }

  reset() {
    this.t = 0;
    this.bandActivity = new Array(this.numBands).fill(false);
    this.rawNoise = new Array(this.numBands).fill(false);
    this.history = [];
    this.emitters.forEach(e => e.reset());
  }

  getBandDensity() {
    if (this.history.length === 0) return new Array(this.numBands).fill(0);
    const counts = new Array(this.numBands).fill(0);
    this.history.forEach(snap => snap.forEach((v, b) => { if (v) counts[b]++; }));
    return counts.map(c => c / this.history.length);
  }

  getEmitterSummary() {
    return this.emitters.map(e => ({
      id: e.id,
      type: e.type,
      band: e.currentBand,
      active: e.state,
      config: e.config,
    }));
  }
}

