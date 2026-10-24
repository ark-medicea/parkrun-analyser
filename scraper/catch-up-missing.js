#!/usr/bin/env node
/**
 * Catch-up scraper for athletes missing today's results.
 * Uses longer delays and Cloudflare backoff.
 */
const { chromium } = require('playwright');
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'parkrun.db');
const db = new Database(DB_PATH);

const today = new Date().toISOString().split('T')[0];

// Get athletes missing today
const missing = db.prepare(`
  SELECT id, name FROM athletes 
  WHERE active = 1 
  AND id NOT IN (SELECT athlete_id FROM results WHERE date = ?)
  ORDER BY name
`).all(today);

console.log(`📅 Date: ${today}`);
console.log(`👥 Missing athletes: ${missing.length}`);
if (missing.length === 0) { console.log('✅ All done.'); process.exit(0); }
for (const m of missing) console.log(`  - ${m.name} (${m.id})`);

function parseTime(timeStr) {
  if (!timeStr) return 0;
  const parts = timeStr.trim().split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
    ],
  });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    locale: 'en-GB',
    timezoneId: 'Europe/London',
    viewport: { width: 1440, height: 900 },
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

  let delay = 45000; // Start with 45s delay
  let successCount = 0;
  let failCount = 0;
  let newResults = 0;
  const foundToday = [];

  // First, warm up with a non-parkrun page to establish the browser session
  console.log('\n🌐 Warming up browser...');
  await page.goto('https://www.google.com', { waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
  await sleep(3000);

  for (const athlete of missing) {
    console.log(`\n━━━ ${athlete.name} (${athlete.id}) ━━━`);
    const url = `https://www.parkrun.org.uk/parkrunner/${athlete.id}/all/`;
    console.log(`  📊 ${url}`);

    let success = false;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(5000);

        const status = resp.status();
        if (status === 403) {
          console.log(`  ⚡ 403 Forbidden (attempt ${attempt}/5), backing off ${Math.round(delay/1000)}s...`);
          await sleep(delay);
          delay = Math.min(delay * 2, 300000); // Max 5 min
          continue;
        }

        const bodyText = await page.$eval('body', el => el.innerText.substring(0, 300)).catch(() => '');
        if (bodyText.includes('confirm you are human') || bodyText.includes('security check') || bodyText.includes('Checking your browser')) {
          console.log(`  ⚡ Cloudflare challenge (attempt ${attempt}/5), backing off ${Math.round(delay/1000)}s...`);
          await sleep(delay);
          delay = Math.min(delay * 2, 300000);
          continue;
        }

        // Check for results table
        const hasResults = await page.$('#results tbody tr').catch(() => null);
        if (!hasResults) {
          console.log(`  ⚠️ No results table found (attempt ${attempt}/5)`);
          if (bodyText.includes('Unknown Athlete') || bodyText.includes('does not exist')) {
            console.log(`  ❌ Athlete not found, skipping`);
            break;
          }
          await sleep(delay);
          delay = Math.min(delay * 1.5, 300000);
          continue;
        }

        // Scrape results
        const rows = await page.$$eval('#results tbody tr', trs =>
          trs.map(tr => {
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
            return { event, dateText, position, time, ageGrade };
          })
        );

        let count = 0;
        let todayResult = null;
        for (const r of rows) {
          if (!r || !r.event || !r.time || r.time === '--') continue;
          const dm = r.dateText.match(/(\d{2})\/(\d{2})\/(\d{4})/);
          if (!dm) continue;
          const date = `${dm[3]}-${dm[2]}-${dm[1]}`;
          const secs = parseTime(r.time);
          if (!secs) continue;
          upsertResult.run(athlete.id, date, r.event, r.time, secs, r.position, r.ageGrade);
          count++;
          if (date === today) {
            todayResult = { event: r.event, time: r.time, position: r.position };
          }
        }
        console.log(`  ✓ ${count} results upserted`);
        if (todayResult) {
          console.log(`  🏃 TODAY: ${todayResult.time} at ${todayResult.event} (pos ${todayResult.position})`);
          foundToday.push({ name: athlete.name, ...todayResult });
          newResults++;
        } else {
          console.log(`  ℹ️ No result for today (didn't run or results not up yet)`);
        }

        success = true;
        successCount++;
        // Success — reduce delay back toward base
        delay = Math.max(30000, Math.floor(delay * 0.7));
        break;

      } catch (err) {
        console.log(`  ⚠️ Error (attempt ${attempt}): ${err.message.substring(0, 80)}`);
        await sleep(delay);
        delay = Math.min(delay * 2, 300000);
      }
    }

    if (!success) {
      console.log(`  ❌ Failed after 5 attempts`);
      failCount++;
    }

    console.log(`  ⏱️ Next in ${Math.round(delay/1000)}s`);
    await sleep(delay);
  }

  await browser.close();

  // Recalculate PBs for scraped athletes
  console.log('\n🔄 Recalculating PBs...');
  for (const athlete of missing) {
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

  // Update stats
  console.log('📊 Updating stats...');
  for (const a of missing) {
    const c5k = db.prepare('SELECT COUNT(*) as c FROM results WHERE athlete_id = ? AND is_junior = 0').get(a.id);
    const cJr = db.prepare('SELECT COUNT(*) as c FROM results WHERE athlete_id = ? AND is_junior = 1').get(a.id);
    const latest = db.prepare('SELECT MAX(date) as d FROM results WHERE athlete_id = ?').get(a.id);
    db.prepare('UPDATE athletes SET total_5k = ?, total_junior = ?, last_active_date = ? WHERE id = ?')
      .run(c5k?.c || 0, cJr?.c || 0, latest?.d || null, a.id);
  }

  db.close();

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`✅ Scraped: ${successCount} | Failed: ${failCount} | New today: ${newResults}`);
  if (foundToday.length > 0) {
    console.log(`\n🏃 Today's results found:`);
    for (const f of foundToday) {
      console.log(`  ${f.name}: ${f.time} at ${f.event} (pos ${f.position})`);
    }
  }
  console.log(`${'═'.repeat(60)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
