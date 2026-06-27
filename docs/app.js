/* ── ParkRun Dashboard — app.js (Server API version) ── */
/* Fetches JSON from api.php instead of loading SQLite client-side */

(async function () {
  const app = document.getElementById('app');

  try {
    const resp = await fetch('api.php?dashboard=1');
    if (!resp.ok) throw new Error('API request failed');
    const data = await resp.json();

    renderDashboard(data);

    // Show last updated timestamp in footer
    try {
      const luResp = await fetch('api.php?lastUpdated=1');
      if (luResp.ok) {
        const luData = await luResp.json();
        const el = document.getElementById('last-updated');
        if (el && luData.lastUpdated) {
          const d = new Date(luData.lastUpdated);
          el.textContent = `Last updated: ${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })} at ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
        }
      }
    } catch (_) { /* non-critical */ }
  } catch (err) {
    app.innerHTML = `<div class="error">Failed to load: ${err.message}</div>`;
    console.error(err);
  }
})();

/* ── Helpers ── */

function formatTime(seconds) {
  if (!seconds && seconds !== 0) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function splitName(name) {
  const parts = name.split(' ');
  const last = parts.pop();
  return { first: parts.join(' '), last };
}

function badgeImg(badge, cls = 'badge-icon') {
  if (!badge) return '';
  return `<img src="badges/badge-${badge}.svg" alt="${badge} badge" class="${cls}" title="${badge} parkruns">`;
}

/* ── Main render ── */

function renderDashboard(data) {
  const app = document.getElementById('app');

  const latestDate = data.latestDate;
  const athletes = data.athletes;
  const thisWeek = data.thisWeek;
  const thisWeekJunior = data.thisWeekJunior;
  const allResults = data.allResults;

  // Build per-athlete results map
  const resultsByAthlete = {};
  for (const r of allResults) {
    if (!resultsByAthlete[r.athlete_id]) resultsByAthlete[r.athlete_id] = [];
    resultsByAthlete[r.athlete_id].push(r);
  }

  // Who ran this week (either 5k or junior)
  const allThisWeekIds = new Set([
    ...thisWeek.map(r => r.athlete_id),
    ...thisWeekJunior.map(r => r.athlete_id)
  ]);
  const absent = athletes.filter(a => !allThisWeekIds.has(a.id));

  // PBs this week
  const pbs = thisWeek.filter(r => r.is_pb);

  // Per-athlete computed data (streaks, improvement, etc.)
  const athleteExtras = {};
  for (const a of athletes) {
    const dates5k = (resultsByAthlete[a.id] || [])
      .map(r => r.date)
      .filter((v, i, arr) => arr.indexOf(v) === i)
      .sort()
      .reverse();

    let streak = 0;
    if (latestDate && dates5k.length > 0) {
      let checkDate = new Date(latestDate);
      for (const d of dates5k) {
        const diff = Math.round((checkDate - new Date(d)) / (1000 * 60 * 60 * 24));
        if (diff <= 1) {
          streak++;
          checkDate = new Date(d);
          checkDate.setDate(checkDate.getDate() - 7);
        } else {
          break;
        }
      }
    }

    // 2026 improvement: first 3 vs last 3 in 2026
    const results2026 = (resultsByAthlete[a.id] || []).filter(r => r.date >= '2026-01-01');
    let improvement = null;
    if (results2026.length >= 6) {
      const first3Avg = results2026.slice(0, 3).reduce((s, r) => s + r.time_seconds, 0) / 3;
      const last3Avg = results2026.slice(-3).reduce((s, r) => s + r.time_seconds, 0) / 3;
      improvement = Math.round(last3Avg - first3Avg);
    }

    athleteExtras[a.id] = { streak, improvement };
  }

  // 3-month cutoff for "best in 3 months" highlights
  const threeMonthsAgo = latestDate
    ? new Date(new Date(latestDate).setMonth(new Date(latestDate).getMonth() - 3)).toISOString().split('T')[0]
    : null;

  // 4-week cutoff for "welcome back" detection
  const fourWeeksAgo = latestDate
    ? new Date(new Date(latestDate).setDate(new Date(latestDate).getDate() - 28)).toISOString().split('T')[0]
    : null;

  // Highlights
  const highlights = [];

  // 🏆 PBs this week
  for (const pb of pbs) {
    highlights.push({
      type: 'pb',
      emoji: '🏆',
      html: `<a href="athlete.html?id=${pb.athlete_id}" class="highlight-link"><strong>${pb.name}</strong></a> set a new PB! <strong>${pb.time}</strong>${
        pb.age_grade ? ` (${pb.age_grade.toFixed(1)}% AG)` : ''
      }`,
    });
  }

  // ⬆️ Best time in last 3 months (even if not PB) — skip if already a PB highlight
  const pbAthleteIds = new Set(pbs.map(p => p.athlete_id));
  for (const r of thisWeek) {
    if (pbAthleteIds.has(r.athlete_id)) continue;
    const recent3m = (resultsByAthlete[r.athlete_id] || [])
      .filter(x => x.date >= threeMonthsAgo && x.date < latestDate);
    if (recent3m.length >= 3) {
      const bestRecent = Math.min(...recent3m.map(x => x.time_seconds));
      if (r.time_seconds < bestRecent) {
        highlights.push({
          type: 'improvement',
          emoji: '⬆️',
          html: `<a href="athlete.html?id=${r.athlete_id}" class="highlight-link"><strong>${r.name}</strong></a> ran their <strong>fastest in 3 months</strong>! <strong>${r.time}</strong>`,
        });
      }
    }
  }

  // 🏅 Best age grade vs last 3 months — REMOVED per user request

  // 🎉 Milestone reached this week (crossed a threshold)
  const milestoneThresholds = [10, 25, 50, 100, 150, 200, 250, 300, 350, 400, 450, 500, 750, 1000];
  for (const r of thisWeek) {
    const a = athletes.find(x => x.id === r.athlete_id);
    if (!a) continue;
    const totalNow = a.total_5k || 0;
    // Check if this week's run pushed them over a threshold
    for (const t of milestoneThresholds) {
      const prevResults = (resultsByAthlete[a.id] || []).filter(x => x.date < latestDate);
      if (prevResults.length < t && totalNow >= t) {
        highlights.push({
          type: 'milestone-reached',
          emoji: '🎉',
          html: `<a href="athlete.html?id=${a.id}" class="highlight-link"><strong>${a.name}</strong></a> just hit <strong>${t} parkruns</strong>! 🏅`,
        });
      }
    }
  }

  // 🔥 Hot streaks (4+)
  for (const a of athletes) {
    const s = athleteExtras[a.id].streak;
    if (s >= 4) {
      highlights.push({
        type: 'streak',
        emoji: '🔥',
        html: `<a href="athlete.html?id=${a.id}" class="highlight-link"><strong>${a.name}</strong></a> is on a <strong>${s}-week streak</strong>!`,
      });
    }
  }

  // 🎯 Consecutive PB streak (3+) — only if athlete ran this week
  for (const a of athletes) {
    if (!allThisWeekIds.has(a.id)) continue;
    const results = (resultsByAthlete[a.id] || [])
      .filter(r => r.time_seconds > 0)
      .sort((a, b) => b.date.localeCompare(a.date)); // most recent first
    let pbStreak = 0;
    for (let i = 0; i < results.length; i++) {
      if (results[i].is_pb) pbStreak++;
      else break;
    }
    if (pbStreak >= 3) {
      highlights.push({
        type: 'pb-streak',
        emoji: '🎯',
        html: `<a href="athlete.html?id=${a.id}" class="highlight-link"><strong>${a.name}</strong></a> has <strong>${pbStreak} consecutive PBs</strong>! Hat trick! 🔥`,
      });
    }
  }

  // 🌍 Tourist run / tourism streak
  for (const r of thisWeek) {
    const a = athletes.find(x => x.id === r.athlete_id);
    if (!a) continue;
    const home = a.home_event || 'cassiobury';
    if (r.event && r.event !== home) {
      // Count consecutive tourist weeks (most recent first)
      const allDatesDesc = (resultsByAthlete[a.id] || [])
        .map(x => ({ date: x.date, event: x.event }))
        .sort((a, b) => b.date.localeCompare(a.date));
      // Dedupe by date (take first event per date)
      const seen = new Set();
      const byWeek = [];
      for (const x of allDatesDesc) {
        if (!seen.has(x.date)) { seen.add(x.date); byWeek.push(x); }
      }
      let touristStreak = 0;
      for (const w of byWeek) {
        if (w.event !== home) touristStreak++;
        else break;
      }

      if (touristStreak > 1) {
        highlights.push({
          type: 'tourist',
          emoji: '🌍',
          html: `<a href="athlete.html?id=${r.athlete_id}" class="highlight-link"><strong>${r.name}</strong></a> on a <strong>${touristStreak}-week tourist streak</strong>! This week: <strong>${r.event}</strong>`,
        });
      } else {
        highlights.push({
          type: 'tourist',
          emoji: '🌍',
          html: `<a href="athlete.html?id=${r.athlete_id}" class="highlight-link"><strong>${r.name}</strong></a> went touring! Ran at <strong>${r.event}</strong>`,
        });
      }
    }
  }

  // 👋 Welcome back (4+ weeks absent, returned this week)
  for (const r of thisWeek) {
    const athleteResults = (resultsByAthlete[r.athlete_id] || [])
      .filter(x => x.date < latestDate)
      .sort((a, b) => b.date.localeCompare(a.date));
    if (athleteResults.length > 0) {
      const lastRun = athleteResults[0].date;
      if (lastRun < fourWeeksAgo) {
        const weeksAway = Math.round((new Date(latestDate) - new Date(lastRun)) / (1000 * 60 * 60 * 24 * 7));
        highlights.push({
          type: 'comeback',
          emoji: '👋',
          html: `<a href="athlete.html?id=${r.athlete_id}" class="highlight-link"><strong>${r.name}</strong></a> is back after <strong>${weeksAway} weeks</strong>!`,
        });
      }
    }
  }

  // 🤝 Volunteered recently (volunteer_count increased since last scrape)
  for (const a of athletes) {
    const prev = a.prev_volunteer_count || 0;
    const curr = a.volunteer_count || 0;
    if (curr > prev && prev > 0) {
      highlights.push({
        type: 'volunteer',
        emoji: '🤝',
        html: `<a href="athlete.html?id=${a.id}" class="highlight-link"><strong>${a.name}</strong></a> volunteered! Now at <strong>${curr} volunteer credits</strong>`,
      });
    }
  }

  // Approaching milestones (for the dedicated section, NOT highlights)
  const milestoneTargets = [25, 50, 100, 250, 500];
  const milestones = [];
  for (const a of athletes) {
    const runs = a.total_5k || 0;
    for (const target of milestoneTargets) {
      if (runs >= target - 10 && runs < target) {
        const remaining = target - runs;
        milestones.push({ id: a.id, name: a.name, current: runs, target, remaining });
      }
    }
  }

  // Sort highlights: PBs and PB streaks first, then rest in original order
  const highlightPriority = { 'pb': 0, 'pb-streak': 1 };
  highlights.sort((a, b) => (highlightPriority[a.type] ?? 99) - (highlightPriority[b.type] ?? 99));

  // ── Build HTML ──
  let html = '';

  // A) Highlights
  if (highlights.length > 0) {
    html += `
      <div class="section">
        <div class="section-header">
          <span class="section-icon">✨</span>
          <h2>Highlights</h2>
        </div>
        <div class="highlights">
          ${highlights.map(h => `
            <div class="highlight-card ${h.type}">
              <span class="highlight-emoji">${h.emoji}</span>
              <div class="highlight-text">${h.html}</div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  // B) Milestones (ring progress) — moved before This Week
  if (milestones.length > 0) {
    const circ = 2 * Math.PI * 20;
    html += `
      <div class="section">
        <div class="section-header">
          <span class="section-icon">🎯</span>
          <h2>Approaching Milestones</h2>
        </div>
        <div class="milestone-list">
          ${milestones.map(m => {
            const pct = m.current / m.target;
            const offset = circ * (1 - pct);
            const { first, last } = splitName(m.name);
            return `
              <div class="milestone-item">
                <div class="milestone-progress">
                  <svg viewBox="0 0 48 48">
                    <circle class="bg" cx="24" cy="24" r="20" />
                    <circle class="fg" cx="24" cy="24" r="20"
                      stroke-dasharray="${circ}" stroke-dashoffset="${offset}" />
                  </svg>
                  <span class="milestone-count">${m.current}</span>
                </div>
                <div class="milestone-detail">
                  <a href="athlete.html?id=${m.id}" class="milestone-name-link">${first} ${last}</a>
                  <div class="milestone-desc">${m.remaining} more to reach ${m.target} runs 🏅</div>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  // C) This week's results
  if (thisWeek.length > 0) {
    const dateStr = new Date(latestDate).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'long', year: 'numeric',
    });
    html += `
      <div class="section">
        <div class="section-header">
          <span class="section-icon">📊</span>
          <h2>This Week — ${dateStr}</h2>
        </div>
        <div class="results-grid">
          ${thisWeek.map(r => {
            const { first, last } = splitName(r.name);
            return `
              <a href="athlete.html?id=${r.athlete_id}" class="result-row">
                <div class="result-name">
                  <span class="first-name">${first}</span>
                  <span class="last-name">${last}</span>
                </div>
                <div class="result-time ${r.is_pb ? 'is-pb' : ''}">${r.time}${r.is_pb ? '<span class="pb-badge">PB</span>' : ''}</div>
                <div class="result-pos">#${r.position || '—'}</div>
                <div class="result-ag">${r.age_grade ? r.age_grade.toFixed(1) + '%' : '—'}</div>
                <div class="result-event">${r.event}</div>
              </a>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  // D) Didn't run this week
  if (absent.length > 0) {
    html += `
      <div class="section">
        <div class="section-header">
          <span class="section-icon">😴</span>
          <h2>Didn't Run This Week</h2>
        </div>
        <div class="absent-list">
          ${absent.map(a => {
            const d = athleteExtras[a.id];
            const streakNote = d.streak > 2
              ? `<span class="streak-lost">🔥 ${d.streak}-week streak broken!</span>`
              : '';
            return `<a href="athlete.html?id=${a.id}" class="absent-chip">${splitName(a.name).first} ${streakNote}</a>`;
          }).join('')}
        </div>
      </div>
    `;
  }

  // E) League Table with time window pills
  html += `
    <div class="section" id="league-section">
      <div class="section-header">
        <span class="section-icon">🏆</span>
        <h2>League Table</h2>
      </div>
      <div class="time-window-pills" id="time-pills">
        <button class="tw-pill active" data-window="all">All Time</button>
        <button class="tw-pill" data-window="this-year">This Year</button>
        <button class="tw-pill" data-window="last-year">Last Year</button>
        <button class="tw-pill" data-window="12-months">Last 12 Months</button>
        <button class="tw-pill" data-window="3-months">Last 3 Months</button>
      </div>
      <div class="league-table-wrapper">
        <table class="league-table" id="league-table">
          <thead>
            <tr>
              <th data-col="rank" class="sorted"># <span class="sort-arrow">▼</span></th>
              <th data-col="name">Name <span class="sort-arrow">▼</span></th>
              <th data-col="runs" class="sorted">5k Runs <span class="sort-arrow">▼</span></th>
              <th data-col="pb">PB <span class="sort-arrow">▼</span></th>
              <th data-col="bestAg">Best AG <span class="sort-arrow">▼</span></th>
              <th data-col="avgAg">Avg AG <span class="sort-arrow">▼</span></th>
              <th data-col="vol" class="vol-col">Vol <span class="sort-arrow">▼</span></th>
              <th data-col="improvement" title="Avg of first 3 runs vs last 3 runs in this period">Trend <span class="sort-arrow">▼</span></th>
              <th data-col="streak">Streak <span class="sort-arrow">▼</span></th>
              <th data-col="bestStreak">Best Streak <span class="sort-arrow">▼</span></th>
            </tr>
          </thead>
          <tbody id="league-body"></tbody>
        </table>
      </div>
    </div>
  `;

  app.className = '';
  app.innerHTML = html;

  // ── League table logic with time windows ──

  // Helper: compute date range for a time window
  function getDateRange(window) {
    const now = latestDate ? new Date(latestDate) : new Date();
    switch (window) {
      case 'this-year': {
        const year = now.getFullYear();
        return { from: `${year}-01-01`, to: '9999-12-31' };
      }
      case 'last-year': {
        const year = now.getFullYear() - 1;
        return { from: `${year}-01-01`, to: `${year}-12-31` };
      }
      case '12-months': {
        const d = new Date(now);
        d.setFullYear(d.getFullYear() - 1);
        return { from: d.toISOString().slice(0, 10), to: '9999-12-31' };
      }
      case '3-months': {
        const d = new Date(now);
        d.setMonth(d.getMonth() - 3);
        return { from: d.toISOString().slice(0, 10), to: '9999-12-31' };
      }
      default: // 'all'
        return { from: '0000-01-01', to: '9999-12-31' };
    }
  }

  // Helper: compute best streak from sorted dates (ascending)
  function calcBestStreak(dates) {
    if (dates.length === 0) return 0;
    let best = 1, current = 1;
    for (let i = 1; i < dates.length; i++) {
      const diff = Math.round((new Date(dates[i]) - new Date(dates[i - 1])) / (1000 * 60 * 60 * 24));
      if (diff >= 5 && diff <= 9) {
        current++;
        if (current > best) best = current;
      } else if (diff > 9) {
        current = 1;
      }
      // diff < 5 means same week (multiple events?) — don't break streak, don't increment
    }
    return best;
  }

  // Helper: compute current streak from sorted dates (ascending), ending at latestDate
  function calcCurrentStreak(dates) {
    if (dates.length === 0) return 0;
    const reversed = [...dates].reverse();
    let streak = 0;
    let checkDate = new Date(latestDate);
    for (const d of reversed) {
      const diff = Math.round((checkDate - new Date(d)) / (1000 * 60 * 60 * 24));
      if (diff <= 1) {
        streak++;
        checkDate = new Date(d);
        checkDate.setDate(checkDate.getDate() - 7);
      } else {
        break;
      }
    }
    return streak;
  }

  // Build league data for a given time window
  function buildLeagueData(windowKey) {
    const range = getDateRange(windowKey);
    return athletes.map(a => {
      const allR = resultsByAthlete[a.id] || [];
      const filtered = allR.filter(r => r.date >= range.from && r.date <= range.to);

      const runs = filtered.length;
      const pbSeconds = filtered.length > 0
        ? Math.min(...filtered.map(r => r.time_seconds))
        : 99999;
      const pbTime = pbSeconds < 99999 ? formatTime(pbSeconds) : null;

      const withAg = filtered.filter(r => r.age_grade && r.age_grade > 0);
      const bestAg = withAg.length > 0 ? Math.max(...withAg.map(r => r.age_grade)) : 0;
      const avgAg = withAg.length > 0 ? withAg.reduce((s, r) => s + r.age_grade, 0) / withAg.length : 0;

      // Improvement: first 3 vs last 3 in the window
      let improvement = null;
      if (filtered.length >= 6) {
        const first3Avg = filtered.slice(0, 3).reduce((s, r) => s + r.time_seconds, 0) / 3;
        const last3Avg = filtered.slice(-3).reduce((s, r) => s + r.time_seconds, 0) / 3;
        improvement = Math.round(last3Avg - first3Avg);
      }

      // Current streak (always from latestDate backwards, uses all results)
      const allDatesAsc = allR.map(r => r.date).filter((v, i, arr) => arr.indexOf(v) === i).sort();
      const streak = calcCurrentStreak(allDatesAsc);

      // Best streak within the window
      const windowDatesAsc = filtered.map(r => r.date).filter((v, i, arr) => arr.indexOf(v) === i).sort();
      const bestStreak = calcBestStreak(windowDatesAsc);

      return {
        id: a.id,
        name: a.name,
        badge: a.badge,
        runs,
        pbSeconds,
        pb: pbTime,
        bestAg,
        avgAg,
        vol: a.volunteer_count || 0,
        improvement,
        streak,
        bestStreak,
      };
    });
  }

  let currentWindow = 'all';
  let leagueData = buildLeagueData(currentWindow);
  let currentSort = 'runs';
  let sortAsc = false;

  function renderLeague() {
    const sorted = [...leagueData].sort((a, b) => {
      let va = a[currentSort];
      let vb = b[currentSort];

      if (currentSort === 'name') {
        va = (va || '').toLowerCase();
        vb = (vb || '').toLowerCase();
        return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
      }

      if (currentSort === 'pbSeconds' || currentSort === 'pb') {
        va = a.pbSeconds;
        vb = b.pbSeconds;
      }

      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;

      return sortAsc ? va - vb : vb - va;
    });

    const showVol = currentWindow === 'all';
    const tbody = document.getElementById('league-body');
    tbody.innerHTML = sorted.map((d, i) => {
      const { first, last } = splitName(d.name);

      let improvementHtml = '—';
      let improvementClass = 'neutral';
      if (d.improvement !== null) {
        if (d.improvement < -5) {
          improvementClass = 'faster';
          improvementHtml = `↓ ${formatTime(Math.abs(d.improvement))}`;
        } else if (d.improvement > 5) {
          improvementClass = 'slower';
          improvementHtml = `↑ ${formatTime(d.improvement)}`;
        } else {
          improvementHtml = '≈';
        }
      }

      return `
        <tr>
          <td class="col-rank">${i + 1}</td>
          <td class="col-name">
            <a href="athlete.html?id=${d.id}">
              ${badgeImg(d.badge)}
              ${first} <span style="color:var(--text-secondary);font-weight:400">${last}</span>
            </a>
          </td>
          <td class="col-runs">${d.runs}</td>
          <td class="col-pb">${d.pb || '—'}</td>
          <td class="col-ag">${d.bestAg ? d.bestAg.toFixed(1) + '%' : '—'}</td>
          <td class="col-ag">${d.avgAg ? d.avgAg.toFixed(1) + '%' : '—'}</td>
          <td class="col-vol vol-col"${showVol ? '' : ' style="display:none"'}>${d.vol}</td>
          <td class="col-improvement ${improvementClass}" title="${d.improvement !== null ? 'First 3 avg vs last 3 avg' : 'Needs 6+ runs'}">${improvementHtml}</td>
          <td class="col-streak">${d.streak || '—'}</td>
          <td class="col-streak">${d.bestStreak || '—'}</td>
        </tr>
      `;
    }).join('');
  }

  // Time window pill click handlers
  document.querySelectorAll('#time-pills .tw-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#time-pills .tw-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentWindow = btn.dataset.window;
      leagueData = buildLeagueData(currentWindow);

      // Hide Vol column when not "All Time" (we only have all-time vol data)
      document.querySelectorAll('.vol-col').forEach(el => {
        el.style.display = currentWindow === 'all' ? '' : 'none';
      });

      renderLeague();
    });
  });

  // Column click handlers
  const colMap = {
    rank: 'runs',
    name: 'name',
    runs: 'runs',
    pb: 'pbSeconds',
    bestAg: 'bestAg',
    avgAg: 'avgAg',
    vol: 'vol',
    improvement: 'improvement',
    streak: 'streak',
    bestStreak: 'bestStreak',
  };

  document.querySelectorAll('#league-table thead th').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      const sortKey = colMap[col] || col;

      if (currentSort === sortKey) {
        sortAsc = !sortAsc;
      } else {
        currentSort = sortKey;
        sortAsc = (sortKey === 'name' || sortKey === 'pbSeconds');
      }

      document.querySelectorAll('#league-table thead th').forEach(h => {
        h.classList.remove('sorted');
        h.querySelector('.sort-arrow').textContent = '▼';
      });
      th.classList.add('sorted');
      th.querySelector('.sort-arrow').textContent = sortAsc ? '▲' : '▼';

      renderLeague();
    });
  });

  // Initial render
  renderLeague();

  // Set initial header state
  document.querySelectorAll('#league-table thead th').forEach(h => h.classList.remove('sorted'));
  const runsHeader = document.querySelector('#league-table thead th[data-col="runs"]');
  if (runsHeader) {
    runsHeader.classList.add('sorted');
    runsHeader.querySelector('.sort-arrow').textContent = '▼';
  }
}
