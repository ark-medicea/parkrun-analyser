#!/usr/bin/env node
/**
 * Scrape real parkrun athletes by ID: get name, age group, gender, and full results history.
 * Adds them to the SQLite database.
 */

const { chromium } = require('playwright');
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'parkrun.db');
const db = new Database(DB_PATH);

// Ensure tables exist
db.exec(`
  CREATE TABLE IF NOT EXISTS athletes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    gender TEXT,
    age_group TEXT,
    home_event TEXT DEFAULT 'cassiobury',
    added_at TEXT DEFAULT (datetime('now')),
    active INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    athlete_id TEXT NOT NULL REFERENCES athletes(id),
    date TEXT NOT NULL,
    event TEXT NOT NULL,
    time TEXT NOT NULL,
    time_seconds INTEGER NOT NULL,
    position INTEGER,
    age_grade REAL,
    is_pb INTEGER DEFAULT 0,
    UNIQUE(athlete_id, date, event)
  );
  CREATE INDEX IF NOT EXISTS idx_results_athlete ON results(athlete_id, date);
  CREATE INDEX IF NOT EXISTS idx_results_date ON results(date);
`);

const ATHLETE_IDS = [
  '1589031', '3606999', '6112581', '2757398', '1823382'
];

const insertAthlete = db.prepare(`
  INSERT OR REPLACE INTO athletes (id, name, gender, age_group, home_event)
  VALUES (?, ?, ?, ?, ?)
`);

const insertResult = db.prepare(`
  INSERT OR IGNORE INTO results (athlete_id, date, event, time, time_seconds, position, age_grade, is_pb)
  VALUES (?, ?, ?, ?, ?, ?, ?, 0)
`);

const updatePB = db.prepare(`
  UPDATE results SET is_pb = ? WHERE athlete_id = ? AND date = ? AND event = ?
`);

