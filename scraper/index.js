#!/usr/bin/env node
/**
 * Main scraper entry point. Runs discover + update in sequence.
 * Usage: node scraper/index.js
 */

const { execSync } = require('child_process');
const path = require('path');

console.log('═══════════════════════════════════════');
console.log('  🏃 ParkRun Dashboard Scraper');
console.log('═══════════════════════════════════════\n');

const scriptsDir = __dirname;

// Step 1: Discover new athletes
console.log('Step 1: Discovering athletes...\n');
try {
  execSync(`node ${path.join(scriptsDir, 'discover.js')}`, { stdio: 'inherit' });
} catch (err) {
  console.error('Discovery failed, continuing with existing config...');
}

console.log('\n───────────────────────────────────────\n');

// Step 2: Update all athlete data
console.log('Step 2: Updating athlete data...\n');
try {
  execSync(`node ${path.join(scriptsDir, 'update.js')}`, { stdio: 'inherit' });
} catch (err) {
  console.error('Update failed:', err.message);
  process.exit(1);
}

console.log('\n═══════════════════════════════════════');
console.log('  ✅ Scraping complete!');
console.log('═══════════════════════════════════════');
