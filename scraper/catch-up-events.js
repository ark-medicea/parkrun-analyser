#!/usr/bin/env node
/**
 * Catch-up scraper: fetch latest event results pages and match to tracked athletes.
 * Much faster than scraping individual athlete pages — one page per event.
 */
const { chromium } = require('playwright');
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'parkrun.db');
const db = new Database(DB_PATH);

// Events to scan (from config + known alternate events)
const EVENTS = [
  'cassiobury',
  'canonspark', 
  'bushey',
  'bushy',
  'burgess',
  'rickmansworth',
  'watford',
  'ellenbrook-fields',
  'aldenham',
  'jersey-farm',
  'gadebridge',
  'tring',
  'oxhey-park',
  'southpark',
  'northala-fields',
  'rushmere',
  'harrow',
  'batchwood',
  'verulamium',
];

// Get tracked athlete IDs
const trackedIds = new Set(
  db.prepare('SELECT id FROM athletes WHERE active = 1').all().map(a => a.id)
);

// Athletes missing today's results
const today = new Date().toISOString().split('T')[0];
const missingIds = new Set(
  db.prepare('SELECT id FROM athletes WHERE active = 1 AND id NOT IN (SELECT athlete_id FROM results WHERE date = ?)').all(today).map(a => a.id)
);

console.log(`📅 Date: ${today}`);
console.log(`👥 Tracked: ${trackedIds.size} | Missing today: ${missingIds.size}`);

if (missingIds.size === 0) {
  console.log('✅ All athletes already have results for today.');
  process.exit(0);
}

function parseTime(timeStr) {
  if (!timeStr) return 0;
  const parts = timeStr.trim().split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

async function main() {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    locale: 'en-GB',
    timezoneId: 'Europe/London',
    viewport: { width: 1280, height: 720 },
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
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

  let totalFound = 0;
  const foundAthletes = [];

  for (const event of EVENTS) {
    const url = `https://www.parkrun.org.uk/${event}/results/latestresults/`;
    console.log(`\n🔍 Scanning ${event}...`);

    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(3000);

      // Check if blocked
      const bodyText = await page.$eval('body', el => el.innerText.substring(0, 300)).catch(() => '');
      if (bodyText.includes('confirm you are human') || bodyText.includes('security check')) {
        console.log(`  ⚡ Cloudflare blocked — skipping`);
        continue;
      }

      // Get the event date from the header
      const headerText = await page.$eval('h3.Results-header', el => el.textContent).catch(() => '');
      const dateMatch = headerText.match(/(\d{2})\/(\d{2})\/(\d{4})/);
      const eventDate = dateMatch ? `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}` : null;
      
      if (!eventDate) {
        console.log(`  ⚠️ Could not parse date from header: "${headerText}"`);
        continue;
      }

      if (eventDate !== today) {
        console.log(`  ℹ️ Latest event is ${eventDate}, not today — skipping`);
        continue;
      }

      // Scrape all results
      const rows = await page.$$eval('tr.Results-table-row', (trs) =>
        trs.map(tr => {
          const nameEl = tr.querySelector('.Results-table-td--name a');
          if (!nameEl) return null;
          const href = nameEl.getAttribute('href') || '';
          const idMatch = href.match(/parkrunner\/(\d+)/);
          const posEl = tr.querySelector('.Results-table-td--position');
          const timeEl = tr.querySelector('.Results-table-td--time .compact');
          const agEl = tr.querySelector('.Results-table-td--ageGroup');
          const ageGradeEl = tr.querySelector('.Results-table-td--ageGrade');
          return {
            id: idMatch ? idMatch[1] : null,
            name: nameEl.textContent.trim(),
            position: posEl ? parseInt(posEl.textContent.trim()) : null,
            time: timeEl ? timeEl.textContent.trim() : null,
            ageGrade: ageGradeEl ? parseFloat(ageGradeEl.textContent.replace('%', '').trim()) : null,
          };
        })
      );

      let eventFound = 0;
      for (const r of rows) {
        if (!r || !r.id || !r.time || r.time === '--') continue;
        if (trackedIds.has(r.id)) {
          const secs = parseTime(r.time);
          if (!secs) continue;
          upsertResult.run(r.id, eventDate, event, r.time, secs, r.position, r.ageGrade);
          eventFound++;
          totalFound++;
          const wasMissing = missingIds.has(r.id);
          foundAthletes.push({ name: r.name, event, time: r.time, position: r.position, wasMissing });
          if (wasMissing) missingIds.delete(r.id);
          console.log(`  ✓ ${r.name}: ${r.time} (pos ${r.position})${wasMissing ? ' [NEW]' : ' [already had]'}`);
        }
      }

      if (eventFound === 0) {
        console.log(`  No tracked athletes found`);
      }

    } catch (err) {
      console.log(`  ⚠️ Error: ${err.message.substring(0, 80)}`);
    }

    // Wait between events to avoid rate limiting
    await new Promise(r => setTimeout(r, 5000));
  }

  await browser.close();

  // Recalculate PBs for found athletes
  console.log('\n🔄 Recalculating PBs...');
  for (const fa of foundAthletes) {
    // Find the athlete ID from name
    const athlete = db.prepare('SELECT id FROM athletes WHERE name = ?').get(fa.name);
    if (!athlete) continue;
    
    db.prepare('UPDATE results SET is_pb = 0 WHERE athlete_id = ?').run(athlete.id);
    const results = db.prepare(
      'SELECT rowid, time_seconds FROM results WHERE athlete_id = ? AND is_junior = 0 ORDER BY date ASC'
    ).all(athlete.id);
    let best = Infinity;
    for (const r of results) {
      if (r.time_seconds < best) {
        best = r.time_seconds;
        db.prepare('UPDATE results SET is_pb = 1 WHERE rowid = ?').run(r.rowid);
      }
    }
  }

  // Recalculate stats for all athletes
  console.log('📊 Recalculating athlete stats...');
  const allAthletes = db.prepare('SELECT id FROM athletes WHERE active = 1').all();
  for (const a of allAthletes) {
    const count5k = db.prepare('SELECT COUNT(*) as c FROM results WHERE athlete_id = ? AND is_junior = 0').get(a.id);
    const countJr = db.prepare('SELECT COUNT(*) as c FROM results WHERE athlete_id = ? AND is_junior = 1').get(a.id);
    const latestDate = db.prepare('SELECT MAX(date) as d FROM results WHERE athlete_id = ?').get(a.id);
    
    if (count5k) db.prepare('UPDATE athletes SET total_5k = ? WHERE id = ?').run(count5k.c, a.id);
    if (countJr) db.prepare('UPDATE athletes SET total_junior = ? WHERE id = ?').run(countJr.c, a.id);
    if (latestDate?.d) {
      db.prepare('UPDATE athletes SET last_active_date = ? WHERE id = ?').run(latestDate.d, a.id);
    }
  }

  db.close();

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`✅ Done: Found ${totalFound} tracked athlete results`);
  console.log(`Still missing: ${missingIds.size} athletes (may not have run today)`);
  console.log(`${'═'.repeat(60)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
