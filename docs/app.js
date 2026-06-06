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

function query(db, sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function splitName(name) {
  const parts = name.split(' ');
  const last = parts.pop();
  return { first: parts.join(' '), last };
}

function renderDashboard(db) {
  const app = document.getElementById('app');

  // Get latest Saturday (most recent results date)
  const latestDateRow = query(db, 'SELECT MAX(date) as d FROM results');
  const latestDate = latestDateRow[0]?.d;

  // All athletes
  const athletes = query(db, 'SELECT * FROM athletes WHERE active = 1 ORDER BY name');

  // This week's results
  const thisWeek = latestDate
    ? query(
        db,
        `SELECT r.*, a.name FROM results r 
         JOIN athletes a ON r.athlete_id = a.id 
         WHERE r.date = ? ORDER BY r.time_seconds ASC`,
        [latestDate]
      )
    : [];

  // Athletes who didn't run this week
  const runnersThisWeek = new Set(thisWeek.map((r) => r.athlete_id));
  const absent = athletes.filter((a) => !runnersThisWeek.has(a.id));

  // PBs this week
  const pbs = thisWeek.filter((r) => r.is_pb);

  // All results for streaks/milestones
  const allResults = query(
    db,
    `SELECT r.*, a.name FROM results r 
     JOIN athletes a ON r.athlete_id = a.id 
     ORDER BY r.date DESC`
  );

  // Build streak data & milestone data per athlete
  const athleteData = {};
  for (const a of athletes) {
    const results = query(
      db,
      'SELECT * FROM results WHERE athlete_id = ? ORDER BY date DESC',
      [a.id]
    );
    const totalRuns = results.length;
    const pb = results.reduce(
      (min, r) => (r.time_seconds < min ? r.time_seconds : min),
      Infinity
    );
    const bestAG = results.reduce(
      (max, r) => (r.age_grade > max ? r.age_grade : max),
      0
    );

    // Current streak (consecutive weeks from latest date backwards)
    let streak = 0;
    if (latestDate) {
      const dates = [...new Set(results.map((r) => r.date))].sort().reverse();
      const latestD = new Date(latestDate);
      let checkDate = new Date(latestD);
      for (const d of dates) {
        const diff = Math.round(
          (checkDate - new Date(d)) / (1000 * 60 * 60 * 24)
        );
        if (diff <= 1) {
          streak++;
          checkDate = new Date(d);
          checkDate.setDate(checkDate.getDate() - 7);
        } else {
          break;
        }
      }
    }

    // Recent 8 results for form bars
    const recent8 = results.slice(0, 8).reverse();

    // 4-week average
    const recent4 = results.slice(0, 4);
    const avg4w =
      recent4.length > 0
        ? Math.round(
            recent4.reduce((s, r) => s + r.time_seconds, 0) / recent4.length
          )
        : null;

    // Trend: compare last 4 avg to previous 4 avg
    const prev4 = results.slice(4, 8);
    const avg4prev =
      prev4.length > 0
        ? Math.round(
            prev4.reduce((s, r) => s + r.time_seconds, 0) / prev4.length
          )
        : null;
    let trend = 'flat';
    if (avg4w && avg4prev) {
      const diff = avg4prev - avg4w;
      if (diff > 15) trend = 'up'; // faster = improving
      else if (diff < -15) trend = 'down';
    }

    athleteData[a.id] = {
      ...a,
      totalRuns,
      pb: pb === Infinity ? null : pb,
      bestAG,
      streak,
      recent8,
      avg4w,
      trend,
    };
  }

  // Milestones
  const milestones = [];
  const milestoneTargets = [25, 50, 100, 150, 200, 250, 300];
  for (const a of athletes) {
    const d = athleteData[a.id];
    for (const target of milestoneTargets) {
      if (d.totalRuns >= target - 10 && d.totalRuns < target) {
        milestones.push({
          name: d.name,
          current: d.totalRuns,
          target,
          remaining: target - d.totalRuns,
        });
      }
    }
  }

  // Build highlights
  const highlights = [];

  for (const pb of pbs) {
    const { first, last } = splitName(pb.name);
    highlights.push({
      type: 'pb',
      emoji: '🏆',
      html: `<strong>${first}</strong> set a new PB! <strong>${pb.time}</strong>${
        pb.age_grade ? ` (${pb.age_grade.toFixed(1)}% AG)` : ''
      }`,
    });
  }

  for (const a of athletes) {
    const d = athleteData[a.id];
    if (d.streak >= 4) {
      const { first } = splitName(d.name);
      highlights.push({
        type: 'streak',
        emoji: '🔥',
        html: `<strong>${first}</strong> is on a <strong>${d.streak}-week streak</strong>!`,
      });
    }
  }

  for (const m of milestones) {
    const { first } = splitName(m.name);
    highlights.push({
      type: 'milestone',
      emoji: '🎯',
      html: `<strong>${first}</strong> is ${m.remaining} run${
        m.remaining === 1 ? '' : 's'
      } away from <strong>${m.target} runs</strong>!`,
    });
  }

  // Render
  let html = '';

  // Highlights
  if (highlights.length > 0) {
    html += `
      <div class="section">
        <div class="section-header">
          <span class="section-icon">✨</span>
          <h2>Highlights</h2>
        </div>
        <div class="highlights">
          ${highlights
            .map(
              (h) => `
            <div class="highlight-card ${h.type}">
              <span class="highlight-emoji">${h.emoji}</span>
              <div class="highlight-text">${h.html}</div>
            </div>
          `
            )
            .join('')}
        </div>
      </div>
    `;
  }

  // This week's results
  if (thisWeek.length > 0) {
    const dateStr = new Date(latestDate).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
    html += `
      <div class="section">
        <div class="section-header">
          <span class="section-icon">📊</span>
          <h2>This Week — ${dateStr}</h2>
        </div>
        <div class="results-grid">
          ${thisWeek
            .map((r) => {
              const { first, last } = splitName(r.name);
              return `
              <a href="athlete.html?id=${r.athlete_id}" class="result-row">
                <div class="result-name">
                  <span class="first-name">${first}</span>
                  <span class="last-name">${last}</span>
                </div>
                <div class="result-time ${r.is_pb ? 'is-pb' : ''}">${
                r.time
              }${r.is_pb ? '<span class="pb-badge">PB</span>' : ''}</div>
                <div class="result-pos">#${r.position || '—'}</div>
                <div class="result-ag">${
                  r.age_grade ? r.age_grade.toFixed(1) + '%' : '—'
                }</div>
              </a>
            `;
            })
            .join('')}
        </div>
      </div>
    `;
  }

  // Didn't run
  if (absent.length > 0) {
    html += `
      <div class="section">
        <div class="section-header">
          <span class="section-icon">😴</span>
          <h2>Didn't Run This Week</h2>
        </div>
        <div class="absent-list">
          ${absent
            .map((a) => {
              const d = athleteData[a.id];
              const streakLost =
                d.streak > 2
                  ? `<span class="streak-lost">🔥 ${d.streak}-week streak broken!</span>`
                  : '';
              return `<span class="absent-chip">${splitName(a.name).first} ${streakLost}</span>`;
            })
            .join('')}
        </div>
      </div>
    `;
  }

  // Milestones
  if (milestones.length > 0) {
    const circ = 2 * Math.PI * 20;
    html += `
      <div class="section">
        <div class="section-header">
          <span class="section-icon">🎯</span>
          <h2>Approaching Milestones</h2>
        </div>
        <div class="milestone-list">
          ${milestones
            .map((m) => {
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
            })
            .join('')}
        </div>
      </div>
    `;
  }

  // Athlete grid
  html += `
    <div class="section">
      <div class="section-header">
        <span class="section-icon">👥</span>
        <h2>Athletes</h2>
      </div>
      <div class="athlete-cards">
        ${athletes
          .map((a) => {
            const d = athleteData[a.id];
            const { first, last } = splitName(a.name);

            // Form bars
            let formHtml = '';
            if (d.recent8.length > 0) {
              const times = d.recent8.map((r) => r.time_seconds);
              const maxT = Math.max(...times);
              const minT = Math.min(...times);
              const range = maxT - minT || 1;
              formHtml = `
                <div class="form-bars">
                  ${d.recent8
                    .map((r) => {
                      const h = 10 + ((maxT - r.time_seconds) / range) * 40;
                      return `<div class="form-bar ${
                        r.is_pb ? 'is-pb' : ''
                      }" style="height:${h}px" title="${r.date}: ${r.time}"></div>`;
                    })
                    .join('')}
                </div>
              `;
            }

            const trendIcon =
              d.trend === 'up'
                ? '<span class="trend up">▲</span>'
                : d.trend === 'down'
                ? '<span class="trend down">▼</span>'
                : '<span class="trend flat">—</span>';

            return `
            <div class="athlete-card">
              <a href="athlete.html?id=${a.id}">
                <div class="athlete-info">
                  <h3><span class="first-name">${first}</span> <span class="last-name">${last}</span></h3>
                  <div class="athlete-meta">
                    <span>${a.age_group || '—'}</span>
                    <span>${d.totalRuns} runs</span>
                  </div>
                </div>
              </a>
              <div class="athlete-stat-row">
                <div class="stat-box">
                  <div class="stat-value gold">${
                    d.pb ? formatTime(d.pb) : '—'
                  }</div>
                  <div class="stat-label">PB</div>
                </div>
                <div class="stat-box">
                  <div class="stat-value">${
                    d.avg4w ? formatTime(d.avg4w) : '—'
                  }${trendIcon}</div>
                  <div class="stat-label">4wk avg</div>
                </div>
                <div class="stat-box">
                  <div class="stat-value orange">${
                    d.bestAG ? d.bestAG.toFixed(1) + '%' : '—'
                  }</div>
                  <div class="stat-label">Best AG</div>
                </div>
                <div class="stat-box">
                  <div class="stat-value blue">${d.streak}</div>
                  <div class="stat-label">Streak</div>
                </div>
              </div>
              ${formHtml}
            </div>
          `;
          })
          .join('')}
      </div>
    </div>
  `;

  app.className = '';
  app.innerHTML = html;

  // Check if sample data (IDs start with 1000)
  if (athletes.length > 0 && athletes[0].id.startsWith('100000')) {
    document.getElementById('sample-notice').style.display = 'block';
  }
}
