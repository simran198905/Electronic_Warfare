/**
 * Headless Batch Evaluation Harness for EW Smart Scan
 *
 * Runs Monte Carlo multi-seed batch simulations across all 7 Figures of Merit:
 * 1. Pd (Probability of Detection)
 * 2. Pfa (Probability of False Alarm)
 * 3. AIR (Average Intercept Rate)
 * 4. AITE (Average Intercept Time Error / Detection Latency)
 * 5. Sensitivity (True Positive Rate / Recall)
 * 6. CPC (Percentage of Correct Decisions)
 * 7. Cumulative Objective Reward Score
 *
 * Usage:
 *   node evaluate.js [--steps=1000] [--seeds=5] [--bands=16] [--format=table|csv|json]
 */

import { RFEnvironment } from './js/simulator.js';
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
const SEEDS = [42, 1337, 2026, 777, 9999].slice(0, NUM_SEEDS);

console.log(`================================================================================`);
console.log(`📡 EW SMART SCAN — HEADLESS BATCH EVALUATION HARNESS`);
console.log(`================================================================================`);
console.log(`Configuration: ${NUM_BANDS} Channels | ${STEPS} Steps/Run | ${SEEDS.length} Random Seeds (${SEEDS.join(', ')})`);
console.log(`--------------------------------------------------------------------------------\n`);

// Run evaluation across all seeds
const aggregatedResults = {};

for (const seed of SEEDS) {
  const env = new RFEnvironment({ numBands: NUM_BANDS, seed });
  const strategies = createAllStrategies(NUM_BANDS, seed);
  const metrics = strategies.map(s => new MetricsTracker(s.name, s.color));

  for (let t = 0; t < STEPS; t++) {
    const { activity, noise } = env.step();
    strategies.forEach((strat, i) => {
      const band = strat.selectBand(t);
      const reward = metrics[i].record(band, activity, t, noise);
      strat.update(band, reward, activity, t);
    });
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
      };
    }
    aggregatedResults[strat.name].pd.push(summary.pd);
    aggregatedResults[strat.name].pfa.push(summary.pfa);
    aggregatedResults[strat.name].air.push(summary.avgInterceptRate);
    aggregatedResults[strat.name].aite.push(summary.avgInterceptTimeError);
    aggregatedResults[strat.name].sensitivity.push(summary.sensitivity);
    aggregatedResults[strat.name].cpc.push(summary.cpc);
    aggregatedResults[strat.name].reward.push(summary.cumulativeReward);
  });
}

function stats(arr) {
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const std = Math.sqrt(arr.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / Math.max(1, arr.length - 1));
  return { mean, std };
}

const finalRows = Object.values(aggregatedResults).map(r => {
  const pdS = stats(r.pd);
  const pfaS = stats(r.pfa);
  const airS = stats(r.air);
  const aiteS = stats(r.aite);
  const sensS = stats(r.sensitivity);
  const cpcS = stats(r.cpc);
  const rewS = stats(r.reward);

  return {
    strategy: r.name,
    pd: `${(pdS.mean * 100).toFixed(1)}% (±${(pdS.std * 100).toFixed(1)}%)`,
    pfa: `${(pfaS.mean * 100).toFixed(2)}% (±${(pfaS.std * 100).toFixed(2)}%)`,
    air: `${(airS.mean * 100).toFixed(1)}% (±${(airS.std * 100).toFixed(1)}%)`,
    aite: `${aiteS.mean.toFixed(2)} (±${aiteS.std.toFixed(2)})`,
    sensitivity: `${(sensS.mean * 100).toFixed(1)}% (±${(sensS.std * 100).toFixed(1)}%)`,
    cpc: `${cpcS.mean.toFixed(1)}% (±${cpcS.std.toFixed(1)}%)`,
    reward: `${rewS.mean.toFixed(1)} (±${rewS.std.toFixed(1)})`,
  };
});

if (FORMAT === 'csv') {
  console.log(`Strategy,Pd,Pfa,AIR,AITE,Sensitivity,CPC,Reward`);
  finalRows.forEach(r => {
    console.log(`"${r.strategy}","${r.pd}","${r.pfa}","${r.air}","${r.aite}","${r.sensitivity}","${r.cpc}","${r.reward}"`);
  });
} else if (FORMAT === 'json') {
  console.log(JSON.stringify(finalRows, null, 2));
} else {
  // Formatted ASCII / Markdown table
  console.log(`| Strategy | Pd (%) | Pfa (%) | AIR (%) | AITE (steps) | Sensitivity | CPC (%) | Reward |`);
  console.log(`|:---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|`);
  finalRows.forEach(r => {
    console.log(`| ${r.strategy.padEnd(30)} | ${r.pd.padEnd(14)} | ${r.pfa.padEnd(15)} | ${r.air.padEnd(14)} | ${r.aite.padEnd(14)} | ${r.sensitivity.padEnd(14)} | ${r.cpc.padEnd(14)} | ${r.reward.padEnd(14)} |`);
  });
}

console.log(`\n✔ Headless evaluation finished successfully.`);
