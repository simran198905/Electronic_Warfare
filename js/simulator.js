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

// Threat lethality priority levels (1 = minimal, 5 = critical/fire-control)
export const THREAT_LEVELS = {
  CRITICAL: 5,   // Missile guidance / Target tracking radar
  HIGH: 4,       // Fire control / Acquisition radar
  MEDIUM: 3,     // Surveillance / Early warning 360° radar
  LOW: 2,        // Navigation / Weather radar
  INFO: 1,       // Tactical communications / Beacon
};

// Physical RF hardware specification defaults
export const RF_HARDWARE_SPECS = {
  FREQ_MIN_GHZ: 2.0,            // Lower boundary (S-band)
  FREQ_MAX_GHZ: 18.0,           // Upper boundary (Ku-band)
  DWELL_TIME_US: 50.0,          // 50 microseconds dwell duration per step
  RETUNE_LATENCY_PER_HOP_US: 2.5, // 2.5 us PLL settling time per channel distance
  NOISE_FLOOR_DBM: -95.0,       // Receiver thermal noise floor
  DETECTION_THRESHOLD_DBM: -90.0, // Sensitivity: minimum detectable signal power
};

export class Emitter {
  constructor(id, type, config = {}, rng = globalRNG) {
    this.id = id;
    this.type = type;
    this.config = config;
    this.rng = rng;
    this.threatLevel = config.threatLevel ?? THREAT_LEVELS.MEDIUM;
    this.txPowerDbm = config.txPowerDbm ?? 50.0; // EIRP in dBm (100 W)
    this.distanceKm = config.distanceKm ?? 30.0; // Standoff distance
    this.state = false;
    this.snrDb = 15.0; // Instantaneous SNR at receiver
    this.phase = this.rng.randInt(0, 19);
    this.currentBand = config.homeBand ?? 0;
    this.burstCounter = 0;
    this.burstLength = config.burstLength ?? 3;
    this.burstGap = config.burstGap ?? 7;
    this.inBurst = false;

    // Reactive / Adversarial ECCM tracking: detects if being tracked
    this.interceptCountInCurrentMode = 0;
    this.evasionTriggerCount = config.evasionTriggerCount ?? 2;

    // Spatial scan radar antenna properties
    this.rotationPeriod = config.rotationPeriod ?? 16; // Time steps for 360-deg rotation
    this.beamwidthDeg = config.beamwidthDeg ?? 35;     // 3dB Mainlobe beamwidth
    this.rxAzimuthDeg = config.rxAzimuthDeg ?? 90;     // Angle of ES receiver relative to radar
    this.currentAzimuth = config.initialAzimuth ?? this.rng.randInt(0, 359);
  }

  /**
   * Called when the ES receiver intercepts this emitter.
   * Hostile / adaptive emitters execute reactive electronic counter-countermeasures (ECCM).
   */
  onIntercepted(numBands) {
    this.interceptCountInCurrentMode++;
    if (this.type === EMITTER_TYPES.AGILE && this.interceptCountInCurrentMode >= this.evasionTriggerCount) {
      // Evasive jump: execute immediate frequency hop to evade intercept lock
      const hopOffset = this.rng.randInt(1, Math.max(1, numBands - 1));
      this.currentBand = (this.currentBand + hopOffset) % numBands;
      this.interceptCountInCurrentMode = 0;
    }
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
    this.config = config;
    this.numBands = config.numBands ?? 16;
    this.seed = config.seed ?? 42;
    this.rng = new SeededRNG(this.seed);
    this.noiseProb = config.noiseProb ?? 0.02; // CFAR thermal false alarm rate
    this.emitters = [];
    this.t = 0;
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
    let defaults = [
      // 1. Critical Threat: Missile Guidance / Fire Control Radar on Band 1
      { type: EMITTER_TYPES.PERIODIC, homeBand: 1, period: 10, duty: 0.20, threatLevel: THREAT_LEVELS.CRITICAL, txPowerDbm: 58.0, distanceKm: 25.0 },
      // 2. High Threat: Target Acquisition Periodic Radar on Band 9
      { type: EMITTER_TYPES.PERIODIC, homeBand: 9, period: 15, duty: 0.20, threatLevel: THREAT_LEVELS.HIGH, txPowerDbm: 52.0, distanceKm: 35.0 },
      // 3. Medium Threat: Early Warning S-Band 360° Rotating Radar
      { type: EMITTER_TYPES.SPATIAL_SCAN, homeBand: 4, rotationPeriod: 18, beamwidthDeg: 30, rxAzimuthDeg: 90, threatLevel: THREAT_LEVELS.MEDIUM, txPowerDbm: 60.0, distanceKm: 60.0 },
      // 4. Medium Threat: Naval Surveillance Ku-Band Search Radar
      { type: EMITTER_TYPES.SPATIAL_SCAN, homeBand: 12, rotationPeriod: 24, beamwidthDeg: 25, rxAzimuthDeg: 180, threatLevel: THREAT_LEVELS.MEDIUM, txPowerDbm: 55.0, distanceKm: 45.0 },
      // 5. Critical Threat: Reactive Frequency-Agile Countermeasure / Interrogator
      { type: EMITTER_TYPES.AGILE, hopInterval: 5, txProb: 0.65, threatLevel: THREAT_LEVELS.CRITICAL, txPowerDbm: 48.0, distanceKm: 20.0, evasionTriggerCount: 2 },
      // 6. High Threat: Multi-Channel Agile Tactical Transmitter
      { type: EMITTER_TYPES.AGILE, hopInterval: 8, txProb: 0.50, threatLevel: THREAT_LEVELS.HIGH, txPowerDbm: 45.0, distanceKm: 30.0, evasionTriggerCount: 3 },
      // 7. Low Threat: Low Probability of Intercept (LPI) Burst Telemetry
      { type: EMITTER_TYPES.BURST, homeBand: 7, burstLength: 3, burstGap: 12, threatLevel: THREAT_LEVELS.LOW, txPowerDbm: 38.0, distanceKm: 40.0 },
      // 8. Info Threat: Routine Navigation Beacon
      { type: EMITTER_TYPES.INTERMITTENT, homeBand: 14, txProb: 0.30, threatLevel: THREAT_LEVELS.INFO, txPowerDbm: 30.0, distanceKm: 50.0 },
    ];
    if (this.config.maxEmitters && this.config.maxEmitters < defaults.length) {
      defaults = defaults.slice(0, this.config.maxEmitters);
    }
    const distMult = this.config.distanceMultiplier ?? 1.0;
    defaults.forEach((cfg, i) => {
      const cfgCopy = { ...cfg, distanceKm: cfg.distanceKm * distMult };
      this.emitters.push(new Emitter(i, cfgCopy.type, cfgCopy, this.rng));
    });
  }

