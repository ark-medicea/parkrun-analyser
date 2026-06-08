#!/usr/bin/env node
/**
 * Smart athlete results scraper with rate limiting and Cloudflare backoff.
 * Scrapes /parkrunner/{id}/all/ for each tracked athlete.
 * Also scrapes summary page for badges/PB/volunteer data.
 */
const { chromium } = require('playwright');
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'parkrun.db');
const db = new Database(DB_PATH);

// ── Config ──
const BASE_DELAY = 5000;       // 5s between requests
const MAX_DELAY = 120000;      // 2 min max backoff
const BACKOFF_MULTIPLIER = 2;
const MAX_RETRIES = 5;

// ── Ensure columns exist ──
const addCol = (table, col, type) => {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); } catch(e) {}
};
addCol('athletes', 'pb_5k', 'TEXT');
addCol('athletes', 'pb_5k_seconds', 'INTEGER');
addCol('athletes', 'badge', 'TEXT');
addCol('athletes', 'total_5k', 'INTEGER DEFAULT 0');
addCol('athletes', 'total_junior', 'INTEGER DEFAULT 0');
addCol('athletes', 'volunteer_count', 'INTEGER DEFAULT 0');
addCol('results', 'is_junior', 'INTEGER DEFAULT 0');

function parseTime(timeStr) {
  if (!timeStr) return 0;
  const parts = timeStr.trim().split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function isBlocked(page) {
  const text = await page.$eval('body', el => el.innerText.substring(0, 100)).catch(() => '');
  return text.includes('confirm you are human') || text.includes('security check');
}

async function loadWithRetry(page, url, currentDelay) {
  let delay = currentDelay;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
      await page.waitForTimeout(3000);

      if (await isBlocked(page)) {
        console.log(`    ⚡ Cloudflare challenge (attempt ${attempt}/${MAX_RETRIES}), backing off ${Math.round(delay/1000)}s...`);
        await sleep(delay);
        delay = Math.min(delay * BACKOFF_MULTIPLIER, MAX_DELAY);
        continue;
      }

      return { success: true, delay, status: resp.status() };
    } catch (err) {
      console.log(`    ⚠️ Load error (attempt ${attempt}): ${err.message.substring(0, 60)}`);
      await sleep(delay);
      delay = Math.min(delay * BACKOFF_MULTIPLIER, MAX_DELAY);
    }
  }
  return { success: false, delay };
}

