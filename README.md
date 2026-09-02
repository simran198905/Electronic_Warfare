# 📡 EW Smart Scan — Tactical Electronic Support ML Scheduler

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform: Web](https://img.shields.io/badge/Platform-HTML5%20%7C%20ES6%20%7C%20Vanilla%20CSS-green.svg)](#)
[![Algorithms](https://img.shields.io/badge/Algorithms-Periodic%20Coincidence%20%7C%20Q--Learning%20%7C%20UCB--1-purple.svg)](#)

An interactive, defense-grade simulation and telemetry platform demonstrating **Machine Learning & Reinforcement Learning algorithms for Electronic Support (ES) Receiver Spectrum Surveillance**.

---

## 🛰 Problem Context & Architecture

In modern Electronic Warfare (EW), wideband RF spectrum surveillance presents a critical resource allocation challenge:
- **The Operational Dilemma:** ES receiver hardware has limited instantaneous bandwidth and cannot dwell across all frequency channels simultaneously.
- **Traditional Limitations:** Classical open-loop raster sweeps (sequential sweeping, static priority sweeps) are rigid and easily evaded by pulse-compressed, frequency-agile, low-duty, and spatially scanning radars.
- **The Intelligent Schedulers:**
  1. **Optimal Periodic Coincidence Estimator:** Explicitly tracks pulse arrival times, estimates fundamental pulse repetition intervals ($\hat{T}_p$) and phase offsets ($\hat{\phi}_p$) via autocorrelation / inter-arrival histograms, and synchronizes receiver dwells to intercept pulses at the exact arrival epoch with minimal latency.
  2. **Q-Learning Adaptive Agent (RL):** State-action value matrix $Q(s, a)$ learning optimal channel transition sequences with temporal-difference learning (SARSAMAX), geometric $\epsilon$-greedy exploration decay, and train/eval mode separation.
  3. **UCB-1 Multi-Armed Bandit:** Upper confidence bound algorithm balancing exploration of uncertain bands against exploitation of high-activity channels.
  4. **Classical Baselines:** Sequential Raster, Static Priority (Pre-mission intel), and Uniform Random sweeps.

---

## 🎯 Complete 7 Figures of Merit (FOM)

The platform continuously evaluates all schedulers across the complete suite of defense EW metrics:

| # | Figure of Merit | Formulation | Description |
|:---|:---|:---|:---|
| **1** | **Probability of Detection ($P_d$)** | $P_d = \frac{\text{Intercepted Pulses}}{\text{Total Transmissions}}$ | Proportion of active emitter bursts intercepted by receiver. |
| **2** | **Probability of False Alarm ($P_{fa}$)** | $P_{fa} = \frac{\text{False Alarms}}{\text{Quiet Dwells}}$ | Rate of thermal noise spikes triggering detections on quiet channels. |
| **3** | **Average Intercept Rate (AIR)** | $\text{AIR} = \frac{\text{Hits}}{\text{Total Mission Steps}}$ | Overall signal throughput per time epoch. |
| **4** | **Average Intercept Time Error (AITE)** | $\text{AITE} = \frac{1}{N}\sum(t_{\text{intercept}} - t_{\text{start}})$ | Mean response lag from burst start to detection. |
| **5** | **Receiver Sensitivity (Recall)** | $\text{Sensitivity} = \frac{\text{True Positives}}{\text{True Positives} + \text{Misses}}$ | Capability to detect true presence vs. missed signals. |
| **6** | **Correct Decisions % (CPC)** | $\text{CPC} = \frac{\text{Hits} + \text{True Negatives}}{\text{Total Opportunities}} \times 100\%$ | Overall decision accuracy. |
| **7** | **Cumulative Objective Reward** | $R(t) = \sum (+1.0 \cdot \text{Hit} - 0.1 \cdot \text{Miss} - 0.05 \cdot \text{FA})$ | Reinforcement learning optimization scalar. |

---

## 🔬 Emitter & Threat Dynamics

- **Periodic Radar:** Deterministic carrier frequency and pulse repetition interval (PRI).
- **Spatial Scanning 360° Radar:** Narrow antenna beam rotating across $360^\circ$ with rotational period $T_{\text{rot}}$; intercepts occur only when mainlobe aligns with receiver azimuth.
- **Frequency-Agile Hopper:** Hopping carrier frequencies across channels to evade intercept receivers.
- **Intermittent Radar (LPI):** Low probability of intercept with stochastic pulse trains.
- **Burst Transmitter:** High-density pulse bursts with extended silent intervals.

---

## ⚡ Reproducible Headless Evaluation Harness

Run automated multi-seed, multi-band batch evaluations directly from the command line:

```bash
# Run 1000-step Monte Carlo benchmark across 5 random seeds (16 channels)
node evaluate.js --steps=1000 --seeds=5 --bands=16

# Export benchmark directly to CSV
node evaluate.js --steps=1000 --seeds=5 --bands=16 --format=csv

# Export JSON metrics
node evaluate.js --steps=1000 --seeds=5 --bands=16 --format=json
```

---

## 💾 Model Persistence & Train / Eval Separation

- **Train Mode:** Exploration rate $\epsilon$ decays geometrically ($1.0 \to 0.05$), updating Q-table weights online.
- **Evaluate Mode:** Freezes weights and sets $\epsilon = 0$ for pure deterministic policy inference.
- **Save / Load Weights:** Export learned Q-matrices to JSON files via UI buttons or API.

---

## 🚀 Browser Launch

```bash
# Launch via local server
python3 -m http.server 8080
```
Open `http://localhost:8080` in your browser, or double-click `index.html` / `index_standalone.html`.

---

## 📄 License
[MIT License](LICENSE) — Free for research, academic, and evaluation purposes.

