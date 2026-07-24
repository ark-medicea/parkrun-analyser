#!/usr/bin/env node
/**
 * Full re-scrape: wipe results, re-fetch every athlete's complete history
 * and summary from parkrun.org.uk, rebuild stats.
 * 
 * Gentle on parkrun servers: 20s delay between page loads.
 */

const { chromium } = require('playwright');
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'parkrun.db');
const DELAY_MS = 20000; // 20s between page loads

function parseTime(timeStr) {
  if (!timeStr) return 0;
  const parts = timeStr.trim().split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function scrapeAllResults(page, athleteId, athleteName) {
  const url = `https://www.parkrun.org.uk/parkrunner/${athleteId}/all/`;
  console.log(`\n📋 ${athleteName} (${athleteId}) — fetching all results...`);
  console.log(`   ${url}`);

  try {
    const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    if (resp.status() === 403) {
      console.log('   ⚠️ 403 — rate limited!');
      return { results: [], rateLimited: true };
    }

    // Wait for results table
    await page.waitForSelector('#results tbody tr', { timeout: 15000 }).catch(() => {
      console.log('   ⚠ Results table not found');
    });

    const results = await page.$$eval('#results tbody tr', (trs) =>
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

        return { event, dateText, position, time, ageGrade };
      })
    );

    const parsed = [];
    for (const r of results) {
      if (!r || !r.event || !r.time || r.time === '--') continue;
      const dateParts = r.dateText.match(/(\d{2})\/(\d{2})\/(\d{4})/);
      if (!dateParts) continue;
      const date = `${dateParts[3]}-${dateParts[2]}-${dateParts[1]}`;
      const timeSeconds = parseTime(r.time);
      if (!timeSeconds) continue;

      // Detect junior events
      const isJunior = /junior/i.test(r.event) ? 1 : 0;

      parsed.push({
        athlete_id: athleteId,
        date,
        event: r.event,
        time: r.time,
        time_seconds: timeSeconds,
        position: r.position,
        age_grade: r.ageGrade,
        is_junior: isJunior
      });
    }

    console.log(`   ✓ Found ${parsed.length} results (${parsed.filter(r => r.is_junior).length} junior)`);
    return { results: parsed, rateLimited: false };
  } catch (err) {
    console.error(`   ❌ Error: ${err.message}`);
    return { results: [], rateLimited: false };
  }
}

async function scrapeSummary(page, athleteId, athleteName) {
  const url = `https://www.parkrun.org.uk/parkrunner/${athleteId}/`;
  console.log(`   🔍 Fetching summary...`);

  try {
    const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    if (resp.status() === 403) {
      console.log('   ⚠️ 403 — rate limited on summary!');
      return null;
    }

    await page.waitForTimeout(3000);

    const data = await page.evaluate(() => {
      const text = document.body.innerText;

      // Badge
      const badgeMatch = text.match(/Member of the parkrun (\d+) Club/);
      const badge = badgeMatch ? parseInt(badgeMatch[1]) : null;

      // Age category
      const ageMatch = text.match(/Most recent age category was ([A-Z0-9-]+)/);
      const ageGroup = ageMatch ? ageMatch[1] : null;

      // Gender from age group
      let gender = null;
      if (ageGroup) {
        gender = ageGroup.includes('W') || ageGroup.includes('F') ? 'F' : 'M';
      }

      // Total runs from parkrun's own count
      let total5k = 0, totalJunior = 0;
      const totalMatch1 = text.match(/(\d+)\s+parkruns?\s+&\s+(\d+)\s+junior\s+parkruns?\s+total/);
      const totalMatch2 = text.match(/(\d+)\s+parkruns?\s+total/);
      if (totalMatch1) {
        total5k = parseInt(totalMatch1[1]);
        totalJunior = parseInt(totalMatch1[2]);
      } else if (totalMatch2) {
        total5k = parseInt(totalMatch2[1]);
      }

      // Volunteer count
      const volMatch = text.match(/Total Credits\s+(\d+)/);
      const volunteerCount = volMatch ? parseInt(volMatch[1]) : 0;

      // 5k PB from "5k bests" row in Event Summaries table
      let pb5k = null;
      const tables = document.querySelectorAll('table');
      for (const table of tables) {
        const rows = table.querySelectorAll('tbody tr, tr');
        for (const row of rows) {
          const cells = Array.from(row.querySelectorAll('td, th'));
          const rowText = cells.map(c => c.textContent.trim()).join('\t');
          if (rowText.includes('5k bests')) {
            for (const cell of cells) {
              const t = cell.textContent.trim();
              if (/^\d{1,2}:\d{2}$/.test(t) || /^\d{1,2}:\d{2}:\d{2}$/.test(t)) {
                pb5k = t;
                break;
              }
            }
          }
        }
      }

      return { badge, ageGroup, gender, total5k, totalJunior, volunteerCount, pb5k };
    });

    console.log(`   Summary: 5k=${data.total5k} Jr=${data.totalJunior} Vol=${data.volunteerCount} PB=${data.pb5k || '—'} Badge=${data.badge || '—'}`);
    return data;
  } catch (err) {
    console.error(`   ❌ Summary error: ${err.message}`);
    return null;
  }
}

