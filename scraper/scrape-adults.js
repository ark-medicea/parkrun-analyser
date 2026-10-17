#!/usr/bin/env node
/**
 * Targeted scrape for adult athletes only (those NOT already scraped today).
 * Reuses smart-update logic.
 */
const { chromium } = require('playwright');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'parkrun.db');
const db = new Database(DB_PATH);

const BASE_DELAY = 25000;
const MAX_DELAY = 300000;
const BACKOFF_MULTIPLIER = 2.5;
const MAX_RETRIES = 6;
const PAGE_LOAD_WAIT = 5000;
const JITTER_MIN = 0.8;
const JITTER_MAX = 1.5;

function parseTime(t) {
  if (!t) return 0;
  const p = t.trim().split(':').map(Number);
  if (p.length === 3) return p[0]*3600+p[1]*60+p[2];
  if (p.length === 2) return p[0]*60+p[1];
  return 0;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function computeBadge(n) { for (const m of [500,250,100,50,25,10]) if (n >= m) return String(m); return null; }
function jd(b) { return Math.round(b*(JITTER_MIN+Math.random()*(JITTER_MAX-JITTER_MIN))); }

async function isBlocked(page) {
  const text = await page.$eval('body', el => el.innerText.substring(0,300)).catch(()=>'');
  return text.includes('confirm you are human') || text.includes('security check') || text.includes('Checking your browser');
}

async function loadWithRetry(page, url, currentDelay) {
  let delay = currentDelay;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(PAGE_LOAD_WAIT);
      if (await isBlocked(page)) {
        console.log(`    ⚡ Cloudflare (attempt ${attempt}/${MAX_RETRIES}), backing off ${Math.round(delay/1000)}s...`);
        await sleep(delay); delay = Math.min(delay*BACKOFF_MULTIPLIER, MAX_DELAY); continue;
      }
      return { success: true, delay, status: resp.status() };
    } catch (err) {
      console.log(`    ⚠️ Error (attempt ${attempt}): ${err.message.substring(0,60)}`);
      await sleep(delay); delay = Math.min(delay*BACKOFF_MULTIPLIER, MAX_DELAY);
    }
  }
  return { success: false, delay };
}

