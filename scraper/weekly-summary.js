#!/usr/bin/env node
/**
 * #NoMasti Weekly ParkRun Summary
 * Generates a WhatsApp-friendly text summary of the week's parkrun activity.
 * Output: plain text to stdout (no markdown tables — WhatsApp doesn't render them).
 */
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'parkrun.db');
const db = new Database(DB_PATH, { readonly: true });

// ── Helpers ──
function formatEvent(slug) {
  return slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function formatTime(secs) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ── Data ──
const latestDate = db.prepare('SELECT MAX(date) as d FROM results WHERE is_junior = 0').get().d;
if (!latestDate) { console.log('No results found.'); process.exit(0); }

const latestJuniorDate = db.prepare('SELECT MAX(date) as d FROM results WHERE is_junior = 1').get().d;

// Format date nicely
const dateObj = new Date(latestDate + 'T09:00:00');
const dateStr = dateObj.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

const thisWeek = db.prepare(`
  SELECT r.*, a.name, a.home_event FROM results r
  JOIN athletes a ON a.id = r.athlete_id
  WHERE r.date = ? AND r.is_junior = 0
  ORDER BY a.name
`).all(latestDate);

// Only include junior results from the same week as the latest 5k date (within 2 days)
const juniorSameWeek = latestJuniorDate && Math.abs(new Date(latestDate) - new Date(latestJuniorDate)) <= 2 * 86400000;
const thisWeekJunior = juniorSameWeek ? db.prepare(`
  SELECT r.*, a.name FROM results r
  JOIN athletes a ON a.id = r.athlete_id
  WHERE r.date = ? AND r.is_junior = 1
  ORDER BY a.name
`).all(latestJuniorDate) : [];

const athletes = db.prepare('SELECT * FROM athletes WHERE active = 1').all();
const athleteMap = Object.fromEntries(athletes.map(a => [a.id, a]));

const allResults = db.prepare(`
  SELECT r.*, a.name FROM results r
  JOIN athletes a ON a.id = r.athlete_id
  WHERE r.is_junior = 0
  ORDER BY r.date
`).all();

const resultsByAthlete = {};
for (const r of allResults) {
  (resultsByAthlete[r.athlete_id] ||= []).push(r);
}

// ── Sections ──
const lines = [];
const totalActive = athletes.length;
const runnersThisWeek = new Set([...thisWeek.map(r => r.athlete_id), ...thisWeekJunior.map(r => r.athlete_id)]);

lines.push(`🏃 *#NoMasti ParkRun Report*`);
lines.push(`📅 ${dateStr}`);
lines.push(`👥 ${runnersThisWeek.size} of ${totalActive} runners active this week`);
lines.push('');

// ── Who ran & where ──
lines.push(`*This Week's Runners*`);
const byEvent = {};
for (const r of thisWeek) {
  (byEvent[r.event] ||= []).push(r);
}
for (const [event, runners] of Object.entries(byEvent).sort((a, b) => b[1].length - a[1].length)) {
  const emoji = runners.length >= 5 ? '🔥' : '📍';
  lines.push(`${emoji} *${formatEvent(event)}* (${runners.length})`);
  for (const r of runners.sort((a, b) => a.time_seconds - b.time_seconds)) {
    const pos = r.position ? ` (${ordinal(r.position)})` : '';
    lines.push(`   ${r.name} — ${r.time}${pos}`);
  }
}
if (thisWeekJunior.length > 0) {
  lines.push(`🧒 *Junior parkrun*`);
  for (const r of thisWeekJunior) {
    lines.push(`   ${r.name} — ${r.time}`);
  }
}
lines.push('');

// ── PBs ──
const pbs = thisWeek.filter(r => r.is_pb);
if (pbs.length > 0) {
  lines.push(`🏆 *Personal Bests!*`);
  for (const pb of pbs) {
    const prevResults = (resultsByAthlete[pb.athlete_id] || []).filter(r => r.date < latestDate && !r.is_junior);
    const prevBest = prevResults.length > 0 ? Math.min(...prevResults.map(r => r.time_seconds)) : null;
    const improvement = prevBest ? prevBest - pb.time_seconds : null;
    const impStr = improvement ? ` (${improvement}s faster!)` : '';
    lines.push(`   🥇 ${pb.name} — ${pb.time}${impStr}`);
  }
  lines.push('');
}

// ── Best in 3 months (not PB) ──
const threeMonthsAgo = new Date(new Date(latestDate).setMonth(new Date(latestDate).getMonth() - 3)).toISOString().split('T')[0];
const bestIn3m = [];
for (const r of thisWeek) {
  if (r.is_pb) continue;
  const recent = (resultsByAthlete[r.athlete_id] || [])
    .filter(x => x.date >= threeMonthsAgo && x.date < latestDate);
  if (recent.length >= 3) {
    const bestRecent = Math.min(...recent.map(x => x.time_seconds));
    if (r.time_seconds < bestRecent) {
      bestIn3m.push(r);
    }
  }
}
if (bestIn3m.length > 0) {
  lines.push(`⬆️ *Fastest in 3 Months*`);
  for (const r of bestIn3m) {
    lines.push(`   ${r.name} — ${r.time}`);
  }
  lines.push('');
}

// ── Milestones ──
const milestoneThresholds = [10, 25, 50, 100, 150, 200, 250, 300, 350, 400, 450, 500, 750, 1000];
const milestones = [];
for (const r of thisWeek) {
  const a = athleteMap[r.athlete_id];
  if (!a) continue;
  const prevCount = (resultsByAthlete[r.athlete_id] || []).filter(x => x.date < latestDate).length;
  const nowCount = prevCount + 1;
  for (const t of milestoneThresholds) {
    if (prevCount < t && nowCount >= t) {
      milestones.push({ name: a.name, count: t });
    }
  }
}
if (milestones.length > 0) {
  lines.push(`🎉 *Milestones Reached*`);
  for (const m of milestones) {
    lines.push(`   🏅 ${m.name} — ${m.count} parkruns!`);
  }
  lines.push('');
}

// ── Streaks ──
const streaks = [];
for (const r of thisWeek) {
  const dates5k = [...new Set((resultsByAthlete[r.athlete_id] || []).map(x => x.date))].sort().reverse();
  let streak = 0;
  let checkDate = new Date(latestDate);
  for (const d of dates5k) {
    const diffDays = Math.round((checkDate - new Date(d)) / (1000 * 60 * 60 * 24));
    if (diffDays <= 1) {
      streak++;
      checkDate = new Date(d);
      checkDate.setDate(checkDate.getDate() - 7);
    } else {
      break;
    }
  }
  if (streak >= 4) {
    streaks.push({ name: r.name, streak });
  }
}
if (streaks.length > 0) {
  streaks.sort((a, b) => b.streak - a.streak);
  lines.push(`🔥 *On a Streak*`);
  for (const s of streaks) {
    lines.push(`   ${s.name} — ${s.streak} weeks running!`);
  }
  lines.push('');
}

// ── Tourists ──
const tourists = thisWeek.filter(r => {
  const a = athleteMap[r.athlete_id];
  return a && a.home_event && r.event !== a.home_event;
});
if (tourists.length > 0) {
  lines.push(`✈️ *Tourists*`);
  for (const r of tourists) {
    lines.push(`   ${r.name} — ${formatEvent(r.event)}`);
  }
  lines.push('');
}

// ── Comebacks ──
const comebacks = [];
for (const r of thisWeek) {
  const dates = (resultsByAthlete[r.athlete_id] || []).map(x => x.date).sort().reverse();
  const prevDate = dates.find(d => d < latestDate);
  if (prevDate) {
    const weeksAway = Math.round((new Date(latestDate) - new Date(prevDate)) / (7 * 86400000));
    if (weeksAway >= 6) {
      comebacks.push({ name: r.name, weeks: weeksAway });
    }
  }
}
if (comebacks.length > 0) {
  comebacks.sort((a, b) => b.weeks - a.weeks);
  lines.push(`👋 *Welcome Back!*`);
  for (const c of comebacks) {
    lines.push(`   ${c.name} — back after ${c.weeks} weeks!`);
  }
  lines.push('');
}

// ── Volunteer shoutouts ──
const volChanges = db.prepare(`
  SELECT v.*, a.name FROM volunteer_log v
  JOIN athletes a ON a.id = v.athlete_id
  WHERE v.date_detected = ?
`).all(new Date().toISOString().split('T')[0]);
if (volChanges.length > 0) {
  lines.push(`🙌 *Volunteer Shoutout*`);
  for (const v of volChanges) {
    lines.push(`   ${v.name} — now at ${v.new_count} volunteer credits!`);
  }
  lines.push('');
}

// ── Who didn't run ──
const inactive = athletes
  .filter(a => !runnersThisWeek.has(a.id))
  .map(a => a.name)
  .sort();
if (inactive.length > 0 && inactive.length <= 25) {
  lines.push(`😴 *Resting This Week* (${inactive.length})`);
  lines.push(`   ${inactive.join(', ')}`);
  lines.push('');
}

// ── Footer ──
lines.push(`📊 Full dashboard: nomasti.enriched.solutions`);

console.log(lines.join('\n'));
db.close();