async function main() {
  // Load DB
  const SQL = await initSqlJs();
  const buffer = fs.readFileSync(DB_PATH);

  // Backup first
  const backupPath = DB_PATH + '.backup-' + new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(DB_PATH, backupPath);
  console.log(`💾 Backed up to ${backupPath}`);

  const db = new SQL.Database(buffer);

  // Get all athletes
  const stmt = db.prepare('SELECT id, name FROM athletes WHERE active = 1 ORDER BY name');
  const athletes = [];
  while (stmt.step()) {
    athletes.push(stmt.getAsObject());
  }
  stmt.free();

  console.log(`\n🏃 ${athletes.length} athletes to re-scrape`);
  console.log(`⏱️  Estimated time: ~${Math.ceil(athletes.length * 2 * DELAY_MS / 60000)} minutes (${DELAY_MS/1000}s between pages)\n`);

  // Wipe all results
  db.run('DELETE FROM results');
  db.run("DELETE FROM sqlite_sequence WHERE name='results'");
  console.log('🗑️  Wiped all results from DB\n');

  // Launch browser
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    locale: 'en-GB',
  });
  const page = await context.newPage();

  let totalResults = 0;
  let rateLimitHits = 0;

  for (let i = 0; i < athletes.length; i++) {
    const athlete = athletes[i];
    console.log(`\n━━━ [${i + 1}/${athletes.length}] ${athlete.name} ━━━`);

    // 1) Scrape all results
    const { results, rateLimited } = await scrapeAllResults(page, athlete.id, athlete.name);
    if (rateLimited) {
      rateLimitHits++;
      console.log('   ⏳ Rate limited — waiting 60s extra...');
      await sleep(60000);
      // Retry once
      const retry = await scrapeAllResults(page, athlete.id, athlete.name);
      if (retry.rateLimited) {
        console.log('   ❌ Still rate limited, skipping');
        continue;
      }
      for (const r of retry.results) {
        db.run(
          `INSERT OR REPLACE INTO results (athlete_id, date, event, time, time_seconds, position, age_grade, is_pb, is_junior)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
          [r.athlete_id, r.date, r.event, r.time, r.time_seconds, r.position, r.age_grade, r.is_junior]
        );
      }
      totalResults += retry.results.length;
    } else {
      for (const r of results) {
        db.run(
          `INSERT OR REPLACE INTO results (athlete_id, date, event, time, time_seconds, position, age_grade, is_pb, is_junior)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
          [r.athlete_id, r.date, r.event, r.time, r.time_seconds, r.position, r.age_grade, r.is_junior]
        );
      }
      totalResults += results.length;
    }

    await sleep(DELAY_MS);

    // 2) Scrape summary
    const summary = await scrapeSummary(page, athlete.id, athlete.name);
    if (summary) {
      const pb5kSeconds = parseTime(summary.pb5k);
      db.run(
        `UPDATE athletes SET
          age_group = COALESCE(?, age_group),
          gender = COALESCE(?, gender),
          pb_5k = ?,
          pb_5k_seconds = ?,
          badge = ?,
          total_5k = ?,
          total_junior = ?,
          volunteer_count = ?
        WHERE id = ?`,
        [
          summary.ageGroup,
          summary.gender,
          summary.pb5k,
          pb5kSeconds || null,
          summary.badge ? String(summary.badge) : null,
          summary.total5k,
          summary.totalJunior,
          summary.volunteerCount,
          athlete.id
        ]
      );
    }

    await sleep(DELAY_MS);

    // Save DB after each athlete (in case of crash)
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
    console.log(`   💾 Saved (${totalResults} total results so far)`);
  }

  await browser.close();

  // Recalculate PBs
  console.log('\n📊 Recalculating PBs...');
  db.run('UPDATE results SET is_pb = 0');

  for (const athlete of athletes) {
    // 5k PBs
    const stmt5k = db.prepare(
      'SELECT rowid, time_seconds FROM results WHERE athlete_id = ? AND is_junior = 0 ORDER BY date ASC'
    );
    stmt5k.bind([athlete.id]);
    let best5k = Infinity;
    while (stmt5k.step()) {
      const row = stmt5k.getAsObject();
      if (row.time_seconds < best5k) {
        best5k = row.time_seconds;
        db.run('UPDATE results SET is_pb = 1 WHERE rowid = ?', [row.rowid]);
      }
    }
    stmt5k.free();

    // Junior PBs
    const stmtJr = db.prepare(
      'SELECT rowid, time_seconds FROM results WHERE athlete_id = ? AND is_junior = 1 ORDER BY date ASC'
    );
    stmtJr.bind([athlete.id]);
    let bestJr = Infinity;
    while (stmtJr.step()) {
      const row = stmtJr.getAsObject();
      if (row.time_seconds < bestJr) {
        bestJr = row.time_seconds;
        db.run('UPDATE results SET is_pb = 1 WHERE rowid = ?', [row.rowid]);
      }
    }
    stmtJr.free();
  }

  // Recalculate athlete stats from results
  console.log('📊 Recalculating athlete stats from results...');
  for (const athlete of athletes) {
    const countStmt = db.prepare(
      `SELECT
        SUM(CASE WHEN is_junior = 0 THEN 1 ELSE 0 END) AS total_5k,
        SUM(CASE WHEN is_junior = 1 THEN 1 ELSE 0 END) AS total_junior
      FROM results WHERE athlete_id = ?`
    );
    countStmt.bind([athlete.id]);
    countStmt.step();
    const counts = countStmt.getAsObject();
    countStmt.free();

    const pbStmt = db.prepare(
      `SELECT time AS pb_5k, time_seconds AS pb_5k_seconds
       FROM results WHERE athlete_id = ? AND is_junior = 0
       ORDER BY time_seconds ASC LIMIT 1`
    );
    pbStmt.bind([athlete.id]);
    let pb = {};
    if (pbStmt.step()) pb = pbStmt.getAsObject();
    pbStmt.free();

    db.run(
      `UPDATE athletes SET total_5k = ?, total_junior = ?, pb_5k = ?, pb_5k_seconds = ? WHERE id = ?`,
      [counts.total_5k || 0, counts.total_junior || 0, pb.pb_5k || null, pb.pb_5k_seconds || null, athlete.id]
    );
  }

  // Final save
  const finalData = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(finalData));
  db.close();

  // Print final summary
  console.log('\n\n' + '═'.repeat(70));
  console.log('📊 FINAL SUMMARY');
  console.log('═'.repeat(70));

  const finalDb = new SQL.Database(fs.readFileSync(DB_PATH));
  const summaryStmt = finalDb.prepare(
    `SELECT a.name, a.total_5k, a.total_junior, a.volunteer_count, a.pb_5k, a.badge,
       (SELECT COUNT(*) FROM results r WHERE r.athlete_id = a.id AND r.is_junior = 0) as db_5k,
       (SELECT COUNT(*) FROM results r WHERE r.athlete_id = a.id AND r.is_junior = 1) as db_junior
     FROM athletes a ORDER BY a.name`
  );
  while (summaryStmt.step()) {
    const a = summaryStmt.getAsObject();
    const mismatch = (a.total_5k !== a.db_5k || a.total_junior !== a.db_junior) ? ' ⚠️ MISMATCH' : '';
    console.log(`  ${String(a.name).padEnd(25)} Site: 5k=${a.total_5k} Jr=${a.total_junior}  DB: 5k=${a.db_5k} Jr=${a.db_junior}  PB=${a.pb_5k || '—'}  Vol=${a.volunteer_count}  Badge=${a.badge || '—'}${mismatch}`);
  }
  summaryStmt.free();
  finalDb.close();

  console.log(`\n✅ Done! ${totalResults} results scraped. ${rateLimitHits} rate limit hits.`);
  console.log(`DB saved to: ${DB_PATH}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
