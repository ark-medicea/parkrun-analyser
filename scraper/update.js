#!/usr/bin/env node
/**
 * Update results for all active athletes by scraping their parkrun history.
 */

const { getPage, closeBrowser, sleep } = require('./browser');
const { getDb, saveDb, getAthletes, upsertResult, recalculatePBs } = require('./db');

async function updateResults() {
  const db = await getDb();
  const page = await getPage();

  try {
    const athletes = getAthletes(db);
    console.log(`Updating results for ${athletes.length} athletes...`);

    for (const athlete of athletes) {
      console.log(`\nFetching: ${athlete.name} (${athlete.id})...`);

      try {
        const url = `https://www.parkrun.org.uk/parkrunner/${athlete.id}/all/`;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        const results = await page.$$eval(
          '#results tbody tr',
          (trs) =>
            trs.map((tr) => {
              const cells = tr.querySelectorAll('td');
              if (cells.length < 6) return null;

              const eventLink = cells[0]?.querySelector('a');
              const eventHref = eventLink?.getAttribute('href') || '';
              const eventMatch = eventHref.match(/parkrun\.org\.uk\/([^/]+)\//);
              const event = eventMatch ? eventMatch[1] : '';

              const dateText = cells[1]?.textContent?.trim() || '';
              const position = parseInt(cells[3]?.textContent?.trim()) || null;
              const time = cells[4]?.textContent?.trim() || '';
              const agText = cells[5]?.textContent?.trim()?.replace('%', '') || '';
              const ageGrade = parseFloat(agText) || null;

              return { event, dateText, position, time, ageGrade };
            })
        );

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
            athlete_id: athlete.id,
            date,
            event: r.event,
            time: r.time,
            time_seconds: timeSeconds,
            position: r.position,
            age_grade: r.ageGrade,
          });
          count++;
        }

        console.log(`  ✓ ${count} results upserted`);
      } catch (err) {
        console.warn(`  ✗ Failed for ${athlete.name}: ${err.message}`);
      }

      await sleep(3000);
    }

    console.log('\nRecalculating PBs...');
    recalculatePBs(db);

    saveDb(db);
    console.log('Done.');
  } finally {
    db.close();
    await closeBrowser();
  }
}

updateResults().catch((err) => {
  console.error('Update failed:', err);
  process.exit(1);
});
