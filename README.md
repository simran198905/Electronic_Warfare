# 📡 EW Smart Scan — Tactical Electronic Warfare ML Scheduler

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform: Web](https://img.shields.io/badge/Platform-HTML5%20%7C%20ES6%20%7C%20Vanilla%20CSS-green.svg)](#)
[![Algorithm: Reinforcement Learning](https://img.shields.io/badge/Algorithms-Q--Learning%20%7C%20UCB--1%20Bandit-purple.svg)](#)

An interactive, defense-grade simulation and telemetry platform demonstrating **Machine Learning & Reinforcement Learning algorithms for Electronic Support (ES) Receiver Spectrum Surveillance**.

---

## 🛰 Overview

In modern Electronic Warfare (EW), wideband RF spectrum surveillance presents a critical resource allocation challenge:
- **The Problem:** Receiver hardware has limited instantaneous bandwidth and cannot dwell across all frequency channels simultaneously.
- **Traditional Limitation:** Classical open-loop raster sweeps (e.g. sequential or static priority sweeps) are rigid and easily evaded by pulse-compressed, frequency-agile, and low-probability-of-intercept (LPI) radars.
- **The ML Solution:** Closed-loop **Q-Learning** and **Upper Confidence Bound (UCB-1 Multi-Armed Bandit)** agents learn emitter transmission cycles, frequency-hopping behavior, and burst patterns in real-time to optimize dwell timing and maximize the **Probability of Detection ($P_d$)**.

---

## ⚡ Key Features

- **Tactical Mission Console:** Real-time mission clock, engine state, active RF channel selection (8, 16, or 32 channels), and playback rate controls.
- **Live RF Spectrum Waterfall:** 2D Time × Frequency raster visualizer displaying active emitter energy pulses and live receiver tuning cursors.
- **Closed-Loop Schedulers:**
  - **Q-Learning Agent (RL):** State-action value matrix $Q(s, a)$ learning optimal channel transition sequences based on hit/miss rewards with $\epsilon$-greedy exploration decay.
  - **UCB-1 Multi-Armed Bandit:** Balances exploration of uncertain bands with exploitation of high-activity channels.
  - **Sequential Raster (Baseline):** Open-loop cyclical channel sweep.
  - **Priority Sweep:** Fixed pre-mission intelligence weighting.
  - **Uniform Random:** Stochastic baseline.
- **Figures of Merit & Telemetry:** Real-time computation of $P_d$ (Probability of Detection), $P_{fa}$ (False Alarm Rate), Average Intercept Rate (AIR), and Mean Intercept Latency (AITE).
- **Threat Simulation Environment:** Configurable emitter registry supporting Periodic radars, Frequency-Agile hoppers, Intermittent transmitters, and Burst emitters.
- **Zero Dependencies / Standalone:** Pure HTML5, ES6 JavaScript, and Vanilla CSS with Chart.js.

---

## 🚀 Quick Start

### Option 1: Direct Browser Launch
Open `index.html` or `index_standalone.html` directly in any modern browser (Chrome, Safari, Firefox, Edge).

### Option 2: Local Static Server
```bash
# Using Python
python3 -m http.server 8080

# Using Node.js
npx serve .
```
Navigate to `http://localhost:8080` in your web browser.

---

## 📁 Repository Structure

```
├── index.html               # Main modular application UI
├── index_standalone.html    # Standalone single-file bundle
├── css/
│   └── style.css            # Tactical defense design system & layout
├── js/
│   ├── main.js              # Simulation orchestrator & UI bindings
│   ├── simulator.js         # Multi-band RF environment & emitter simulator
│   ├── strategies.js        # Schedulers (Sequential, Priority, UCB, Q-Learning)
│   ├── qlearning.js         # Q-Learning & UCB bandit RL agents
│   └── metrics.js           # Figures of merit telemetry tracker
└── README.md
```

---

## 📊 Figures of Merit Formulations

- **Probability of Detection ($P_d$):**
  $$P_d = \frac{\text{Intercepted Pulses}}{\text{Total Emitter Transmissions}}$$
- **Average Intercept Time Error (AITE):**
  $$\text{AITE} = \frac{1}{N} \sum (t_{\text{intercept}} - t_{\text{emission\_start}})$$
- **RL Reward Function:**
  $$R(t) = +1.0 \cdot \text{Hit} - 0.1 \cdot \text{Missed Active} + 0.0 \cdot \text{Quiet}$$

---

## 📄 License
MIT License. Free for academic, defense research, and educational use.
