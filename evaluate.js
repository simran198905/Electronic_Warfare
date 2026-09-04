/**
 * Headless Batch Evaluation Harness for EW Smart Scan
 *
 * Runs Monte Carlo multi-seed batch simulations across all 7 Figures of Merit:
 * 1. Pd (Probability of Detection)
 * 2. Pfa (Probability of False Alarm)
 * 3. AIR (Average Intercept Rate)
 * 4. AITE (Average Intercept Time Error / Detection Latency)
 * 5. Sensitivity (True Positive Rate / Recall)
 * 6. CPC (Percentage of Correct Decisions / Dwell Accuracy)
 * 7. Cumulative Objective & Threat-Weighted Reward Scores
 *
 * Plus:
 * - Hardware Retune Latency & Dwell Efficiency
 * - Per-Emitter-Type Intercept Breakdown (Periodic, Spatial Scan, Reactive Agile, Burst)
 * - Forward-Looking Intercept Prediction Validation
 * - Parameter Stress/Scalability Sweeps (--sweep=bands|snr|threats)
 *
 * Usage:
 *   node evaluate.js [--steps=1000] [--seeds=5] [--bands=16] [--format=table|csv|json]
 *   node evaluate.js --sweep=bands
 *   node evaluate.js --sweep=snr
 *   node evaluate.js --sweep=threats
 */

import { RFEnvironment, RF_HARDWARE_SPECS } from './js/simulator.js';
import { createAllStrategies } from './js/strategies.js';
import { MetricsTracker } from './js/metrics.js';

// Parse CLI options
const args = process.argv.slice(2);
function getArg(key, def) {
  const match = args.find(a => a.startsWith(`--${key}=`));
  return match ? match.split('=')[1] : def;
}

const STEPS = parseInt(getArg('steps', '1000'), 10);
const NUM_SEEDS = parseInt(getArg('seeds', '5'), 10);
const NUM_BANDS = parseInt(getArg('bands', '16'), 10);
const FORMAT = getArg('format', 'table');
const SWEEP = getArg('sweep', null);
const SEEDS = [42, 1337, 2026, 777, 9999].slice(0, NUM_SEEDS);

function stats(arr) {
  if (!arr || arr.length === 0) return { mean: 0, std: 0 };
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const std = Math.sqrt(arr.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / Math.max(1, arr.length - 1));
  return { mean, std };
}

/**
 * Execute Monte Carlo evaluation for a specific configuration
 */
function runMonteCarlo(numBands, steps, seeds, envConfigOverride = {}) {
  const aggregatedResults = {};
  const emitterBreakdowns = {};
  const predictionStats = [];

  for (const seed of seeds) {
    const env = new RFEnvironment({ numBands, seed, ...envConfigOverride });
    const strategies = createAllStrategies(numBands, seed);
    const metrics = strategies.map(s => new MetricsTracker(s.name, s.color));

    for (let t = 0; t < steps; t++) {
      const envResult = env.step();
      const { activity, noise } = envResult;

      strategies.forEach((strat, i) => {
        const band = strat.selectBand(t);
        env.notifyReceiverDwell(band);
        const reward = metrics[i].record(band, activity, t, noise, envResult);
        strat.update(band, reward, activity, t, envResult);
      });

      // Sample forward-looking predictions at midpoint
      if (t === Math.floor(steps / 2)) {
        const qStrat = strategies.find(s => s.name.includes('Q-Learning'));
        const pStrat = strategies.find(s => s.name.includes('Periodic'));
        const wStrat = strategies.find(s => s.name.includes('Whittle'));
        if (qStrat && qStrat.agent.predictNextIntercepts) {
          const qPred = qStrat.agent.predictNextIntercepts(10);
          const pPred = pStrat ? pStrat.estimator.predictNextIntercepts(10) : null;
          const wPred = wStrat ? wStrat.agent.predictNextIntercepts(10) : null;
          predictionStats.push({ seed, qPred, pPred, wPred });
        }
      }
    }

    strategies.forEach((strat, i) => {
      const summary = metrics[i].getSummary();
      if (!aggregatedResults[strat.name]) {
        aggregatedResults[strat.name] = {
          name: strat.name,
          pd: [],
          pfa: [],
          air: [],
          aite: [],
          sensitivity: [],
          cpc: [],
          reward: [],
          threatReward: [],
          retuneEfficiency: [],
          pdByType: {},
        };
      }
      aggregatedResults[strat.name].pd.push(summary.pd);
      aggregatedResults[strat.name].pfa.push(summary.pfa);
      aggregatedResults[strat.name].air.push(summary.avgInterceptRate);
      aggregatedResults[strat.name].aite.push(summary.avgInterceptTimeError);
      aggregatedResults[strat.name].sensitivity.push(summary.sensitivity);
      aggregatedResults[strat.name].cpc.push(summary.cpc);
      aggregatedResults[strat.name].reward.push(summary.cumulativeReward);
      aggregatedResults[strat.name].threatReward.push(summary.threatWeightedReward);
      aggregatedResults[strat.name].retuneEfficiency.push(summary.retuneEfficiency);

      // Per-emitter breakdown
      for (const [type, pdVal] of Object.entries(summary.pdByType)) {
        if (!aggregatedResults[strat.name].pdByType[type]) {
          aggregatedResults[strat.name].pdByType[type] = [];
        }
        aggregatedResults[strat.name].pdByType[type].push(pdVal);
      }
    });
  }

  return { aggregatedResults, predictionStats };
}

