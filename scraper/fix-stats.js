#!/usr/bin/env node
/**
 * Recalculate PBs and athlete stats from the scraped results.
 */
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'parkrun.db');

async function main() {
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(DB_PATH));

  // Get all athletes
  const athleteStmt = db.prepare('SELECT id, name FROM athletes ORDER BY name');
  const athletes = [];
  while (athleteStmt.step()) athletes.push(athleteStmt.getAsObject());
  athleteStmt.free();

  console.log(`📊 Recalculating PBs for ${athletes.length} athletes...`);
  db.run('UPDATE results SET is_pb = 0');

  for (const athlete of athletes) {
    // 5k PBs
    const stmt5k = db.prepare(
      'SELECT id, time_seconds FROM results WHERE athlete_id = ? AND is_junior = 0 ORDER BY date ASC'
    );
    stmt5k.bind([athlete.id]);
    let best5k = Infinity;
    while (stmt5k.step()) {
      const row = stmt5k.getAsObject();
      if (row.time_seconds > 0 && row.time_seconds < best5k) {
        best5k = row.time_seconds;
        db.run('UPDATE results SET is_pb = 1 WHERE id = ?', [row.id]);
      }
    }
    stmt5k.free();

    // Junior PBs
    const stmtJr = db.prepare(
      'SELECT id, time_seconds FROM results WHERE athlete_id = ? AND is_junior = 1 ORDER BY date ASC'
    );
    stmtJr.bind([athlete.id]);
    let bestJr = Infinity;
    while (stmtJr.step()) {
      const row = stmtJr.getAsObject();
      if (row.time_seconds > 0 && row.time_seconds < bestJr) {
        bestJr = row.time_seconds;
        db.run('UPDATE results SET is_pb = 1 WHERE id = ?', [row.id]);
      }
    }
    stmtJr.free();
  }

  console.log('📊 Recalculating athlete stats...');
  for (const athlete of athletes) {
    // Count from results
    const countStmt = db.prepare(
      `SELECT
        COALESCE(SUM(CASE WHEN is_junior = 0 THEN 1 ELSE 0 END), 0) AS total_5k,
        COALESCE(SUM(CASE WHEN is_junior = 1 THEN 1 ELSE 0 END), 0) AS total_junior
      FROM results WHERE athlete_id = ?`
    );
    countStmt.bind([athlete.id]);
    countStmt.step();
    const counts = countStmt.getAsObject();
    countStmt.free();

    // Get PB
    const pbStmt = db.prepare(
      `SELECT time, time_seconds FROM results
       WHERE athlete_id = ? AND is_junior = 0 AND time_seconds > 0
       ORDER BY time_seconds ASC LIMIT 1`
    );
    pbStmt.bind([athlete.id]);
    let pbTime = null, pbSeconds = null;
    if (pbStmt.step()) {
      const pb = pbStmt.getAsObject();
      pbTime = pb.time || null;
      pbSeconds = pb.time_seconds || null;
    }
    pbStmt.free();

    db.run(
      `UPDATE athletes SET total_5k = ?, total_junior = ?, pb_5k = ?, pb_5k_seconds = ? WHERE id = ?`,
      [counts.total_5k, counts.total_junior, pbTime, pbSeconds, athlete.id]
    );
  }

  // Save
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));

  // Print summary
  console.log('\n' + '═'.repeat(70));
  console.log('📊 FINAL SUMMARY');
  console.log('═'.repeat(70));

  const summaryStmt = db.prepare(
    `SELECT a.name, a.total_5k, a.total_junior, a.volunteer_count, a.pb_5k, a.badge,
       (SELECT COUNT(*) FROM results r WHERE r.athlete_id = a.id AND r.is_junior = 0) as db_5k,
       (SELECT COUNT(*) FROM results r WHERE r.athlete_id = a.id AND r.is_junior = 1) as db_junior
     FROM athletes a ORDER BY a.name`
  );
  while (summaryStmt.step()) {
    const a = summaryStmt.getAsObject();
    const mismatch = (a.total_5k !== a.db_5k || a.total_junior !== a.db_junior) ? ' ⚠️' : '';
    console.log(`  ${String(a.name).padEnd(25)} 5k=${String(a.total_5k).padStart(3)} Jr=${String(a.total_junior).padStart(2)}  PB=${(a.pb_5k || '—').toString().padEnd(7)}  Vol=${String(a.volunteer_count).padStart(3)}  Badge=${a.badge || '—'}${mismatch}`);
  }
  summaryStmt.free();

  db.close();
  console.log('\n✅ Done!');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
