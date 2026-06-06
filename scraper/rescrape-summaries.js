#!/usr/bin/env node
/**
 * Re-scrape athlete summary pages to get:
 * - Correct 5k PB (not junior)
 * - Age category
 * - Club badge (milestone)
 * - Gender
 * - Total 5k runs vs junior runs
 * Also mark junior results in the results table.
 */

const { chromium } = require('playwright');
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'parkrun.db');
const db = new Database(DB_PATH);

// Add columns if they don't exist
try { db.exec('ALTER TABLE athletes ADD COLUMN pb_5k TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE athletes ADD COLUMN pb_5k_seconds INTEGER'); } catch(e) {}
try { db.exec('ALTER TABLE athletes ADD COLUMN badge TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE athletes ADD COLUMN total_5k INTEGER DEFAULT 0'); } catch(e) {}
try { db.exec('ALTER TABLE athletes ADD COLUMN total_junior INTEGER DEFAULT 0'); } catch(e) {}
try { db.exec('ALTER TABLE athletes ADD COLUMN volunteer_count INTEGER DEFAULT 0'); } catch(e) {}
try { db.exec('ALTER TABLE results ADD COLUMN is_junior INTEGER DEFAULT 0'); } catch(e) {}

function parseTime(timeStr) {
  if (!timeStr) return 0;
  const parts = timeStr.trim().split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

async function scrapeSummary(page, athleteId) {
  const url = `https://www.parkrun.org.uk/parkrunner/${athleteId}/`;
  console.log(`\n🔍 ${athleteId}: ${url}`);
  
  const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  if (resp.status() === 403) {
    console.log('   ⚠️ 403 Forbidden — rate limited, skipping');
    return null;
  }
  await page.waitForTimeout(3000);

  const data = await page.evaluate(() => {
    const text = document.body.innerText;
    
    // Name (first big heading after navigation)
    let name = '';
    const h2s = document.querySelectorAll('h2');
    // parkrun pages often put the name in the first real content h2
    // But the summary page might use a different structure
    // Let's look for the pattern "Name (AXXXXXXX)"
    const nameMatch = text.match(/([A-Za-z\s]+)\s*\(A\d+\)/);
    if (nameMatch) name = nameMatch[1].trim();
    
    // Badge - "Member of the parkrun X Club"
    const badgeMatch = text.match(/Member of the parkrun (\d+) Club/);
    const badge = badgeMatch ? parseInt(badgeMatch[1]) : null;
    
    // Age category - "Most recent age category was XX"
    const ageMatch = text.match(/Most recent age category was ([A-Z0-9-]+)/);
    const ageGroup = ageMatch ? ageMatch[1] : null;
    
    // Gender from age group
    let gender = null;
    if (ageGroup) {
      if (ageGroup.startsWith('V') || ageGroup.startsWith('S') || ageGroup.startsWith('J')) {
        gender = ageGroup.includes('W') || ageGroup.includes('F') ? 'F' : 'M';
      }
    }
    
    // Total runs - "X parkruns total" or "X parkruns & Y junior parkrun(s) total"
    let total5k = 0;
    let totalJunior = 0;
    const totalMatch1 = text.match(/(\d+)\s+parkruns?\s+&\s+(\d+)\s+junior\s+parkruns?\s+total/);
    const totalMatch2 = text.match(/(\d+)\s+parkruns?\s+total/);
    if (totalMatch1) {
      total5k = parseInt(totalMatch1[1]);
      totalJunior = parseInt(totalMatch1[2]);
    } else if (totalMatch2) {
      total5k = parseInt(totalMatch2[1]);
    }
    
    // 5k PB from Event Summaries - look for "5k bests" row or the summary row
    // The table has: Event, parkruns, Best Gender Pos, Best Pos Overall, Best Time
    let pb5k = null;
    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      const rows = table.querySelectorAll('tbody tr, tr');
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td, th'));
        const rowText = cells.map(c => c.textContent.trim()).join('\t');
        
        // Look for "5k bests" row or the summary row (starts with total count)
        if (rowText.includes('5k bests') || rowText.includes('junior bests')) {
          if (rowText.includes('5k bests')) {
            // Find the time in this row (MM:SS pattern)
            for (const cell of cells) {
              const t = cell.textContent.trim();
              if (/^\d{1,2}:\d{2}$/.test(t)) {
                pb5k = t;
                break;
              }
            }
          }
        }
      }
      
      // If no "5k bests" row found, the last row is the summary
      if (!pb5k) {
        const allRows = table.querySelectorAll('tbody tr, tr');
        const lastRow = allRows[allRows.length - 1];
        if (lastRow) {
          const cells = Array.from(lastRow.querySelectorAll('td'));
          // The summary row typically has the total count matching total5k
          const firstCellText = cells[0]?.textContent.trim();
          // Check if this looks like a summary row (first cell is empty or has total)
          if (!firstCellText || firstCellText === '' || /^\d+$/.test(cells[1]?.textContent.trim())) {
            for (const cell of cells) {
              const t = cell.textContent.trim();
              if (/^\d{1,2}:\d{2}$/.test(t)) {
                pb5k = t;
                break;
              }
            }
          }
        }
      }
    }
    
    // If still no PB, try to find it from Event Summaries section
    // Look for the last row before "Volunteer Summary" that has a time
    if (!pb5k) {
      const eventSummaryMatch = text.match(/Event Summaries([\s\S]*?)(?:Volunteer Summary|$)/);
      if (eventSummaryMatch) {
        const lines = eventSummaryMatch[1].split('\n');
        for (const line of lines) {
          // Find the summary/total line - it has a time pattern
          const timeMatch = line.match(/(\d{1,2}:\d{2})\s+All/);
          if (timeMatch) {
            pb5k = timeMatch[1]; // Keep updating - last one will be the overall total
          }
        }
      }
    }
    
    // Volunteer count
    const volMatch = text.match(/Total Credits\s+(\d+)/);
    const volunteerCount = volMatch ? parseInt(volMatch[1]) : 0;
    
    // Identify junior events from Event Summaries
    const juniorEvents = [];
    const eventSummaryMatch = text.match(/Event Summaries([\s\S]*?)(?:Volunteer Summary|$)/);
    if (eventSummaryMatch) {
      const lines = eventSummaryMatch[1].split('\n');
      for (const line of lines) {
        if (/junior\s+parkrun/i.test(line)) {
          // Extract event name
          const eventMatch = line.match(/^([A-Za-z\s]+?)\s+junior\s+parkrun/i);
          if (eventMatch) {
            juniorEvents.push(eventMatch[1].trim().toLowerCase().replace(/\s+/g, '') + '-juniors');
          }
        }
      }
    }
    
    return { name, badge, ageGroup, gender, total5k, totalJunior, pb5k, volunteerCount, juniorEvents };
  });

  console.log(`   Name: ${data.name}`);
  console.log(`   Badge: ${data.badge ? data.badge + ' Club' : 'none'}`);
  console.log(`   Age: ${data.ageGroup}, Gender: ${data.gender}`);
  console.log(`   5k runs: ${data.total5k}, Junior: ${data.totalJunior}`);
  console.log(`   5k PB: ${data.pb5k}`);
  console.log(`   Volunteers: ${data.volunteerCount}`);
  if (data.juniorEvents.length > 0) console.log(`   Junior events: ${data.juniorEvents.join(', ')}`);
  
  return data;
}