// ── Scrape /all/ results page ──
async function scrapeAllResults(page, athleteId) {
  const rows = await page.$$eval('#results tbody tr', trs =>
    trs.map(tr => {
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

  return rows.filter(Boolean);
}

// ── Scrape summary page ──
async function scrapeSummary(page) {
  return await page.evaluate(() => {
    const text = document.body.innerText;

    const badgeMatch = text.match(/Member of the parkrun (\d+) Club/);
    const badge = badgeMatch ? parseInt(badgeMatch[1]) : null;

    const ageMatch = text.match(/Most recent age category was ([A-Z0-9-]+)/);
    const ageGroup = ageMatch ? ageMatch[1] : null;

    let gender = null;
    if (ageGroup) {
      gender = (ageGroup.includes('W') || ageGroup.includes('F')) ? 'F' : 'M';
    }

    let total5k = 0, totalJunior = 0;
    const m1 = text.match(/(\d+)\s+parkruns?\s+&\s+(\d+)\s+junior\s+parkruns?\s+total/);
    const m2 = text.match(/(\d+)\s+parkruns?\s+total/);
    if (m1) { total5k = parseInt(m1[1]); totalJunior = parseInt(m1[2]); }
    else if (m2) { total5k = parseInt(m2[1]); }

    let pb5k = null;
    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      const rows = table.querySelectorAll('tbody tr, tr');
      for (const row of rows) {
        const rowText = Array.from(row.querySelectorAll('td, th')).map(c => c.textContent.trim()).join('\t');
        if (rowText.includes('5k bests')) {
          for (const cell of row.querySelectorAll('td')) {
            const t = cell.textContent.trim();
            if (/^\d{1,2}:\d{2}$/.test(t)) { pb5k = t; break; }
          }
        }
      }
    }

    const volMatch = text.match(/Total Credits\s+(\d+)/);
    const volunteerCount = volMatch ? parseInt(volMatch[1]) : 0;

    const juniorEvents = [];
    const eventSection = text.match(/Event Summaries([\s\S]*?)(?:Volunteer Summary|$)/);
    if (eventSection) {
      for (const line of eventSection[1].split('\n')) {
        if (/junior\s+parkrun/i.test(line)) {
          const em = line.match(/^([A-Za-z\s]+?)\s+junior/i);
          if (em) juniorEvents.push(em[1].trim().toLowerCase().replace(/\s+/g, '') + '-juniors');
        }
      }
    }

    return { badge, ageGroup, gender, total5k, totalJunior, pb5k, volunteerCount, juniorEvents };
  });
}

async function main() {
  const athletes = db.prepare('SELECT * FROM athletes WHERE active = 1 ORDER BY name').all();
  console.log(`🏃 Smart update for ${athletes.length} athletes\n`);

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

  const updateAthlete = db.prepare(`
    UPDATE athletes SET
      age_group = COALESCE(?, age_group),
      gender = COALESCE(?, gender),
      pb_5k = COALESCE(?, pb_5k),
      pb_5k_seconds = COALESCE(?, pb_5k_seconds),
      badge = COALESCE(?, badge),
      total_5k = CASE WHEN ? > 0 THEN ? ELSE total_5k END,
      total_junior = CASE WHEN ? > 0 THEN ? ELSE total_junior END,
      volunteer_count = CASE WHEN ? > 0 THEN ? ELSE volunteer_count END
    WHERE id = ?
  `);

  let currentDelay = BASE_DELAY;
  let successCount = 0;
  let failCount = 0;

  for (const athlete of athletes) {
    console.log(`\n━━━ ${athlete.name} (${athlete.id}) ━━━`);

    // 1) Scrape /all/ results page
    const allUrl = `https://www.parkrun.org.uk/parkrunner/${athlete.id}/all/`;
    console.log(`  📊 Results: ${allUrl}`);

    const allResult = await loadWithRetry(page, allUrl, currentDelay);
    if (!allResult.success) {
      console.log(`  ❌ Giving up on results after ${MAX_RETRIES} attempts`);
      currentDelay = allResult.delay;
      failCount++;
      await sleep(currentDelay);
      continue;
    }
    currentDelay = allResult.delay;

    // On success, gradually reduce delay (but not below base)
    if (currentDelay > BASE_DELAY) {
      currentDelay = Math.max(BASE_DELAY, Math.floor(currentDelay / BACKOFF_MULTIPLIER));
    }

    const rawResults = await scrapeAllResults(page, athlete.id);
    let count = 0;
    for (const r of rawResults) {
      if (!r.event || !r.time || r.time === '--') continue;
      const dm = r.dateText.match(/(\d{2})\/(\d{2})\/(\d{4})/);
      if (!dm) continue;
      const date = `${dm[3]}-${dm[2]}-${dm[1]}`;
      const secs = parseTime(r.time);
      if (!secs) continue;
      upsertResult.run(athlete.id, date, r.event, r.time, secs, r.position, r.ageGrade);
      count++;
    }
    console.log(`  ✓ ${count} results upserted`);

    await sleep(currentDelay);

    // 2) Scrape summary page
    const sumUrl = `https://www.parkrun.org.uk/parkrunner/${athlete.id}/`;
    console.log(`  📋 Summary: ${sumUrl}`);

    const sumResult = await loadWithRetry(page, sumUrl, currentDelay);
    if (!sumResult.success) {
      console.log(`  ⚠️ Summary failed, keeping existing data`);
      currentDelay = sumResult.delay;
    } else {
      currentDelay = sumResult.delay;
      if (currentDelay > BASE_DELAY) {
        currentDelay = Math.max(BASE_DELAY, Math.floor(currentDelay / BACKOFF_MULTIPLIER));
      }

      const summary = await scrapeSummary(page);
      const pbSecs = parseTime(summary.pb5k);
      updateAthlete.run(
        summary.ageGroup, summary.gender,
        summary.pb5k, pbSecs || null,
        summary.badge ? String(summary.badge) : null,
        summary.total5k, summary.total5k,
        summary.totalJunior, summary.totalJunior,
        summary.volunteerCount, summary.volunteerCount,
        athlete.id
      );

      // Mark junior results
      db.prepare('UPDATE results SET is_junior = 1 WHERE athlete_id = ? AND event LIKE ?')
        .run(athlete.id, '%junior%');
      for (const je of summary.juniorEvents) {
        db.prepare('UPDATE results SET is_junior = 1 WHERE athlete_id = ? AND event LIKE ?')
          .run(athlete.id, `%${je}%`);
      }

      console.log(`  ✓ Badge: ${summary.badge || 'none'} | 5k: ${summary.total5k} | Jr: ${summary.totalJunior} | Vol: ${summary.volunteerCount} | PB: ${summary.pb5k || '—'}`);
    }

    // Recalculate PBs for this athlete
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

    successCount++;
    console.log(`  ⏱️ Next request in ${Math.round(currentDelay/1000)}s`);
    await sleep(currentDelay);
  }

  await browser.close();

  // Final summary
  console.log(`\n\n${'═'.repeat(60)}`);
  console.log(`✅ Done: ${successCount} succeeded, ${failCount} failed`);
  console.log(`${'═'.repeat(60)}\n`);

  const summary = db.prepare(`
    SELECT a.name, a.badge, a.total_5k, a.total_junior, a.volunteer_count, a.pb_5k,
      (SELECT COUNT(*) FROM results r WHERE r.athlete_id = a.id) as db_results
    FROM athletes a WHERE a.active = 1 ORDER BY a.name
  `).all();

  for (const s of summary) {
    const badge = s.badge ? `🏅${s.badge}` : '';
    console.log(`  ${s.name.padEnd(28)} ${String(s.db_results).padStart(4)} results | PB: ${(s.pb_5k||'—').padEnd(6)} | 5k: ${String(s.total_5k||0).padStart(3)} Jr: ${String(s.total_junior||0).padStart(2)} Vol: ${String(s.volunteer_count||0).padStart(3)} ${badge}`);
  }

  db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
