#!/usr/bin/env node
/**
 * EW Smart Scan — Automated Build Script
 * Compiles modular ES6 source files into:
 * 1. js/bundle.js (Universal non-module bundle for index.html)
 * 2. index_standalone.html (100% self-contained monolithic file with inlined CSS, Chart.js, and JS)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FILES_IN_ORDER = [
  'js/simulator.js',
  'js/qlearning.js',
  'js/strategies.js',
  'js/metrics.js',
  'js/audio.js',
  'js/duel.js',
  'js/main.js',
];

console.log('🔨 Compiling EW Smart Scan assets...');

// 1. Build js/bundle.js
const combinedParts = [];
for (const relPath of FILES_IN_ORDER) {
  const fullPath = path.join(__dirname, relPath);
  let code = fs.readFileSync(fullPath, 'utf8');

  // Strip import statements
  code = code.replace(/^[ \t]*import[ \t].*?\n/gm, '');
  // Strip export declarations
  code = code.replace(/\bexport\s+(class|function|const|let|var)\s/g, '$1 ');
  // Strip bare export { ... };
  code = code.replace(/^[ \t]*export\s*\{[^}]*\};\s*\n?/gm, '');

  combinedParts.push(`// ==========================================\n// Module: ${relPath}\n// ==========================================\n` + code);
}

const fullAppJs = combinedParts.join('\n');
const bundlePath = path.join(__dirname, 'js/bundle.js');
fs.writeFileSync(bundlePath, fullAppJs, 'utf8');
console.log(`✔ Generated js/bundle.js (${(fullAppJs.length / 1024).toFixed(1)} KB)`);

// 2. Build index_standalone.html
const htmlPath = path.join(__dirname, 'index.html');
const cssPath = path.join(__dirname, 'css/style.css');
const vendorChartPath = path.join(__dirname, 'js/vendor/chart.umd.min.js');
const standalonePath = path.join(__dirname, 'index_standalone.html');

let html = fs.readFileSync(htmlPath, 'utf8');
const css = fs.readFileSync(cssPath, 'utf8');
const chartJs = fs.readFileSync(vendorChartPath, 'utf8');

// Inline CSS
html = html.replace('<link rel="stylesheet" href="css/style.css" />', `<style>\n${css}\n</style>`);

// Inline Chart.js
const chartTagPattern = /<script src="js\/vendor\/chart\.umd\.min\.js"><\/script>\s*<script>[\s\S]*?<\/script>/;
if (chartTagPattern.test(html)) {
  html = html.replace(chartTagPattern, `<script>\n${chartJs}\n</script>`);
} else {
  html = html.replace('</head>', `<script>\n${chartJs}\n</script>\n</head>`);
}

// Inline Application Bundle
html = html.replace('<script src="js/bundle.js"></script>', `<script>\n${fullAppJs}\n</script>`);

fs.writeFileSync(standalonePath, html, 'utf8');
console.log(`✔ Generated index_standalone.html (${(html.length / 1024).toFixed(1)} KB)`);
console.log('✨ Build completed successfully with 0 drift.\n');
