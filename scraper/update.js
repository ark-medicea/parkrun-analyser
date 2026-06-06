#!/usr/bin/env node
/**
 * Update athlete results by scraping their individual parkrun history pages.
 * Reads athlete IDs from config.json, scrapes each, saves to data/athletes.json.
 *
 * Usage: node scraper/update.js
 */

const fs = require('fs');
const path = require('path');
const { createBrowser, navigateWithRetry } = require('./browser');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const DATA_PATH = path.join(__dirname, '..', 'data', 'athletes.json');

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));

// Load existing data if present
let existingData = { athletes: [] };
if (fs.existsSync(DATA_PATH)) {
  existingData = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
}

async function scrapeAthleteHistory(page, athleteId) {
  const url = `https://www.parkrun.org.uk/parkrunner/${athleteId}/all/`;
  console.log(`\n📊 Scraping athlete ${athleteId}...`);

  await navigateWithRetry(page, url, { waitSelector: 'table, .Results' });

  const data = await page.evaluate(() => {
    // Extract athlete name from page header
    const nameEl = document.querySelector('h2, .Results-header h2, [data-testid="athlete-name"]');
    const name = nameEl ? nameEl.textContent.trim() : 'Unknown';

    // Extract summary stats
    const statsText = document.body.innerText;
    const totalRunsMatch = statsText.match(/(\d+)\s*(?:parkruns?|runs?)/i);
    const totalRuns = totalRunsMatch ? parseInt(totalRunsMatch[1]) : 0;

    // Extract age group
    const ageGroupEl = document.querySelector('.Results--ageGroup, [data-testid="age-group"]');
    const ageGroup = ageGroupEl ? ageGroupEl.textContent.trim() : '';

    // Extract gender from age group
    const gender = ageGroup.startsWith('V') ?
      (ageGroup.includes('W') ? 'F' : 'M') :
      (ageGroup.startsWith('S') ?
        (ageGroup.includes('W') ? 'F' : 'M') : '');

    // Extract all results from the table
    const rows = document.querySelectorAll('table tbody tr, .Results-table-row');
    const results = [];

    rows.forEach(row => {
      const cells = row.querySelectorAll('td, .Results-table-td');
      if (cells.length < 4) return;

      // parkrun results table columns vary, try to extract intelligently
      const eventEl = cells[0]?.querySelector('a');
      const event = eventEl ? eventEl.textContent.trim().toLowerCase().replace(/\s+/g, '') : '';
      const dateText = cells[1]?.textContent.trim() || '';
      const timeText = cells[3]?.textContent.trim() || '';
      const posText = cells[2]?.textContent.trim() || '';
      const ageGradeText = cells[5]?.textContent.trim() || '';

      // Parse date (DD/MM/YYYY → YYYY-MM-DD)
      const dateMatch = dateText.match(/(\d{2})\/(\d{2})\/(\d{4})/);
      const date = dateMatch ? `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}` : dateText;

      // Parse time (MM:SS or HH:MM:SS)
      const timeParts = timeText.split(':').map(Number);
      let timeSeconds = 0;
      if (timeParts.length === 3) {
        timeSeconds = timeParts[0] * 3600 + timeParts[1] * 60 + timeParts[2];
      } else if (timeParts.length === 2) {
        timeSeconds = timeParts[0] * 60 + timeParts[1];
      }

      // Parse age grade
      const ageGrade = parseFloat(ageGradeText.replace('%', '')) || 0;

      // Parse position
      const position = parseInt(posText) || 0;

      if (date && timeSeconds > 0) {
        results.push({
          date,
          event: event || 'unknown',
          time: timeText,
          timeSeconds,
          position,
          ageGrade,
          isPB: false, // Will recalculate
        });
      }
    });

    return { name, totalRuns, ageGroup, gender, results };
  });

  // Recalculate PBs
  let bestTime = Infinity;
  // Sort oldest first to calculate PBs chronologically
  data.results.sort((a, b) => a.date.localeCompare(b.date));
  for (const r of data.results) {
    if (r.timeSeconds < bestTime) {
      bestTime = r.timeSeconds;
      r.isPB = true;
    }
  }

  return {
    id: athleteId,
    name: data.name,
    gender: data.gender,
    ageGroup: data.ageGroup,
    totalRuns: data.totalRuns,
    pb: bestTime < Infinity ? data.results.find(r => r.timeSeconds === bestTime)?.time : '',
    pbSeconds: bestTime < Infinity ? bestTime : 0,
    bestAgeGrade: Math.max(...data.results.map(r => r.ageGrade), 0),
    currentStreak: calculateStreak(data.results),
    results: data.results,
  };
}

