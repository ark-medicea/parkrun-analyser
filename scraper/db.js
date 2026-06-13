const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'parkrun.db');

let _sqlPromise = null;

function getSqlJs() {
  if (!_sqlPromise) {
    _sqlPromise = initSqlJs();
  }
  return _sqlPromise;
}

async function getDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const SQL = await getSqlJs();
  let db;

  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  // Create tables if needed
  db.run(`
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
  `);

  db.run('CREATE INDEX IF NOT EXISTS idx_results_athlete ON results(athlete_id, date)');
  db.run('CREATE INDEX IF NOT EXISTS idx_results_date ON results(date)');

  return db;
}

function saveDb(db) {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function parseTime(timeStr) {
  const parts = timeStr.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

function queryAll(db, sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function upsertAthlete(db, athlete) {
  db.run(
    `INSERT INTO athletes (id, name, gender, age_group, home_event)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = COALESCE(excluded.name, athletes.name),
       gender = COALESCE(excluded.gender, athletes.gender),
       age_group = COALESCE(excluded.age_group, athletes.age_group)`,
    [
      athlete.id,
      athlete.name,
      athlete.gender || null,
      athlete.age_group || null,
      athlete.home_event || 'cassiobury',
    ]
  );
}

function upsertResult(db, result) {
  const timeSeconds =
    typeof result.time_seconds === 'number'
      ? result.time_seconds
      : parseTime(result.time);

  db.run(
    `INSERT INTO results (athlete_id, date, event, time, time_seconds, position, age_grade, is_pb)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(athlete_id, date, event) DO UPDATE SET
       time = excluded.time,
       time_seconds = excluded.time_seconds,
       position = COALESCE(excluded.position, results.position),
       age_grade = COALESCE(excluded.age_grade, results.age_grade)`,
    [
      result.athlete_id,
      result.date,
      result.event,
      result.time,
      timeSeconds,
      result.position || null,
      result.age_grade || null,
    ]
  );
}

function getAthletes(db, activeOnly = true) {
  const sql = activeOnly
    ? 'SELECT * FROM athletes WHERE active = 1 ORDER BY name'
    : 'SELECT * FROM athletes ORDER BY name';
  return queryAll(db, sql);
}

function getResults(db, athleteId) {
  return queryAll(
    db,
    'SELECT * FROM results WHERE athlete_id = ? ORDER BY date ASC',
    [athleteId]
  );
}

function recalculatePBs(db) {
  db.run('UPDATE results SET is_pb = 0');

  const athletes = queryAll(db, 'SELECT id FROM athletes');

  for (const athlete of athletes) {
    // Recalculate PBs for 5k results (non-junior)
    const results5k = queryAll(
      db,
      'SELECT id, time_seconds FROM results WHERE athlete_id = ? AND is_junior = 0 ORDER BY date ASC, event ASC',
      [athlete.id]
    );

    let bestTime5k = Infinity;
    for (const r of results5k) {
      if (r.time_seconds < bestTime5k) {
        bestTime5k = r.time_seconds;
        db.run('UPDATE results SET is_pb = 1 WHERE id = ?', [r.id]);
      }
    }

    // Recalculate PBs for junior results separately
    const resultsJr = queryAll(
      db,
      'SELECT id, time_seconds FROM results WHERE athlete_id = ? AND is_junior = 1 ORDER BY date ASC, event ASC',
      [athlete.id]
    );

    let bestTimeJr = Infinity;
    for (const r of resultsJr) {
      if (r.time_seconds < bestTimeJr) {
        bestTimeJr = r.time_seconds;
        db.run('UPDATE results SET is_pb = 1 WHERE id = ?', [r.id]);
      }
    }
  }
}

function recalculateAthleteStats(db) {
  const athletes = queryAll(db, 'SELECT id FROM athletes');

  for (const athlete of athletes) {
    const stats = queryAll(
      db,
      `SELECT
        SUM(CASE WHEN is_junior = 0 THEN 1 ELSE 0 END) AS total_5k,
        SUM(CASE WHEN is_junior = 1 THEN 1 ELSE 0 END) AS total_junior,
        MIN(CASE WHEN is_junior = 0 THEN time ELSE NULL END) AS pb_5k,
        MIN(CASE WHEN is_junior = 0 THEN time_seconds ELSE NULL END) AS pb_5k_seconds
      FROM results WHERE athlete_id = ?`,
      [athlete.id]
    );

    if (stats.length > 0) {
      const s = stats[0];
      db.run(
        `UPDATE athletes SET
          total_5k = ?,
          total_junior = ?,
          pb_5k = ?,
          pb_5k_seconds = ?
        WHERE id = ?`,
        [s.total_5k || 0, s.total_junior || 0, s.pb_5k || null, s.pb_5k_seconds || null, athlete.id]
      );
    }
  }
}

module.exports = {
  getDb,
  saveDb,
  DB_PATH,
  parseTime,
  queryAll,
  upsertAthlete,
  upsertResult,
  getAthletes,
  getResults,
  recalculatePBs,
  recalculateAthleteStats,
};
