#!/usr/bin/env node
/**
 * Generate realistic sample data for the ParkRun dashboard.
 * Run: node scraper/generate-sample-data.js
 */

const fs = require('fs');
const path = require('path');

// Helper: format mm:ss
function formatTime(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Helper: parse mm:ss to seconds
function parseTime(str) {
  const [m, s] = str.split(':').map(Number);
  return m * 60 + s;
}

// Generate Saturdays going back 18 months from June 2026
function getSaturdays(count) {
  const dates = [];
  // Start from Sat 6 June 2026 - use UTC noon to avoid timezone issues
  let d = new Date(Date.UTC(2026, 5, 6, 12, 0, 0));
  for (let i = 0; i < count; i++) {
    dates.push(d.toISOString().split('T')[0]);
    d = new Date(d.getTime() - 7 * 24 * 60 * 60 * 1000);
  }
  return dates;
}

const saturdays = getSaturdays(78); // ~18 months

const athletes = [
  {
    id: 7107144,
    name: 'Hasnain PANJU',
    gender: 'M',
    ageGroup: 'VM35-39',
    baseTime: 1380, // 23:00
    improvement: -2, // getting slightly faster per month
    consistency: 0.85, // runs 85% of weeks
    pbTime: 1290, // 21:30
    totalRunsBase: 187,
    ageGradeBase: 58.5,
  },
  {
    id: 7205311,
    name: 'Fatima PANJU',
    gender: 'F',
    ageGroup: 'VW35-39',
    baseTime: 1680, // 28:00
    improvement: -1.5,
    consistency: 0.7,
    pbTime: 1590, // 26:30
    totalRunsBase: 94,
    ageGradeBase: 52.3,
  },
  {
    id: 6892003,
    name: 'Rahim MEGHJEE',
    gender: 'M',
    ageGroup: 'VM40-44',
    baseTime: 1260, // 21:00
    improvement: -1,
    consistency: 0.9,
    pbTime: 1170, // 19:30
    totalRunsBase: 245,
    ageGradeBase: 64.2,
  },
  {
    id: 7450122,
    name: 'Zara MEGHJEE',
    gender: 'F',
    ageGroup: 'VW40-44',
    baseTime: 1800, // 30:00
    improvement: -0.5,
    consistency: 0.6,
    pbTime: 1740, // 29:00
    totalRunsBase: 48,
    ageGradeBase: 48.1,
  },
  {
    id: 6334567,
    name: 'Amir TEJANI',
    gender: 'M',
    ageGroup: 'VM45-49',
    baseTime: 1440, // 24:00
    improvement: 0,
    consistency: 0.75,
    pbTime: 1350, // 22:30
    totalRunsBase: 156,
    ageGradeBase: 55.8,
  },
  {
    id: 7801234,
    name: 'Imran TEJANI',
    gender: 'M',
    ageGroup: 'SM25-29',
    baseTime: 1200, // 20:00
    improvement: -3,
    consistency: 0.65,
    pbTime: 1080, // 18:00
    totalRunsBase: 34,
    ageGradeBase: 62.7,
  },
  {
    id: 7023456,
    name: 'Salim KANANI',
    gender: 'M',
    ageGroup: 'VM50-54',
    baseTime: 1560, // 26:00
    improvement: 1,
    consistency: 0.8,
    pbTime: 1470, // 24:30
    totalRunsBase: 198,
    ageGradeBase: 57.2,
  },
  {
    id: 7654321,
    name: 'Nadia KANANI',
    gender: 'F',
    ageGroup: 'VW50-54',
    baseTime: 1920, // 32:00
    improvement: -1,
    consistency: 0.55,
    pbTime: 1860, // 31:00
    totalRunsBase: 72,
    ageGradeBase: 50.9,
  },
];

const events = ['cassiobury', 'cassiobury', 'cassiobury', 'cassiobury', 'cassiobury', 'bushey', 'rickmansworth', 'gladstone'];

function generateResults(athlete) {
  const results = [];
  let runCount = 0;
  let currentBestTime = athlete.pbTime + 120; // Start with PB + 2min overhead 18 months ago

  for (let i = saturdays.length - 1; i >= 0; i--) {
    // Skip some weeks based on consistency, but always include the latest week
    if (i !== 0 && Math.random() > athlete.consistency) continue;

    runCount++;
    const weekIndex = saturdays.length - 1 - i;
    const monthIndex = Math.floor(weekIndex / 4.33);

    // Base time with gradual improvement
    let timeSeconds = athlete.baseTime + (athlete.improvement * monthIndex);
    // Add daily variance (-60 to +90 seconds)
    timeSeconds += Math.floor(Math.random() * 150) - 60;
    timeSeconds = Math.max(timeSeconds, athlete.pbTime - 10); // Don't go way below PB
    timeSeconds = Math.round(timeSeconds);

    const isPB = timeSeconds < currentBestTime;
    if (isPB) currentBestTime = timeSeconds;

    // Mostly Cassiobury, occasionally elsewhere
    const event = Math.random() < 0.8 ? 'cassiobury' : events[Math.floor(Math.random() * events.length)];
    const position = Math.floor(Math.random() * 250) + 10;
    const totalRunners = Math.floor(Math.random() * 100) + 300;

    // Age grade varies a bit
    const ageGrade = athlete.ageGradeBase + (athlete.improvement * monthIndex * -0.15) + (Math.random() * 4 - 2);

    results.push({
      date: saturdays[i],
      event,
      time: formatTime(timeSeconds),
      timeSeconds,
      position,
      totalRunners,
      ageGrade: Math.round(ageGrade * 100) / 100,
      isPB,
    });
  }

  return results;
}

// Build athlete data
const athleteData = athletes.map(a => {
  const results = generateResults(a);
  const totalRuns = a.totalRunsBase + results.length;
  const bestTime = results.reduce((min, r) => Math.min(min, r.timeSeconds), Infinity);
  const bestAgeGrade = results.reduce((max, r) => Math.max(max, r.ageGrade), 0);

  // Calculate consistency streak (consecutive recent weeks)
  let streak = 0;
  const sortedResults = [...results].sort((a, b) => b.date.localeCompare(a.date));
  if (sortedResults.length > 0) {
    // Check if they ran this week (most recent Saturday)
    const latestSaturday = saturdays[0];
    if (sortedResults[0].date === latestSaturday) {
      streak = 1;
      for (let i = 1; i < sortedResults.length; i++) {
        const expectedDate = saturdays[i];
        if (sortedResults[i] && sortedResults[i].date === expectedDate) {
          streak++;
        } else {
          // They might have run at a different event on that date
          const matchingRun = sortedResults.find(r => r.date === expectedDate);
          if (matchingRun) streak++;
          else break;
        }
      }
    }
  }

  return {
    id: a.id,
    name: a.name,
    gender: a.gender,
    ageGroup: a.ageGroup,
    totalRuns,
    pb: formatTime(bestTime),
    pbSeconds: bestTime,
    bestAgeGrade: Math.round(bestAgeGrade * 100) / 100,
    currentStreak: streak,
    results,
  };
});

// Remove most recent week for a couple of athletes so "Didn't Run" section shows
// Remove Zara and Nadia from latest week
[3, 7].forEach(idx => {
  const lastDate = saturdays[0];
  athleteData[idx].results = athleteData[idx].results.filter(r => r.date !== lastDate);
  athleteData[idx].currentStreak = 0;
});

// Make specific tweaks for interesting dashboard scenarios
// Hasnain approaching 200 runs
athleteData[0].totalRuns = 197;
// Salim approaching 200 runs
athleteData[6].totalRuns = 199;
// Rahim past 250
athleteData[2].totalRuns = 253;
// Give Imran a PB this week
if (athleteData[5].results.length > 0) {
  const latest = athleteData[5].results[athleteData[5].results.length - 1];
  latest.isPB = true;
  latest.timeSeconds = athleteData[5].pbSeconds - 5;
  latest.time = formatTime(latest.timeSeconds);
  athleteData[5].pbSeconds = latest.timeSeconds;
  athleteData[5].pb = latest.time;
}

const output = {
  _meta: {
    generated: new Date().toISOString(),
    sampleData: true,
    note: 'This is realistic sample data for dashboard development. Replace with real scraped data.',
  },
  event: 'cassiobury',
  lastUpdated: saturdays[0],
  athletes: athleteData,
};

const outPath = path.join(__dirname, '..', 'data', 'athletes.json');
fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
console.log(`Sample data written to ${outPath}`);
console.log(`${athleteData.length} athletes, ${athleteData.reduce((s, a) => s + a.results.length, 0)} total results`);