function parseTime(timeStr) {
  const parts = timeStr.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

async function scrapeAthlete(page, athleteId) {
  const url = `https://www.parkrun.org.uk/parkrunner/${athleteId}/all/`;
  console.log(`\n🔍 Scraping athlete ${athleteId}...`);
  console.log(`   URL: ${url}`);

  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  
  // Wait for content to render
  await page.waitForTimeout(3000);

  // Try to find the results table
  const hasTable = await page.$('table');
  if (!hasTable) {
    // Try waiting longer
    await page.waitForTimeout(5000);
  }

  const data = await page.evaluate(() => {
    // Get athlete name - try various selectors
    let name = '';
    const h2 = document.querySelector('h2');
    if (h2) name = h2.textContent.trim();
    if (!name) {
      const h1 = document.querySelector('h1');
      if (h1) name = h1.textContent.trim();
    }
    // Clean up name - remove any extra text
    name = name.replace(/['']s parkrun summary/i, '').trim();

    // Try to get summary info from page text
    const bodyText = document.body.innerText;
    
    // Extract results from table
    const rows = document.querySelectorAll('table tbody tr');
    const results = [];

    rows.forEach(row => {
      const cells = row.querySelectorAll('td');
      if (cells.length < 5) return;
      
      // Standard parkrun history table: Event, Date, EventNumber, Pos, Time, AgeGrade, PB?
      // But column order can vary - let's be flexible
      const texts = Array.from(cells).map(c => c.textContent.trim());
      
      // Find the time (MM:SS or H:MM:SS pattern)
      let timeText = '';
      let timeIdx = -1;
      for (let i = 0; i < texts.length; i++) {
        if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(texts[i])) {
          timeText = texts[i];
          timeIdx = i;
          break;
        }
      }
      
      // Find the date (DD/MM/YYYY pattern)
      let dateText = '';
      for (let i = 0; i < texts.length; i++) {
        if (/^\d{2}\/\d{2}\/\d{4}$/.test(texts[i])) {
          dateText = texts[i];
          break;
        }
      }
      
      // Find age grade (XX.XX% pattern)
      let ageGrade = 0;
      for (const t of texts) {
        const m = t.match(/(\d+\.\d+)\s*%/);
        if (m) { ageGrade = parseFloat(m[1]); break; }
      }
      
      // Find event name (first cell with a link usually)
      let event = '';
      const eventLink = cells[0]?.querySelector('a');
      if (eventLink) {
        const href = eventLink.getAttribute('href') || '';
        const m = href.match(/parkrun\.org\.uk\/([^/]+)\//);
        event = m ? m[1] : eventLink.textContent.trim().toLowerCase().replace(/\s+/g, '');
      } else {
        event = texts[0].toLowerCase().replace(/\s+/g, '');
      }

      // Position - find a plain number
      let position = 0;
      for (let i = 0; i < texts.length; i++) {
        if (i !== timeIdx && /^\d+$/.test(texts[i]) && parseInt(texts[i]) < 2000) {
          position = parseInt(texts[i]);
          break;
        }
      }

      if (dateText && timeText) {
        // Convert DD/MM/YYYY to YYYY-MM-DD
        const [d, m, y] = dateText.split('/');
        const isoDate = `${y}-${m}-${d}`;
        
        results.push({
          date: isoDate,
          event,
          time: timeText,
          position,
          ageGrade,
        });
      }
    });

    return { name, results, bodyText: bodyText.substring(0, 2000) };
  });

  console.log(`   Name: ${data.name || 'UNKNOWN'}`);
  console.log(`   Results found: ${data.results.length}`);

  if (!data.name) {
    console.log(`   ⚠ Could not extract name. Page text preview:`);
    console.log(`   ${data.bodyText.substring(0, 200)}`);
  }

  return data;
}

async function main() {
  console.log('🏃 Scraping real parkrun athletes...');
  console.log(`   Athletes to process: ${ATHLETE_IDS.join(', ')}\n`);

  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  for (const athleteId of ATHLETE_IDS) {
    try {
      const data = await scrapeAthlete(page, athleteId);

      if (!data.name || data.results.length === 0) {
        console.log(`   ❌ Skipping ${athleteId} — no data extracted`);
        continue;
      }

      // Determine gender/age group from name or results context
      // We'll set these as unknown for now - can be updated later
      insertAthlete.run(athleteId, data.name, null, null, 'cassiobury');
      console.log(`   ✅ Added athlete: ${data.name}`);

      // Insert results
      let count = 0;
      for (const r of data.results) {
        const timeSeconds = parseTime(r.time);
        if (timeSeconds > 0) {
          insertResult.run(athleteId, r.date, r.event, r.time, timeSeconds, r.position, r.ageGrade);
          count++;
        }
      }
      console.log(`   ✅ Inserted ${count} results`);

      // Recalculate PBs for this athlete
      const results = db.prepare(
        'SELECT date, event, time_seconds FROM results WHERE athlete_id = ? ORDER BY date ASC, time_seconds ASC'
      ).all(athleteId);
      
      let bestTime = Infinity;
      for (const r of results) {
        if (r.time_seconds < bestTime) {
          bestTime = r.time_seconds;
          updatePB.run(1, athleteId, r.date, r.event);
        }
      }

      // Be nice to the server
      await page.waitForTimeout(3000);

    } catch (err) {
      console.error(`   ❌ Failed to scrape ${athleteId}: ${err.message}`);
    }
  }

  await browser.close();

  // Summary
  const athleteCount = db.prepare('SELECT COUNT(*) as c FROM athletes').get().c;
  const resultCount = db.prepare('SELECT COUNT(*) as c FROM results').get().c;
  const pbCount = db.prepare('SELECT COUNT(*) as c FROM results WHERE is_pb = 1').get().c;
  
  console.log(`\n✨ Done!`);
  console.log(`   Athletes: ${athleteCount}`);
  console.log(`   Results: ${resultCount}`);
  console.log(`   PBs: ${pbCount}`);

  db.close();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