// ─── SWEEP RUNNER ─────────────────────────────────────────────────────────────
if (SWEEP) {
  console.log(`================================================================================`);
  console.log(`📡 EW SMART SCAN — SYSTEM PARAMETER STRESS & SCALABILITY SWEEP: ${SWEEP.toUpperCase()}`);
  console.log(`================================================================================\n`);

  if (SWEEP === 'bands') {
    const bandCounts = [8, 16, 32, 64];
    console.log(`Sweeping Spectrum Bandwidth: [${bandCounts.join(', ')}] Channels\n`);
    bandCounts.forEach(nb => {
      console.log(`\n--- Channel Count: ${nb} Bands ---`);
      const { aggregatedResults } = runMonteCarlo(nb, 400, [42, 1337]);
      console.log(`| Strategy | Pd (%) | AIR (%) | AITE (steps) | Threat Rew | Retune Eff |`);
      console.log(`|:---|:---:|:---:|:---:|:---:|:---:|`);
      Object.values(aggregatedResults).forEach(r => {
        const pdS = stats(r.pd);
        const airS = stats(r.air);
        const aiteS = stats(r.aite);
        const trS = stats(r.threatReward);
        const reS = stats(r.retuneEfficiency);
        console.log(`| ${r.name.padEnd(28)} | ${(pdS.mean * 100).toFixed(1).padStart(5)}% | ${(airS.mean * 100).toFixed(1).padStart(5)}% | ${aiteS.mean.toFixed(2).padStart(6)} | ${trS.mean.toFixed(1).padStart(6)} | ${(reS.mean).toFixed(1).padStart(5)}% |`);
      });
    });
  } else if (SWEEP === 'snr') {
    const distances = [15.0, 30.0, 60.0, 100.0];
    console.log(`Sweeping Standoff Distance (Degraded SNR): [${distances.map(d => d + ' km').join(', ')}]\n`);
    distances.forEach(dist => {
      console.log(`\n--- Standoff Distance: ${dist} km ---`);
      const { aggregatedResults } = runMonteCarlo(16, 400, [42, 1337], { distanceMultiplier: dist / 30.0 });
      console.log(`| Strategy | Pd (%) | Threat Rew | Retune Eff |`);
      console.log(`|:---|:---:|:---:|:---:|`);
      Object.values(aggregatedResults).forEach(r => {
        const pdS = stats(r.pd);
        const trS = stats(r.threatReward);
        const reS = stats(r.retuneEfficiency);
        console.log(`| ${r.name.padEnd(28)} | ${(pdS.mean * 100).toFixed(1).padStart(5)}% | ${trS.mean.toFixed(1).padStart(6)} | ${(reS.mean).toFixed(1).padStart(5)}% |`);
      });
    });
  } else if (SWEEP === 'threats') {
    const threatDensities = ['Sparser (4 Threats)', 'Standard (8 Threats)', 'Dense (12 Threats)'];
    console.log(`Sweeping Spectrum Emitter Threat Density\n`);
    [4, 8, 12].forEach((count, idx) => {
      console.log(`\n--- Scenario: ${threatDensities[idx]} ---`);
      const { aggregatedResults } = runMonteCarlo(16, 400, [42, 1337], { maxEmitters: count });
      console.log(`| Strategy | Pd (%) | Threat Rew | Retune Eff |`);
      console.log(`|:---|:---:|:---:|:---:|`);
      Object.values(aggregatedResults).forEach(r => {
        const pdS = stats(r.pd);
        const trS = stats(r.threatReward);
        const reS = stats(r.retuneEfficiency);
        console.log(`| ${r.name.padEnd(28)} | ${(pdS.mean * 100).toFixed(1).padStart(5)}% | ${trS.mean.toFixed(1).padStart(6)} | ${(reS.mean).toFixed(1).padStart(5)}% |`);
      });
    });
  }

  console.log(`\n✔ Parameter sweep complete.`);
  process.exit(0);
}