async function main() {
  const athletes = db.prepare('SELECT id, name FROM athletes ORDER BY name').all();
  console.log(`🏃 Re-scraping ${athletes.length} athlete summaries...\n`);

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    locale: 'en-GB',
  });
  const page = await context.newPage();

  const updateAthlete = db.prepare(`
    UPDATE athletes SET 
      age_group = COALESCE(?, age_group),
      gender = COALESCE(?, gender),
      pb_5k = ?,
      pb_5k_seconds = ?,
      badge = ?,
      total_5k = ?,
      total_junior = ?,
      volunteer_count = ?
    WHERE id = ?
  `);

  // Mark junior results
  const markJunior = db.prepare(`
    UPDATE results SET is_junior = 1 
    WHERE athlete_id = ? AND event LIKE '%junior%'
  `);

  for (const athlete of athletes) {
    try {
      const data = await scrapeSummary(page, athlete.id);
      if (!data) continue;

      const pb5kSeconds = parseTime(data.pb5k);
      
      updateAthlete.run(
        data.ageGroup,
        data.gender,
        data.pb5k,
        pb5kSeconds || null,
        data.badge ? String(data.badge) : null,
        data.total5k,
        data.totalJunior,
        data.volunteerCount,
        athlete.id
      );

      // Mark junior results
      markJunior.run(athlete.id);
      
      // Also mark results from known junior events
      for (const je of data.juniorEvents) {
        db.prepare('UPDATE results SET is_junior = 1 WHERE athlete_id = ? AND event LIKE ?')
          .run(athlete.id, `%${je}%`);
      }

      // Recalculate PBs — only for 5k results
      db.prepare('UPDATE results SET is_pb = 0 WHERE athlete_id = ?').run(athlete.id);
      const results = db.prepare(
        'SELECT rowid, date, time_seconds FROM results WHERE athlete_id = ? AND is_junior = 0 ORDER BY date ASC'
      ).all(athlete.id);
      
      let bestTime = Infinity;
      for (const r of results) {
        if (r.time_seconds < bestTime) {
          bestTime = r.time_seconds;
          db.prepare('UPDATE results SET is_pb = 1 WHERE rowid = ?').run(r.rowid);
        }
      }

      console.log(`   ✅ Updated`);
      
      // Be nice
      await page.waitForTimeout(3000);
    } catch (err) {
      console.error(`   ❌ ${athlete.name}: ${err.message}`);
    }
  }

  await browser.close();

  // Summary
  console.log('\n\n📊 Final summary:');
  const all = db.prepare(`
    SELECT a.name, a.badge, a.age_group, a.gender, a.pb_5k, a.total_5k, a.total_junior, a.volunteer_count,
      (SELECT COUNT(*) FROM results r WHERE r.athlete_id = a.id AND r.is_junior = 0) as db_5k,
      (SELECT COUNT(*) FROM results r WHERE r.athlete_id = a.id AND r.is_junior = 1) as db_junior
    FROM athletes a ORDER BY a.name
  `).all();
  
  for (const a of all) {
    const badgeStr = a.badge ? `🏅${a.badge}` : '';
    console.log(`  ${a.name.padEnd(25)} ${(a.age_group||'').padEnd(10)} PB: ${(a.pb_5k||'—').padEnd(8)} 5k: ${a.total_5k} Jr: ${a.total_junior} Vol: ${a.volunteer_count} ${badgeStr}`);
  }

  db.close();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