async function main() {
  const today = new Date().toISOString().split('T')[0];
  
  // Get adults not yet scraped today
  const athletes = db.prepare(`
    SELECT * FROM athletes WHERE active = 1
    AND (last_scraped_date IS NULL OR last_scraped_date < ?)
    ORDER BY name
  `).all(today);

  console.log(`🏃 Adult scrape for ${athletes.length} athletes (skipping ${35-athletes.length} already done today)\n`);

  const browser = await chromium.launch({
    channel: 'chrome', headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    locale: 'en-GB', timezoneId: 'Europe/London', viewport: { width: 1280, height: 720 },
  });
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); });
  const page = await ctx.newPage();

  const upsertResult = db.prepare(`
    INSERT INTO results (athlete_id, date, event, time, time_seconds, position, age_grade, is_pb, is_junior)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)
    ON CONFLICT(athlete_id, date, event) DO UPDATE SET
      time=excluded.time, time_seconds=excluded.time_seconds,
      position=COALESCE(excluded.position, results.position),
      age_grade=COALESCE(excluded.age_grade, results.age_grade)
  `);
  const savePrevVol = db.prepare(`UPDATE athletes SET prev_volunteer_count = volunteer_count WHERE id = ?`);
  const updateAthlete = db.prepare(`
    UPDATE athletes SET
      age_group=COALESCE(?,age_group), gender=COALESCE(?,gender),
      pb_5k=COALESCE(?,pb_5k), pb_5k_seconds=COALESCE(?,pb_5k_seconds),
      badge=?,
      total_5k=CASE WHEN ?>0 THEN ? ELSE total_5k END,
      total_junior=CASE WHEN ?>0 THEN ? ELSE total_junior END,
      volunteer_count=CASE WHEN ?>0 THEN ? ELSE volunteer_count END
    WHERE id=?
  `);

  let currentDelay = BASE_DELAY;
  let successCount = 0, failCount = 0;

  for (const athlete of athletes) {
    console.log(`\n━━━ ${athlete.name} (${athlete.id}) ━━━`);

    const allUrl = `https://www.parkrun.org.uk/parkrunner/${athlete.id}/all/`;
    console.log(`  📊 Results: ${allUrl}`);
    const allResult = await loadWithRetry(page, allUrl, currentDelay);
    if (!allResult.success) {
      console.log(`  ❌ Giving up`); currentDelay = allResult.delay; failCount++;
      await sleep(jd(currentDelay)); continue;
    }
    currentDelay = allResult.delay;
    if (currentDelay > BASE_DELAY) currentDelay = BASE_DELAY + Math.floor((currentDelay-BASE_DELAY)/2);

    const rawResults = await page.$$eval('#results tbody tr', trs => trs.map(tr => {
      const cells = tr.querySelectorAll('td');
      if (cells.length < 6) return null;
      const el = cells[0]?.querySelector('a');
      const href = el?.getAttribute('href') || '';
      const em = href.match(/parkrun\.org\.uk\/([^/]+)\//);
      return {
        event: em?em[1]:'', dateText: cells[1]?.textContent?.trim()||'',
        position: parseInt(cells[3]?.textContent?.trim())||null,
        time: cells[4]?.textContent?.trim()||'',
        ageGrade: parseFloat(cells[5]?.textContent?.trim()?.replace('%',''))||null,
      };
    }));

    let count = 0;
    for (const r of rawResults) {
      if (!r||!r.event||!r.time||r.time==='--') continue;
      const dm = r.dateText.match(/(\d{2})\/(\d{2})\/(\d{4})/);
      if (!dm) continue;
      const date = `${dm[3]}-${dm[2]}-${dm[1]}`;
      const secs = parseTime(r.time);
      if (!secs) continue;
      upsertResult.run(athlete.id, date, r.event, r.time, secs, r.position, r.ageGrade);
      count++;
    }
    console.log(`  ✓ ${count} results upserted`);

    await sleep(jd(currentDelay));

    const sumUrl = `https://www.parkrun.org.uk/parkrunner/${athlete.id}/`;
    console.log(`  📋 Summary: ${sumUrl}`);
    const sumResult = await loadWithRetry(page, sumUrl, currentDelay);
    if (sumResult.success) {
      currentDelay = sumResult.delay;
      if (currentDelay > BASE_DELAY) currentDelay = BASE_DELAY + Math.floor((currentDelay-BASE_DELAY)/2);

      const summary = await page.evaluate(() => {
        const text = document.body.innerText;
        const badgeMatch = text.match(/Member of the parkrun (\d+) Club/);
        const ageMatch = text.match(/Most recent age category was ([A-Z0-9-]+)/);
        const ageGroup = ageMatch?ageMatch[1]:null;
        let gender = null;
        if (ageGroup) gender = (ageGroup.includes('W')||ageGroup.includes('F'))?'F':'M';
        let total5k=0, totalJunior=0;
        const m1 = text.match(/(\d+)\s+parkruns?\s+&\s+(\d+)\s+junior\s+parkruns?\s+total/);
        const m2 = text.match(/(\d+)\s+parkruns?\s+total/);
        if (m1) { total5k=parseInt(m1[1]); totalJunior=parseInt(m1[2]); }
        else if (m2) { total5k=parseInt(m2[1]); }
        let pb5k = null;
        for (const table of document.querySelectorAll('table')) {
          for (const row of table.querySelectorAll('tbody tr, tr')) {
            const rowText = Array.from(row.querySelectorAll('td,th')).map(c=>c.textContent.trim()).join('\t');
            if (rowText.includes('5k bests')) {
              for (const cell of row.querySelectorAll('td')) {
                if (/^\d{1,2}:\d{2}$/.test(cell.textContent.trim())) { pb5k=cell.textContent.trim(); break; }
              }
            }
          }
        }
        const volMatch = text.match(/Total Credits\s+(\d+)/);
        const volunteerCount = volMatch?parseInt(volMatch[1]):0;
        const juniorEvents = [];
        const es = text.match(/Event Summaries([\s\S]*?)(?:Volunteer Summary|$)/);
        if (es) { for (const l of es[1].split('\n')) { if (/junior\s+parkrun/i.test(l)) { const em=l.match(/^([A-Za-z\s]+?)\s+junior/i); if (em) juniorEvents.push(em[1].trim().toLowerCase().replace(/\s+/g,'') + '-juniors'); } } }
        return { badge: badgeMatch?parseInt(badgeMatch[1]):null, ageGroup, gender, total5k, totalJunior, pb5k, volunteerCount, juniorEvents };
      });

      const pbSecs = parseTime(summary.pb5k);
      savePrevVol.run(athlete.id);
      const computedBadge = computeBadge(summary.total5k||athlete.total_5k||0);
      updateAthlete.run(
        summary.ageGroup, summary.gender, summary.pb5k, pbSecs||null, computedBadge,
        summary.total5k, summary.total5k, summary.totalJunior, summary.totalJunior,
        summary.volunteerCount, summary.volunteerCount, athlete.id
      );
      db.prepare('UPDATE results SET is_junior=1 WHERE athlete_id=? AND event LIKE ?').run(athlete.id, '%junior%');
      for (const je of summary.juniorEvents) {
        db.prepare('UPDATE results SET is_junior=1 WHERE athlete_id=? AND event LIKE ?').run(athlete.id, `%${je}%`);
      }
      console.log(`  ✓ 5k: ${summary.total5k} | Jr: ${summary.totalJunior} | Vol: ${summary.volunteerCount} | PB: ${summary.pb5k||'—'} | Badge: ${computedBadge||'none'}`);
    }

    // Recalculate PBs
    db.prepare('UPDATE results SET is_pb=0 WHERE athlete_id=?').run(athlete.id);
    const results = db.prepare('SELECT rowid, time_seconds FROM results WHERE athlete_id=? AND is_junior=0 ORDER BY date ASC').all(athlete.id);
    let best = Infinity;
    for (const r of results) { if (r.time_seconds<best) { best=r.time_seconds; db.prepare('UPDATE results SET is_pb=1 WHERE rowid=?').run(r.rowid); } }

    const topEvent = db.prepare('SELECT event FROM results WHERE athlete_id=? AND is_junior=0 GROUP BY event ORDER BY COUNT(*) DESC LIMIT 1').get(athlete.id);
    if (topEvent) db.prepare('UPDATE athletes SET home_event=? WHERE id=?').run(topEvent.event, athlete.id);

    db.prepare('UPDATE athletes SET last_scraped_date=? WHERE id=?').run(today, athlete.id);
    successCount++;
    const gap = jd(currentDelay);
    console.log(`  ⏱️ Next in ${Math.round(gap/1000)}s`);
    await sleep(gap);
  }

  await browser.close();

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`✅ Done: ${successCount} succeeded, ${failCount} failed`);

  // Show Sep 5 results
  const sep5 = db.prepare(`
    SELECT a.name, r.event, r.time, r.position, r.age_grade
    FROM results r JOIN athletes a ON a.id=r.athlete_id
    WHERE r.date='2026-09-05' AND r.is_junior=0
    ORDER BY r.time_seconds
  `).all();
  console.log(`\n🏃 Sep 5 results: ${sep5.length} runners`);
  for (const s of sep5) {
    console.log(`  ${s.name.padEnd(28)} ${s.time.padEnd(8)} pos ${String(s.position).padStart(3)} AG ${s.age_grade||'—'} @ ${s.event}`);
  }

  db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
