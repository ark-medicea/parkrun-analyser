#!/usr/bin/env node
/**
 * Discover athletes by scanning recent Cassiobury parkrun results
 * for configured surnames.
 */

const { getPage, closeBrowser, sleep } = require('./browser');
const { getDb, saveDb, upsertAthlete } = require('./db');
const config = require('../config.json');

const BASE_URL = `https://www.parkrun.org.uk/${config.event}/results`;

async function discoverAthletes() {
  const db = await getDb();
  const page = await getPage();
  const found = new Map();

  try {
    console.log('Loading latest results page...');
    await page.goto(`${BASE_URL}/latestresults/`, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const eventNumText = await page.$eval('h3.Results-header', el => el.textContent).catch(() => '');
    const eventMatch = eventNumText.match(/#(\d+)/);
    const latestEvent = eventMatch ? parseInt(eventMatch[1]) : null;

    if (!latestEvent) {
      console.log('Could not determine latest event number, scanning latest results only...');
    }

    const pagesToScan = latestEvent
      ? Array.from({ length: 8 }, (_, i) => latestEvent - i).filter(n => n > 0)
      : [null];

    for (const eventNum of pagesToScan) {
      const url = eventNum
        ? `${BASE_URL}/${eventNum}/`
        : `${BASE_URL}/latestresults/`;

      console.log(`Scanning event ${eventNum || 'latest'}...`);

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        const rows = await page.$$eval(
          'tr.Results-table-row',
          (trs) =>
            trs.map((tr) => {
              const nameEl = tr.querySelector('.Results-table-td--name a');
              if (!nameEl) return null;
              const href = nameEl.getAttribute('href') || '';
              const idMatch = href.match(/parkrunner\/(\d+)/);
              const name = nameEl.textContent.trim();
              const genderEl = tr.querySelector('.Results-table-td--gender');
              const agEl = tr.querySelector('.Results-table-td--ageGroup');
              return {
                id: idMatch ? idMatch[1] : null,
                name,
                gender: genderEl ? genderEl.textContent.trim() : null,
                age_group: agEl ? agEl.textContent.trim() : null,
              };
            })
        );

        for (const row of rows) {
          if (!row || !row.id || !row.name) continue;
          const surname = row.name.split(' ').pop().toUpperCase();
          if (config.surnames.includes(surname) && !found.has(row.id)) {
            found.set(row.id, row);
            console.log(`  Found: ${row.name} (ID: ${row.id})`);
          }
        }
      } catch (err) {
        console.warn(`  Failed to scan event ${eventNum}: ${err.message}`);
      }

      await sleep(2000);
    }

    console.log(`\nDiscovered ${found.size} athletes. Upserting...`);
    for (const athlete of found.values()) {
      upsertAthlete(db, {
        id: athlete.id,
        name: athlete.name,
        gender: athlete.gender,
        age_group: athlete.age_group,
        home_event: config.event,
      });
      console.log(`  ✓ ${athlete.name}`);
    }

    saveDb(db);
  } finally {
    db.close();
    await closeBrowser();
  }

  console.log('Discovery complete.');
}

discoverAthletes().catch((err) => {
  console.error('Discovery failed:', err);
  process.exit(1);
});