// ─── STANDARD BATCH EVALUATION ────────────────────────────────────────────────
console.log(`================================================================================`);
console.log(`📡 EW SMART SCAN — RIGOROUS HEADLESS BENCHMARK & EVALUATION HARNESS`);
console.log(`================================================================================`);
console.log(`Hardware Specs : ${RF_HARDWARE_SPECS.FREQ_MIN_GHZ}–${RF_HARDWARE_SPECS.FREQ_MAX_GHZ} GHz | ${RF_HARDWARE_SPECS.DWELL_TIME_US} µs Dwell | ${RF_HARDWARE_SPECS.RETUNE_LATENCY_PER_HOP_US} µs Retune/Hop`);
console.log(`Receiver Specs : Noise Floor ${RF_HARDWARE_SPECS.NOISE_FLOOR_DBM} dBm | Sensitivity Threshold ${RF_HARDWARE_SPECS.DETECTION_THRESHOLD_DBM} dBm`);
console.log(`Run Config     : ${NUM_BANDS} Channels | ${STEPS} Steps/Run | ${SEEDS.length} Random Seeds (${SEEDS.join(', ')})`);
console.log(`--------------------------------------------------------------------------------\n`);

const { aggregatedResults, predictionStats } = runMonteCarlo(NUM_BANDS, STEPS, SEEDS);

const finalRows = Object.values(aggregatedResults).map(r => {
  const pdS = stats(r.pd);
  const pfaS = stats(r.pfa);
  const airS = stats(r.air);
  const aiteS = stats(r.aite);
  const sensS = stats(r.sensitivity);
  const cpcS = stats(r.cpc);
  const rewS = stats(r.reward);
  const trS = stats(r.threatReward);
  const reS = stats(r.retuneEfficiency);

  return {
    strategy: r.name,
    pd: `${(pdS.mean * 100).toFixed(1)}% (±${(pdS.std * 100).toFixed(1)}%)`,
    pfa: `${(pfaS.mean * 100).toFixed(2)}% (±${(pfaS.std * 100).toFixed(2)}%)`,
    air: `${(airS.mean * 100).toFixed(1)}% (±${(airS.std * 100).toFixed(1)}%)`,
    aite: `${aiteS.mean.toFixed(2)} (±${aiteS.std.toFixed(2)})`,
    sensitivity: `${(sensS.mean * 100).toFixed(1)}% (±${(sensS.std * 100).toFixed(1)}%)`,
    cpc: `${cpcS.mean.toFixed(1)}% (±${cpcS.std.toFixed(1)}%)`,
    reward: `${rewS.mean.toFixed(1)} (±${rewS.std.toFixed(1)})`,
    threatReward: `${trS.mean.toFixed(1)} (±${trS.std.toFixed(1)})`,
    retuneEff: `${reS.mean.toFixed(1)}% (±${reS.std.toFixed(1)}%)`,
  };
});

