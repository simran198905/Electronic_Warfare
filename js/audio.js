/**
 * SIGINT Audio Sonification Engine
 * Uses Web Audio API to synthesize defense electronic warfare acoustic signatures:
 * - PRF pulse buzzes & clicks for periodic radars
 * - Rotating antenna beam volume swells for spatial scanning radars
 * - Polyphonic chirp hops for frequency agile transmitters
 * - Heterodyne signal acquisition lock beeps
 * - Subtle thermal RF noise floor
 */

export class SIGINTAudioEngine {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.noiseGain = null;
    this.toneGain = null;
    this.analyser = null;
    this.enabled = false;
    this.volume = 0.4;
    this.currentBand = 0;
    this.carrierFreqs = [];
    this.noiseNode = null;
  }

  init(numBands = 16) {
    if (this.ctx) return;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) {
      console.warn('Web Audio API not supported in this browser.');
      return;
    }
    this.ctx = new AudioCtx();

    // Generate base carrier audio frequencies for each sub-band (220 Hz to 1760 Hz)
    this.carrierFreqs = Array.from({ length: numBands }, (_, i) => {
      return 220 * Math.pow(2, (i * 1.5) / numBands);
    });

    // Master Gain & Analyser
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.setValueAtTime(this.volume, this.ctx.currentTime);

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;

    this.masterGain.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);

    // Tone Sub-Bus
    this.toneGain = this.ctx.createGain();
    this.toneGain.gain.setValueAtTime(0.5, this.ctx.currentTime);
    this.toneGain.connect(this.masterGain);

    // Thermal RF Noise Floor Generator
    this._initNoiseFloor();
  }

  _initNoiseFloor() {
    if (!this.ctx) return;
    const bufferSize = this.ctx.sampleRate * 2;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * 0.04;
    }

    this.noiseNode = this.ctx.createBufferSource();
    this.noiseNode.buffer = buffer;
    this.noiseNode.loop = true;

    // Filter noise to sound like realistic receiver bandpass thermal floor
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(1000, this.ctx.currentTime);
    filter.Q.setValueAtTime(1.0, this.ctx.currentTime);

    this.noiseGain = this.ctx.createGain();
    this.noiseGain.gain.setValueAtTime(0.08, this.ctx.currentTime);

    this.noiseNode.connect(filter);
    filter.connect(this.noiseGain);
    this.noiseGain.connect(this.masterGain);

    try {
      this.noiseNode.start(0);
    } catch (e) {}
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  setMuted(muted) {
    this.enabled = !muted;
    if (!this.ctx) this.init();
    this.resume();
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setValueAtTime(this.enabled ? this.volume : 0, this.ctx.currentTime);
    }
  }

  setVolume(vol) {
    this.volume = Math.max(0, Math.min(1, vol));
    if (this.masterGain && this.ctx && this.enabled) {
      this.masterGain.gain.setValueAtTime(this.volume, this.ctx.currentTime);
    }
  }

  /**
   * Synthesize audio event when a receiver dwells on a channel
   * @param {number} band - Tuned channel index
   * @param {boolean} active - True if ground truth active transmission
   * @param {Object} [emitterMeta] - Emitter classification details
   */
  playDwellAcoustics(band, active, emitterMeta = null) {
    if (!this.enabled || !this.ctx || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    const baseFreq = this.carrierFreqs[band] || 440;

    if (!active) {
      // Quiet channel: momentary subtle click on channel switch
      this._playChannelSwitchClick(baseFreq, now);
      return;
    }

    // Active Signal Intercept Audio Synthesis
    const type = emitterMeta ? emitterMeta.type : 'periodic';

    switch (type) {
      case 'spatial_scan':
        this._playSpatialBeamSweep(baseFreq, now, emitterMeta);
        break;
      case 'agile':
        this._playAgileChirp(baseFreq, now);
        break;
      case 'burst':
      case 'intermittent':
        this._playBurstPulse(baseFreq, now);
        break;
      case 'periodic':
      default:
        this._playPeriodicPulse(baseFreq, now);
        break;
    }
  }

  /** Periodic Radar: Crisp PRF pulse train buzz */
  _playPeriodicPulse(freq, now) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(freq, now);

    // Staccato envelope
    gain.gain.setValueAtTime(0.0, now);
    gain.gain.linearRampToValueAtTime(0.35, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.07);

    osc.connect(gain);
    gain.connect(this.toneGain);

    osc.onended = () => {
      try { osc.disconnect(); gain.disconnect(); } catch (e) {}
    };

    osc.start(now);
    osc.stop(now + 0.08);
  }

  /** Spatial Scanning Radar: Volume swell imitating rotating antenna mainlobe */
  _playSpatialBeamSweep(freq, now, meta) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq * 1.25, now);

    // Sweeping amplitude envelope
    gain.gain.setValueAtTime(0.05, now);
    gain.gain.linearRampToValueAtTime(0.45, now + 0.035);
    gain.gain.linearRampToValueAtTime(0.001, now + 0.09);

    osc.connect(gain);
    gain.connect(this.toneGain);

    osc.onended = () => {
      try { osc.disconnect(); gain.disconnect(); } catch (e) {}
    };

    osc.start(now);
    osc.stop(now + 0.1);
  }

  /** Frequency Agile Hopper: Rapid frequency modulating chirp */
  _playAgileChirp(freq, now) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';

    osc.frequency.setValueAtTime(freq * 0.8, now);
    osc.frequency.exponentialRampToValueAtTime(freq * 1.6, now + 0.06);

    gain.gain.setValueAtTime(0.0, now);
    gain.gain.linearRampToValueAtTime(0.4, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.07);

    osc.connect(gain);
    gain.connect(this.toneGain);

    osc.onended = () => {
      try { osc.disconnect(); gain.disconnect(); } catch (e) {}
    };

    osc.start(now);
    osc.stop(now + 0.08);
  }

  /** Burst Emitter: Fast machine-gun pulse burst */
  _playBurstPulse(freq, now) {
    [0, 0.02, 0.04].forEach(offset => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(freq * 0.95, now + offset);

      gain.gain.setValueAtTime(0.0, now + offset);
      gain.gain.linearRampToValueAtTime(0.25, now + offset + 0.003);
      gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.015);

      osc.connect(gain);
      gain.connect(this.toneGain);

      osc.onended = () => {
        try { osc.disconnect(); gain.disconnect(); } catch (e) {}
      };

      osc.start(now + offset);
      osc.stop(now + offset + 0.02);
    });
  }

  /** Channel Switch / Dial Click */
  _playChannelSwitchClick(freq, now) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq * 0.5, now);

    gain.gain.setValueAtTime(0.06, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.015);

    osc.connect(gain);
    gain.connect(this.toneGain);

    osc.onended = () => {
      try { osc.disconnect(); gain.disconnect(); } catch (e) {}
    };

    osc.start(now);
    osc.stop(now + 0.02);
  }

  /** Hit Feedback: High chime confirmation */
  playAcquisitionLock(now = null) {
    if (!this.enabled || !this.ctx) return;
    const t = now || this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1320, t);
    osc.frequency.setValueAtTime(1760, t + 0.03);

    gain.gain.setValueAtTime(0.2, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);

    osc.connect(gain);
    gain.connect(this.masterGain);

    osc.onended = () => {
      try { osc.disconnect(); gain.disconnect(); } catch (e) {}
    };

    osc.start(t);
    osc.stop(t + 0.09);
  }

  /** Get Frequency Domain Waveform Data for Live Oscilloscope */
  getWaveformData() {
    if (!this.analyser) return new Uint8Array(128);
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteTimeDomainData(data);
    return data;
  }
}

export const globalAudio = new SIGINTAudioEngine();