  /**
   * Compute Free-Space Path Loss (FSPL) and received power Prx in dBm
   * FSPL = 20*log10(d_km) + 20*log10(f_GHz) + 92.45
   */
  _computeReceivedPowerDbm(emitter, band) {
    const fGHz = RF_HARDWARE_SPECS.FREQ_MIN_GHZ + (band / this.numBands) * (RF_HARDWARE_SPECS.FREQ_MAX_GHZ - RF_HARDWARE_SPECS.FREQ_MIN_GHZ);
    const dKm = Math.max(1.0, emitter.distanceKm);
    const fspl = 20 * Math.log10(dKm) + 20 * Math.log10(fGHz) + 92.45;
    return emitter.txPowerDbm - fspl;
  }

  /**
   * Advance one discrete mission time slot (50 microseconds)
   */
  step() {
    const activity = new Array(this.numBands).fill(false);
    const snrPerBand = new Array(this.numBands).fill(-Infinity);
    const powerDbmPerBand = new Array(this.numBands).fill(-Infinity);
    const maxThreatPerBand = new Array(this.numBands).fill(0);
    const activeEmitters = [];

    this.emitters.forEach(e => {
      const { band, active } = e.step(this.t, this.numBands);
      if (active && band < this.numBands) {
        const prxDbm = this._computeReceivedPowerDbm(e, band);
        const snr = prxDbm - RF_HARDWARE_SPECS.NOISE_FLOOR_DBM;
        e.snrDb = snr;

        // Sigmoidal receiver detection sensitivity: signals below threshold have reduced intercept probability
        const pDetect = 1.0 / (1.0 + Math.exp(-(prxDbm - RF_HARDWARE_SPECS.DETECTION_THRESHOLD_DBM) / 2.0));
        const detected = this.rng.random() < pDetect;

        if (detected) {
          activity[band] = true;
          powerDbmPerBand[band] = Math.max(powerDbmPerBand[band], prxDbm);
          snrPerBand[band] = Math.max(snrPerBand[band], snr);
          maxThreatPerBand[band] = Math.max(maxThreatPerBand[band], e.threatLevel);

          activeEmitters.push({
            id: e.id,
            type: e.type,
            band,
            threatLevel: e.threatLevel,
            snrDb: snr,
            powerDbm: prxDbm,
          });
        }
      }
    });

    // Thermal noise spikes exceeding detection threshold (CFAR false alarm)
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

    return {
      activity,
      noise,
      snrPerBand,
      powerDbmPerBand,
      maxThreatPerBand,
      activeEmitters,
    };
  }

  /**
   * Called by a receiver when it dwells on a channel.
   * Informs active emitters of interception (triggers reactive evasive hopping for hostile agile threats).
   */
  notifyReceiverDwell(band) {
    this.emitters.forEach(e => {
      if (e.currentBand === band && e.state) {
        e.onIntercepted(this.numBands);
      }
    });
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
      threatLevel: e.threatLevel,
      txPowerDbm: e.txPowerDbm,
      distanceKm: e.distanceKm,
      snrDb: e.snrDb,
      config: e.config,
    }));
  }
}

