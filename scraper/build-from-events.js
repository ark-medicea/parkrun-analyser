#!/usr/bin/env node
/**
 * Build athlete results by scanning event results pages (not athlete /all/ pages).
 * Works around Cloudflare bot protection on parkrunner pages.
 */
const { chromium } = require('playwright');
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'parkrun.db');
const db = new Database(DB_PATH);

// Get tracked athlete IDs
const athleteIds = new Set(
  db.prepare('SELECT id FROM athletes WHERE active = 1').all().map(a => a.id)
);
console.log(`Tracking ${athleteIds.size} athletes`);

// Events to scan
const EVENTS = ['cassiobury'];
const PAGES_PER_EVENT = 100; // ~2 years of weekly events

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    locale: 'en-GB',
  });
  const page = await ctx.newPage();

  const upsertResult = db.prepare(`
    INSERT INTO results (athlete_id, date, event, time, time_seconds, position, age_grade, is_pb, is_junior)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)
    ON CONFLICT(athlete_id, date, event) DO UPDATE SET
      time = excluded.time,
      time_seconds = excluded.time_seconds,
      position = COALESCE(excluded.position, results.position),
      age_grade = COALESCE(excluded.age_grade, results.age_grade)
  `);

  let totalNew = 0;

  for (const event of EVENTS) {
    console.log(`\n=== ${event} ===`);
    
    // Get latest event number
    await page.goto(`https://www.parkrun.org.uk/${event}/results/latestresults/`, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(3000);
    
    const h3s = await page.$$eval('h3', els => els.map(e => e.textContent.trim()));
    let latest = null;
    for (const t of h3s) {
      const m = t.match(/#(\d+)/);
      if (m) { latest = parseInt(m[1]); break; }
    }
    if (!latest) { console.log('Could not find latest event'); continue; }
    console.log(`Latest: #${latest}, scanning back ${PAGES_PER_EVENT} events...`);

    for (let num = latest; num > latest - PAGES_PER_EVENT && num > 0; num--) {
      process.stdout.write(`  #${num}...`);
      try {
        await page.goto(`https://www.parkrun.org.uk/${event}/results/${num}/`, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(1500);

        // Get event date from h3
        const dateH3 = await page.$$eval('h3', els => {
          for (const e of els) {
            const m = e.textContent.match(/(\d{2})\/(\d{2})\/(\d{4})/);
            if (m) return `${m[3]}-${m[2]}-${m[1]}`;
          }
          return null;
        });

        if (!dateH3) { process.stdout.write(' no date\n'); continue; }

        const rows = await page.$$eval('tr.Results-table-row', trs => trs.map(tr => {
          const a = tr.querySelector('.Results-table-td--name a');
          if (!a) return null;
          const href = a.getAttribute('href') || '';
          const idm = href.match(/parkrunner\/(\d+)/);
          const timeTd = tr.querySelector('.Results-table-td--time .compact');
          const posTd = tr.querySelector('.Results-table-td--pos .compact');
          const agTd = tr.querySelector('.Results-table-td--ageGrade .compact');
          const genderTd = tr.querySelector('.Results-table-td--gender');
          return {
            id: idm ? idm[1] : null,
            time: timeTd?.textContent.trim() || '',
            pos: parseInt(posTd?.textContent.trim()) || null,
            ag: parseFloat(agTd?.textContent.trim()?.replace('%','')) || null,
          };
        }));

        let found = 0;
        for (const r of rows) {
          if (!r?.id || !athleteIds.has(r.id) || !r.time || r.time === '--') continue;
          
          const parts = r.time.split(':').map(Number);
          let secs;
          if (parts.length === 3) secs = parts[0]*3600 + parts[1]*60 + parts[2];
          else if (parts.length === 2) secs = parts[0]*60 + parts[1];
          else continue;

          upsertResult.run(r.id, dateH3, event, r.time, secs, r.pos, r.ag);
          found++;
        }
        
        if (found > 0) totalNew += found;
        process.stdout.write(` ${dateH3} | ${rows.filter(Boolean).length} runners | ${found} tracked\n`);
      } catch (e) {
        process.stdout.write(` FAILED\n`);
      }
      await page.waitForTimeout(1000);
    }
  }

  // Recalculate PBs for all athletes
  console.log('\nRecalculating PBs...');
  for (const aid of athleteIds) {
    db.prepare('UPDATE results SET is_pb = 0 WHERE athlete_id = ?').run(aid);
    const results = db.prepare(
      'SELECT rowid, time_seconds FROM results WHERE athlete_id = ? AND is_junior = 0 ORDER BY date ASC'
    ).all(aid);
    let best = Infinity;
    for (const r of results) {
      if (r.time_seconds < best) {
        best = r.time_seconds;
        db.prepare('UPDATE results SET is_pb = 1 WHERE rowid = ?').run(r.rowid);
      }
    }
  }

  await browser.close();

  // Summary
  console.log(`\n✅ Done. ${totalNew} results for tracked athletes.`);
  const summary = db.prepare(`
    SELECT a.name, COUNT(r.id) as cnt
    FROM athletes a
    LEFT JOIN results r ON r.athlete_id = a.id
    WHERE a.active = 1
    GROUP BY a.id
    ORDER BY a.name
  `).all();
  for (const s of summary) {
    console.log(`  ${s.name.padEnd(30)} ${s.cnt} results`);
  }
  
  db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
