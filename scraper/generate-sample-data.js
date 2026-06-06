#!/usr/bin/env node
/**
 * Generate a sample SQLite database with realistic parkrun data.
 */

const { getDb, saveDb, upsertAthlete, upsertResult, recalculatePBs, queryAll } = require('./db');

const athletes = [
  { id: '1000001', name: 'Hasnain PANJU',   gender: 'M', age_group: 'VM45-49' },
  { id: '1000002', name: 'Zahra PANJU',     gender: 'F', age_group: 'VW40-44' },
  { id: '1000003', name: 'Rahim MEGHJEE',   gender: 'M', age_group: 'VM35-39' },
  { id: '1000004', name: 'Fatima MEGHJEE',  gender: 'F', age_group: 'SW30-34' },
  { id: '1000005', name: 'Karim TEJANI',    gender: 'M', age_group: 'VM50-54' },
  { id: '1000006', name: 'Sara TEJANI',     gender: 'F', age_group: 'VW45-49' },
  { id: '1000007', name: 'Ali KANANI',      gender: 'M', age_group: 'SM25-29' },
  { id: '1000008', name: 'Nadia KANANI',    gender: 'F', age_group: 'SW30-34' },
];

const baseTimes = {
  '1000001': 24 * 60 + 30,
  '1000002': 28 * 60 + 15,
  '1000003': 21 * 60 + 45,
  '1000004': 26 * 60 + 0,
  '1000005': 27 * 60 + 20,
  '1000006': 31 * 60 + 10,
  '1000007': 19 * 60 + 50,
  '1000008': 25 * 60 + 30,
};

const baseAgeGrades = {
  '1000001': 58.5,
  '1000002': 55.2,
  '1000003': 65.0,
  '1000004': 56.8,
  '1000005': 54.3,
  '1000006': 50.1,
  '1000007': 70.2,
  '1000008': 57.5,
};

const events = ['cassiobury', 'bushy', 'rickmansworth', 'tring'];

function seededRandom(seed) {
  let s = seed;
  return function () {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

async function generateResults() {
  const db = await getDb();
  const rng = seededRandom(42);

  console.log('Inserting athletes...');
  for (const a of athletes) {
    upsertAthlete(db, { ...a, home_event: 'cassiobury' });
    console.log(`  ✓ ${a.name}`);
  }

  console.log('\nGenerating results...');

  const endDate = new Date('2026-06-06');
  const startDate = new Date('2024-12-07');
  const saturdays = [];

  const d = new Date(startDate);
  while (d <= endDate) {
    if (d.getDay() === 6) {
      saturdays.push(new Date(d));
    }
    d.setDate(d.getDate() + 1);
  }

  let totalResults = 0;

  for (const athlete of athletes) {
    const base = baseTimes[athlete.id];
    const baseAG = baseAgeGrades[athlete.id];
    let improvement = 0;

    for (const sat of saturdays) {
      if (rng() > 0.75) continue;

      improvement = Math.min(improvement + rng() * 1.5, 60);

      const variation = (rng() - 0.5) * 180;
      const timeSeconds = Math.round(Math.max(base - improvement + variation, base * 0.85));

      const agVariation = (rng() - 0.5) * 8;
      const ageGrade = Math.round((baseAG + (improvement / base) * 10 + agVariation) * 10) / 10;

      const position = Math.round(10 + (timeSeconds - 1100) / 15 + rng() * 30);

      const event = rng() > 0.85 ? events[Math.floor(rng() * events.length)] : 'cassiobury';

      const dateStr = sat.toISOString().split('T')[0];

      upsertResult(db, {
        athlete_id: athlete.id,
        date: dateStr,
        event,
        time: formatTime(timeSeconds),
        time_seconds: timeSeconds,
        position: Math.max(1, position),
        age_grade: Math.max(30, Math.min(85, ageGrade)),
      });
      totalResults++;
    }
  }

  console.log(`  ✓ ${totalResults} results generated`);

  console.log('\nRecalculating PBs...');
  recalculatePBs(db);

  const pbCount = queryAll(db, 'SELECT COUNT(*) as c FROM results WHERE is_pb = 1');
  console.log(`  ✓ ${pbCount[0].c} PBs marked`);

  saveDb(db);
  db.close();
  console.log('\nSample database created at data/parkrun.db');
}

generateResults();
