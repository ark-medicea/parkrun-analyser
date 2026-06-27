#!/usr/bin/env node
/**
 * Add a single athlete by ID, scrape their full history, and update stats.
 */
const { getPage, closeBrowser, sleep } = require('./browser');
const { getDb, saveDb, upsertAthlete, upsertResult, recalculatePBs, recalculateAthleteStats } = require('./db');

const ATHLETE_ID = process.argv[2];
if (!ATHLETE_ID) {
  console.error('Usage: node add-single-athlete.js <athlete_id>');
  process.exit(1);
}

async function run() {
  const db = await getDb();
  const page = await getPage();

  try {
    const url = `https://www.parkrun.org.uk/parkrunner/${ATHLETE_ID}/all/`;
    console.log(`Fetching ${url} ...`);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

    // Wait for results table
    await page.waitForSelector('#results tbody tr', { timeout: 15000 }).catch(() => {
      console.log('⚠ Results table selector not found, trying fallback...');
    });

    // Extract athlete name from h2
    const name = await page.$eval('h2', el => {
      let t = el.textContent.trim();
      t = t.replace(/['']s parkrun summary/i, '').trim();
      return t;
    }).catch(() => null);

    if (!name) {
      console.error('Could not extract athlete name from page');
      process.exit(1);
    }

    console.log(`Athlete: ${name}`);

    // Extract gender and age group from summary stats if available
    let gender = null;
    let ageGroup = null;
    try {
      const summaryText = await page.$eval('.Results-summary', el => el.textContent);
      // Try to find age group pattern like VM40-44, SW25-29, etc.
      const agMatch = summaryText.match(/([JSVW][MW]\d+-\d+)/);
      if (agMatch) ageGroup = agMatch[1];
    } catch (e) {}

    // Also try to get gender/age from the first result row
    const results = await page.$$eval(
      '#results tbody tr',
      (trs) =>
        trs.map((tr) => {
          const cells = tr.querySelectorAll('td');
          if (cells.length < 6) return null;

          const eventLink = cells[0]?.querySelector('a');
          const eventHref = eventLink?.getAttribute('href') || '';
          const eventMatch = eventHref.match(/parkrun\.[^/]+\/([^/]+)\//);
          const event = eventMatch ? eventMatch[1] : '';

          const dateText = cells[1]?.textContent?.trim() || '';
          const position = parseInt(cells[3]?.textContent?.trim()) || null;
          const time = cells[4]?.textContent?.trim() || '';
          const agText = cells[5]?.textContent?.trim()?.replace('%', '') || '';
          const ageGrade = parseFloat(agText) || null;

          // Check if gender column exists
          const genderCell = cells[6]?.textContent?.trim() || null;

          return { event, dateText, position, time, ageGrade, genderCell };
        })
    );

    // Upsert athlete
    upsertAthlete(db, {
      id: ATHLETE_ID,
      name,
      gender,
      age_group: ageGroup,
      home_event: 'cassiobury',
    });
    console.log(`✓ Athlete record upserted`);

    // Insert results
    let count = 0;
    for (const r of results) {
      if (!r || !r.event || !r.time || r.time === '--') continue;

      const dateParts = r.dateText.match(/(\d{2})\/(\d{2})\/(\d{4})/);
      if (!dateParts) continue;
      const date = `${dateParts[3]}-${dateParts[2]}-${dateParts[1]}`;

      const timeParts = r.time.split(':').map(Number);
      let timeSeconds;
      if (timeParts.length === 3) {
        timeSeconds = timeParts[0] * 3600 + timeParts[1] * 60 + timeParts[2];
      } else if (timeParts.length === 2) {
        timeSeconds = timeParts[0] * 60 + timeParts[1];
      } else {
        continue;
      }

      upsertResult(db, {
        athlete_id: ATHLETE_ID,
        date,
        event: r.event,
        time: r.time,
        time_seconds: timeSeconds,
        position: r.position,
        age_grade: r.ageGrade,
      });
      count++;
    }

    console.log(`✓ ${count} results upserted`);

    console.log('Recalculating PBs...');
    recalculatePBs(db);

    console.log('Recalculating athlete stats...');
    recalculateAthleteStats(db);

    saveDb(db);
    console.log('✓ Database saved');

  } finally {
    db.close();
    await closeBrowser();
  }
}

run().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