function calculateStreak(results) {
  if (results.length === 0) return 0;

  // Sort newest first
  const sorted = [...results].sort((a, b) => b.date.localeCompare(a.date));

  // Check consecutive Saturdays
  let streak = 0;
  let expectedDate = getLastSaturday();

  for (const r of sorted) {
    if (r.date === expectedDate) {
      streak++;
      expectedDate = getPreviousSaturday(expectedDate);
    } else if (r.date < expectedDate) {
      // Missed a week
      break;
    }
  }

  return streak;
}

function getLastSaturday() {
  const d = new Date();
  const day = d.getDay();
  const diff = day === 6 ? 0 : day + 1;
  d.setDate(d.getDate() - diff);
  return d.toISOString().split('T')[0];
}

function getPreviousSaturday(dateStr) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() - 7);
  return d.toISOString().split('T')[0];
}

async function main() {
  if (config.athletes.length === 0) {
    console.log('No athletes configured. Run `npm run scrape:discover` first.');
    process.exit(1);
  }

  console.log(`🏃 Updating ${config.athletes.length} athletes from ${config.event} parkrun\n`);

  const { browser, context } = await createBrowser();

  try {
    const page = await context.newPage();
    const athletes = [];

    for (const athlete of config.athletes) {
      try {
        const data = await scrapeAthleteHistory(page, athlete.id);
        athletes.push(data);
        console.log(`  ✅ ${data.name}: ${data.totalRuns} runs, PB ${data.pb}`);
      } catch (err) {
        console.error(`  ❌ Failed to scrape ${athlete.name || athlete.id}: ${err.message}`);
        // Keep existing data if available
        const existing = existingData.athletes?.find(a => a.id === athlete.id);
        if (existing) {
          athletes.push(existing);
          console.log(`  ↩ Using cached data for ${athlete.name || athlete.id}`);
        }
      }
      // Be nice to the server
      await page.waitForTimeout(3000);
    }

    // Also scrape latest results to get position/totalRunners context
    await scrapeLatestResults(page, athletes);

    // Write output
    const output = {
      _meta: {
        generated: new Date().toISOString(),
        sampleData: false,
      },
      event: config.event,
      lastUpdated: getLastSaturday(),
      athletes,
    };

    fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
    fs.writeFileSync(DATA_PATH, JSON.stringify(output, null, 2));
    console.log(`\n✨ Data saved to ${DATA_PATH}`);
    console.log(`   ${athletes.length} athletes, ${athletes.reduce((s, a) => s + a.results.length, 0)} total results`);

  } finally {
    await browser.close();
  }
}

async function scrapeLatestResults(page, athletes) {
  try {
    const url = `https://www.parkrun.org.uk/${config.event}/results/latestresults/`;
    await navigateWithRetry(page, url, { waitSelector: 'table' });

    const totalRunners = await page.evaluate(() => {
      const rows = document.querySelectorAll('table tbody tr');
      return rows.length;
    });

    // Update totalRunners for athletes who ran this week
    const lastSat = getLastSaturday();
    for (const athlete of athletes) {
      const thisWeekResult = athlete.results?.find(r => r.date === lastSat && r.event === config.event);
      if (thisWeekResult) {
        thisWeekResult.totalRunners = totalRunners;
      }
    }
  } catch (err) {
    console.warn('⚠ Could not scrape latest results:', err.message);
  }
}

main().catch(err => {
  console.error('❌ Update failed:', err.message);
  process.exit(1);
});
