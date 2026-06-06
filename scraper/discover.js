#!/usr/bin/env node
/**
 * Discover athletes by surname from Cassiobury parkrun results pages.
 * Scrapes recent weeks of results and filters by configured surnames.
 *
 * Usage: node scraper/discover.js [--weeks=4]
 */

const fs = require('fs');
const path = require('path');
const { createBrowser, navigateWithRetry } = require('./browser');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));

const weeksArg = process.argv.find(a => a.startsWith('--weeks='));
const WEEKS_TO_CHECK = weeksArg ? parseInt(weeksArg.split('=')[1]) : 4;

async function getRecentResultsDates(page) {
  const url = `https://www.parkrun.org.uk/${config.event}/results/eventhistory/`;
  await navigateWithRetry(page, url, { waitSelector: 'table' });

  const dates = await page.evaluate(() => {
    const links = document.querySelectorAll('table a[href*="/results/"]');
    return Array.from(links)
      .map(a => {
        const match = a.href.match(/results\/(\d+)\//);
        return match ? match[1] : null;
      })
      .filter(Boolean)
      .slice(0, 8); // Last 8 events
  });

  return dates;
}

async function scrapeResultsPage(page, eventNumber) {
  const url = `https://www.parkrun.org.uk/${config.event}/results/${eventNumber}/`;
  console.log(`\nScraping event #${eventNumber}...`);

  await navigateWithRetry(page, url, { waitSelector: 'table' });

  const results = await page.evaluate((surnames) => {
    const rows = document.querySelectorAll('table tbody tr, .Results-table-row');
    const found = [];

    rows.forEach(row => {
      // Try multiple selectors - parkrun's HTML structure can vary
      const nameEl = row.querySelector('td:nth-child(1) a, .Results-table-td--name a');
      const timeEl = row.querySelector('td:nth-child(2), .Results-table-td--time');

      if (!nameEl) return;

      const name = nameEl.textContent.trim().toUpperCase();
      const matchesSurname = surnames.some(s => name.includes(s));

      if (matchesSurname) {
        const href = nameEl.getAttribute('href') || '';
        const idMatch = href.match(/parkrunner\/(\d+)/);

        found.push({
          name: nameEl.textContent.trim(),
          athleteId: idMatch ? idMatch[1] : null,
          href,
        });
      }
    });

    return found;
  }, config.surnames);

  return results;
}

async function main() {
  console.log(`🔍 Discovering athletes with surnames: ${config.surnames.join(', ')}`);
  console.log(`📍 Event: ${config.event}`);
  console.log(`📅 Checking last ${WEEKS_TO_CHECK} weeks of results\n`);

  const { browser, context } = await createBrowser();

  try {
    const page = await context.newPage();

    // Get recent event numbers
    const eventNumbers = await getRecentResultsDates(page);
    console.log(`Found ${eventNumbers.length} recent events: ${eventNumbers.join(', ')}`);

    const toCheck = eventNumbers.slice(0, WEEKS_TO_CHECK);
    const discoveredMap = new Map(); // athleteId -> { name, athleteId }

    for (const eventNum of toCheck) {
      const found = await scrapeResultsPage(page, eventNum);
      for (const athlete of found) {
        if (athlete.athleteId && !discoveredMap.has(athlete.athleteId)) {
          discoveredMap.set(athlete.athleteId, athlete);
          console.log(`  ✅ Found: ${athlete.name} (ID: ${athlete.athleteId})`);
        }
      }
      // Be nice to the server
      await page.waitForTimeout(2000);
    }

    // Merge with existing config
    const existingIds = new Set(config.athletes.map(a => a.id));
    const newAthletes = [];

    for (const [id, data] of discoveredMap) {
      if (!existingIds.has(id)) {
        newAthletes.push({ id, name: data.name });
      }
    }

    if (newAthletes.length > 0) {
      config.athletes = [...config.athletes, ...newAthletes];
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
      console.log(`\n✨ Added ${newAthletes.length} new athletes to config.json`);
    } else {
      console.log('\nNo new athletes found.');
    }

    console.log(`\nTotal tracked athletes: ${config.athletes.length}`);
    config.athletes.forEach(a => console.log(`  • ${a.name} (${a.id})`));

  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error('❌ Discovery failed:', err.message);
  process.exit(1);
});
