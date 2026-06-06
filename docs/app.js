/* ── ParkRun Dashboard — app.js ── */
/* Loads SQLite DB via sql.js, queries everything client-side */

(async function () {
  const app = document.getElementById('app');

  try {
    const SQL = await initSqlJs({
      locateFile: (file) =>
        `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.11.0/${file}`,
    });

    const resp = await fetch('data/parkrun.db');
    if (!resp.ok) throw new Error('Failed to load database');
    const buf = await resp.arrayBuffer();
    const db = new SQL.Database(new Uint8Array(buf));

    renderDashboard(db);
  } catch (err) {
    app.innerHTML = `<div class="error">Failed to load: ${err.message}</div>`;
    console.error(err);
  }
})();

/* ── Helpers ── */

function query(db, sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function querySingle(db, sql, params = []) {
  const rows = query(db, sql, params);
  return rows.length > 0 ? rows[0] : null;
}

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

function renderDashboard(db) {
  const app = document.getElementById('app');

  // Latest result date
  const latestDateRow = querySingle(db, 'SELECT MAX(date) as d FROM results');
  const latestDate = latestDateRow?.d;

  // All active athletes with pre-computed fields from DB
  const athletes = query(db, `
    SELECT a.*,
      (SELECT MAX(age_grade) FROM results r WHERE r.athlete_id = a.id AND r.is_junior = 0) as best_ag,
      (SELECT AVG(age_grade) FROM results r WHERE r.athlete_id = a.id AND r.is_junior = 0 AND r.age_grade > 0) as avg_ag
    FROM athletes a
    WHERE a.active = 1
    ORDER BY a.total_5k DESC
  `);

  // This week's results (5k only)
  const thisWeek = latestDate
    ? query(db, `
        SELECT r.*, a.name, a.badge FROM results r
        JOIN athletes a ON r.athlete_id = a.id
        WHERE r.date = ? AND r.is_junior = 0
        ORDER BY r.time_seconds ASC
      `, [latestDate])
    : [];

  // Junior results this week (separate)
  const thisWeekJunior = latestDate
    ? query(db, `
        SELECT r.*, a.name FROM results r
        JOIN athletes a ON r.athlete_id = a.id
        WHERE r.date = ? AND r.is_junior = 1
        ORDER BY r.time_seconds ASC
      `, [latestDate])
    : [];

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
    // Current streak: consecutive weeks ending at latestDate
    const dates5k = query(db,
      `SELECT DISTINCT date FROM results WHERE athlete_id = ? AND is_junior = 0 ORDER BY date DESC`,
      [a.id]
    ).map(r => r.date);

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
    const first3 = querySingle(db, `
      SELECT AVG(time_seconds) as avg_t, COUNT(*) as cnt FROM (
        SELECT time_seconds FROM results
        WHERE athlete_id = ? AND date >= '2026-01-01' AND is_junior = 0
        ORDER BY date ASC LIMIT 3
      )
    `, [a.id]);

    const last3 = querySingle(db, `
      SELECT AVG(time_seconds) as avg_t, COUNT(*) as cnt FROM (
        SELECT time_seconds FROM results
        WHERE athlete_id = ? AND date >= '2026-01-01' AND is_junior = 0
        ORDER BY date DESC LIMIT 3
      )
    `, [a.id]);

    let improvement = null;
    if (first3 && last3 && first3.cnt >= 3 && last3.cnt >= 3 && first3.avg_t && last3.avg_t) {
      improvement = Math.round(last3.avg_t - first3.avg_t); // negative = faster
    }

    athleteExtras[a.id] = { streak, improvement };
  }

  // Highlights
  const highlights = [];

  // PBs
  for (const pb of pbs) {
    highlights.push({
      type: 'pb',
      emoji: '🏆',
      html: `<strong>${pb.name}</strong> set a new PB! <strong>${pb.time}</strong>${
        pb.age_grade ? ` (${pb.age_grade.toFixed(1)}% AG)` : ''
      }`,
    });
  }

  // Hot streaks (4+)
  for (const a of athletes) {
    const s = athleteExtras[a.id].streak;
    if (s >= 4) {
      highlights.push({
        type: 'streak',
        emoji: '🔥',
        html: `<strong>${a.name}</strong> is on a <strong>${s}-week streak</strong>!`,
      });
    }
  }

  // Approaching milestones
  const milestoneTargets = [25, 50, 100, 250, 500];
  const milestones = [];
  for (const a of athletes) {
    const runs = a.total_5k || 0;
    for (const target of milestoneTargets) {
      if (runs >= target - 10 && runs < target) {
        const remaining = target - runs;
        milestones.push({ name: a.name, current: runs, target, remaining });
        highlights.push({
          type: 'milestone',
          emoji: '🎯',
          html: `<strong>${a.name}</strong> is ${remaining} run${remaining === 1 ? '' : 's'} away from <strong>${target} runs</strong>!`,
        });
      }
    }
  }

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

  // B) This week's results
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

  // C) Didn't run this week
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
            return `<span class="absent-chip">${splitName(a.name).first} ${streakNote}</span>`;
          }).join('')}
        </div>
      </div>
    `;
  }

  // D) League Table
  html += `
    <div class="section" id="league-section">
      <div class="section-header">
        <span class="section-icon">🏆</span>
        <h2>League Table</h2>
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
              <th data-col="vol">Vol <span class="sort-arrow">▼</span></th>
              <th data-col="improvement">2026 Δ <span class="sort-arrow">▼</span></th>
              <th data-col="streak">Streak <span class="sort-arrow">▼</span></th>
            </tr>
          </thead>
          <tbody id="league-body"></tbody>
        </table>
      </div>
    </div>
  `;

  // E) Milestones (ring progress)
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
                  <div class="milestone-name">${first} ${last}</div>
                  <div class="milestone-desc">${m.remaining} more to reach ${m.target} runs 🏅</div>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  app.className = '';
  app.innerHTML = html;

  // ── League table sorting logic ──
  const leagueData = athletes.map(a => {
    const ex = athleteExtras[a.id];
    return {
      id: a.id,
      name: a.name,
      badge: a.badge,
      runs: a.total_5k || 0,
      pbSeconds: a.pb_5k_seconds || 99999,
      pb: a.pb_5k || null,
      bestAg: a.best_ag || 0,
      avgAg: a.avg_ag || 0,
      vol: a.volunteer_count || 0,
      improvement: ex.improvement,
      streak: ex.streak,
    };
  });

  let currentSort = 'runs';
  let sortAsc = false; // default: descending

  function renderLeague() {
    // Sort
    const sorted = [...leagueData].sort((a, b) => {
      let va = a[currentSort];
      let vb = b[currentSort];

      // Special handling for name (string sort)
      if (currentSort === 'name') {
        va = (va || '').toLowerCase();
        vb = (vb || '').toLowerCase();
        return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
      }

      // PB: lower is better, nulls last
      if (currentSort === 'pbSeconds' || currentSort === 'pb') {
        va = a.pbSeconds;
        vb = b.pbSeconds;
      }

      // Improvement: null should go last
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;

      return sortAsc ? va - vb : vb - va;
    });

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
          <td class="col-vol">${d.vol}</td>
          <td class="col-improvement ${improvementClass}">${improvementHtml}</td>
          <td class="col-streak">${d.streak || '—'}</td>
        </tr>
      `;
    }).join('');
  }

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
  };

  document.querySelectorAll('#league-table thead th').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      const sortKey = colMap[col] || col;

      if (currentSort === sortKey) {
        sortAsc = !sortAsc;
      } else {
        currentSort = sortKey;
        // Default direction: descending for numbers, ascending for name/pb
        sortAsc = (sortKey === 'name' || sortKey === 'pbSeconds');
      }

      // Update header styles
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