if (FORMAT === 'csv') {
  console.log(`Strategy,Pd,Pfa,AIR,AITE,Sensitivity,CPC,Reward,ThreatReward,RetuneEff`);
  finalRows.forEach(r => {
    console.log(`"${r.strategy}","${r.pd}","${r.pfa}","${r.air}","${r.aite}","${r.sensitivity}","${r.cpc}","${r.reward}","${r.threatReward}","${r.retuneEff}"`);
  });
} else if (FORMAT === 'json') {
  console.log(JSON.stringify({ figuresOfMerit: finalRows, aggregated: aggregatedResults }, null, 2));
} else {
  // Primary Figures of Merit Table
  console.log(`📊 CORE FIGURES OF MERIT (FoMs) ACROSS SEEDS:`);
  console.log(`| Strategy | Pd (%) | Pfa (%) | AIR (%) | AITE (steps) | Sensitivity | CPC (%) | Threat Reward | Retune Eff |`);
  console.log(`|:---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|`);
  finalRows.forEach(r => {
    console.log(`| ${r.strategy.padEnd(28)} | ${r.pd.padEnd(14)} | ${r.pfa.padEnd(15)} | ${r.air.padEnd(14)} | ${r.aite.padEnd(14)} | ${r.sensitivity.padEnd(14)} | ${r.cpc.padEnd(14)} | ${r.threatReward.padEnd(14)} | ${r.retuneEff.padEnd(10)} |`);
  });

  // Per-Emitter-Type Breakdown Table
  console.log(`\n🎯 PER-EMITTER-TYPE INTERCEPT BREAKDOWN (Pd %):`);
  console.log(`| Strategy | Periodic Radar | Spatial Scan | Reactive Agile | LPI Burst |`);
  console.log(`|:---|:---:|:---:|:---:|:---:|`);
  Object.values(aggregatedResults).forEach(r => {
    const periodic = stats(r.pdByType['periodic']);
    const spatial = stats(r.pdByType['spatial_scan']);
    const agile = stats(r.pdByType['agile']);
    const burst = stats(r.pdByType['burst']);

    const pStr = `${(periodic.mean).toFixed(1)}%`;
    const sStr = `${(spatial.mean).toFixed(1)}%`;
    const aStr = `${(agile.mean).toFixed(1)}%`;
    const bStr = `${(burst.mean).toFixed(1)}%`;

    console.log(`| ${r.name.padEnd(28)} | ${pStr.padEnd(14)} | ${sStr.padEnd(12)} | ${aStr.padEnd(14)} | ${bStr.padEnd(9)} |`);
  });

  // Forward-Looking Intercept Prediction Summary
  if (predictionStats.length > 0) {
    console.log(`\n🔮 FORWARD-LOOKING PREDICTION ENGINE VALIDATION (Sampled at t = ${Math.floor(STEPS / 2)}):`);
    const sample = predictionStats[0];
    if (sample.qPred) {
      console.log(`  • Q-Learning RL Projected Ratio : ${(sample.qPred.predictedInterceptionRatio * 100).toFixed(1)}% | Top Candidates: [Bands ${sample.qPred.topCandidates.map(c => c.band).join(', ')}]`);
    }
    if (sample.wPred) {
      console.log(`  • Whittle RMAB Projected Ratio  : ${(sample.wPred.predictedInterceptionRatio * 100).toFixed(1)}% | Top Candidates: [Bands ${sample.wPred.topCandidates.map(c => c.band).join(', ')}]`);
    }
    if (sample.pPred && sample.pPred.predictions.length > 0) {
      const pTop = sample.pPred.predictions[0];
      console.log(`  • Periodic Tracker Forecast    : Next pulse due in ${pTop.timeToNextIntercept} steps on Band ${pTop.band} (Period T=${pTop.period}, Conf=${(pTop.confidence * 100).toFixed(0)}%)`);
    }
  }
}

console.log(`\n✔ Headless benchmark evaluation finished successfully.`);
