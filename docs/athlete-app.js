/* ── ParkRun Dashboard — athlete-app.js ── */
/* Individual athlete analysis page */

(async function () {
  const app = document.getElementById('app');
  const params = new URLSearchParams(window.location.search);
  const athleteId = params.get('id');

  if (!athleteId) {
    app.innerHTML = '<div class="error">No athlete ID specified. <a href="index.html">Back to dashboard</a></div>';
    return;
  }

  try {
    const SQL = await initSqlJs({
      locateFile: (file) =>
        `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.11.0/${file}`,
    });

    const resp = await fetch('data/parkrun.db');
    if (!resp.ok) throw new Error('Failed to load database');
    const buf = await resp.arrayBuffer();
    const db = new SQL.Database(new Uint8Array(buf));

    renderAthlete(db, athleteId);
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

function rollingAvg(results, window) {
  const avgs = [];
  for (let i = 0; i < results.length; i++) {
    const start = Math.max(0, i - window + 1);
    const slice = results.slice(start, i + 1);
    const avg = slice.reduce((s, r) => s + r.time_seconds, 0) / slice.length;
    avgs.push({ date: results[i].date, avg: Math.round(avg) });
  }
  return avgs;
}

function renderAthlete(db, athleteId) {
  const app = document.getElementById('app');

  // Get athlete
  const athletes = query(db, 'SELECT * FROM athletes WHERE id = ?', [athleteId]);
  if (athletes.length === 0) {
    app.innerHTML = '<div class="error">Athlete not found. <a href="index.html">Back to dashboard</a></div>';
    return;
  }
  const athlete = athletes[0];
  const { first, last } = splitName(athlete.name);

  // Get results chronologically
  const results = query(
    db,
    'SELECT * FROM results WHERE athlete_id = ? ORDER BY date ASC',
    [athleteId]
  );

  if (results.length === 0) {
    app.innerHTML = `<div class="error">No results found for ${athlete.name}. <a href="index.html">Back</a></div>`;
    return;
  }

  // Stats
  const totalRuns = results.length;
  const pb = Math.min(...results.map((r) => r.time_seconds));
  const worst = Math.max(...results.map((r) => r.time_seconds));
  const avgTime = Math.round(results.reduce((s, r) => s + r.time_seconds, 0) / totalRuns);
  const bestAG = Math.max(...results.filter((r) => r.age_grade).map((r) => r.age_grade), 0);
  const avgAG = results.filter((r) => r.age_grade).length > 0
    ? results.filter((r) => r.age_grade).reduce((s, r) => s + r.age_grade, 0) / results.filter((r) => r.age_grade).length
    : 0;

  // Streaks
  const dates = [...new Set(results.map((r) => r.date))].sort();
  let currentStreak = 0;
  let longestStreak = 0;
  let tempStreak = 1;

  // Current streak: count back from latest
  const reverseDates = [...dates].reverse();
  if (reverseDates.length > 0) {
    currentStreak = 1;
    for (let i = 1; i < reverseDates.length; i++) {
      const diff = (new Date(reverseDates[i - 1]) - new Date(reverseDates[i])) / (1000 * 60 * 60 * 24);
      if (diff <= 8) {
        currentStreak++;
      } else {
        break;
      }
    }
  }

  // Longest streak
  for (let i = 1; i < dates.length; i++) {
    const diff = (new Date(dates[i]) - new Date(dates[i - 1])) / (1000 * 60 * 60 * 24);
    if (diff <= 8) {
      tempStreak++;
    } else {
      longestStreak = Math.max(longestStreak, tempStreak);
      tempStreak = 1;
    }
  }
  longestStreak = Math.max(longestStreak, tempStreak);

  // Consistency: % of Saturdays they ran (from first to last result)
  const firstDate = new Date(dates[0]);
  const lastDate = new Date(dates[dates.length - 1]);
  const totalWeeks = Math.round((lastDate - firstDate) / (1000 * 60 * 60 * 24 * 7)) + 1;
  const consistency = totalWeeks > 0 ? Math.round((totalRuns / totalWeeks) * 100) : 0;

  // Milestone progress
  const milestoneTargets = [25, 50, 100, 150, 200, 250, 300];
  const nextMilestone = milestoneTargets.find((t) => t > totalRuns) || null;

  // Rolling averages
  const avg4w = rollingAvg(results, 4);
  const avg12w = rollingAvg(results, 12);

  // Recent 4-week and 12-week average values
  const recent4results = results.slice(-4);
  const recent12results = results.slice(-12);
  const current4wAvg = recent4results.length > 0
    ? Math.round(recent4results.reduce((s, r) => s + r.time_seconds, 0) / recent4results.length)
    : null;
  const current12wAvg = recent12results.length > 0
    ? Math.round(recent12results.reduce((s, r) => s + r.time_seconds, 0) / recent12results.length)
    : null;

  // PB count
  const pbCount = results.filter((r) => r.is_pb).length;

  // Update page title
  document.title = `${athlete.name} — ParkRun Dashboard`;

  // Build HTML
  let html = '';

  // Back link
  html += '<a href="index.html" class="back-link">← Back to dashboard</a>';

  // Hero section
  html += `
    <div class="athlete-hero">
      <h1><span class="first-name">${first}</span> <span class="last-name">${last}</span></h1>
      <div class="meta">${athlete.age_group || ''} · ${athlete.home_event || 'cassiobury'} · parkrunner #${athleteId}</div>
      <div class="hero-stats">
        <div class="hero-stat">
          <div class="value">${totalRuns}</div>
          <div class="label">Total Runs</div>
        </div>
        <div class="hero-stat">
          <div class="value gold">${formatTime(pb)}</div>
          <div class="label">Personal Best</div>
        </div>
        <div class="hero-stat">
          <div class="value orange">${bestAG ? bestAG.toFixed(1) + '%' : '—'}</div>
          <div class="label">Best Age Grade</div>
        </div>
        <div class="hero-stat">
          <div class="value blue">${currentStreak}</div>
          <div class="label">Current Streak</div>
        </div>
      </div>
    </div>
  `;

  // Rolling averages cards
  html += `
    <div class="averages-grid">
      <div class="avg-card">
        <div class="value">${current4wAvg ? formatTime(current4wAvg) : '—'}</div>
        <div class="label">4-Week Average</div>
      </div>
      <div class="avg-card">
        <div class="value">${current12wAvg ? formatTime(current12wAvg) : '—'}</div>
        <div class="label">12-Week Average</div>
      </div>
      <div class="avg-card">
        <div class="value">${formatTime(avgTime)}</div>
        <div class="label">All-Time Average</div>
      </div>
      <div class="avg-card">
        <div class="value">${consistency}%</div>
        <div class="label">Consistency</div>
      </div>
    </div>
  `;

  // Performance chart
  html += `
    <div class="chart-container">
      <h3>📈 Performance Over Time</h3>
      <div class="chart-wrapper">
        <canvas id="perfChart"></canvas>
      </div>
    </div>
  `;

  // Age grade chart
  html += `
    <div class="chart-container">
      <h3>🎯 Age Grade Over Time</h3>
      <div class="chart-wrapper">
        <canvas id="agChart"></canvas>
      </div>
    </div>
  `;

  // Streaks
  html += `
    <div class="streaks-grid">
      <div class="streak-card">
        <div class="value">${currentStreak}</div>
        <div class="label">Current Streak</div>
      </div>
      <div class="streak-card">
        <div class="value">${longestStreak}</div>
        <div class="label">Longest Streak</div>
      </div>
      <div class="streak-card">
        <div class="value">${pbCount}</div>
        <div class="label">PBs Set</div>
      </div>
      <div class="streak-card">
        <div class="value">${nextMilestone ? nextMilestone - totalRuns : '✓'}</div>
        <div class="label">${nextMilestone ? `To ${nextMilestone} Runs` : 'All Milestones'}</div>
      </div>
    </div>
  `;

  // Stats cards
  html += `
    <div class="section">
      <div class="section-header">
        <span class="section-icon">📊</span>
        <h2>Stats</h2>
      </div>
      <div class="averages-grid">
        <div class="avg-card">
          <div class="value gold">${formatTime(pb)}</div>
          <div class="label">Personal Best</div>
        </div>
        <div class="avg-card">
          <div class="value">${formatTime(worst)}</div>
          <div class="label">Slowest</div>
        </div>
        <div class="avg-card">
          <div class="value">${formatTime(avgTime)}</div>
          <div class="label">Average</div>
        </div>
        <div class="avg-card">
          <div class="value orange">${avgAG ? avgAG.toFixed(1) + '%' : '—'}</div>
          <div class="label">Avg Age Grade</div>
        </div>
      </div>
    </div>
  `;

  // Recent results table
  const recent20 = [...results].reverse().slice(0, 20);
  html += `
    <div class="section">
      <div class="section-header">
        <span class="section-icon">🕐</span>
        <h2>Recent Results</h2>
      </div>
      <div style="overflow-x:auto">
        <table class="history-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Event</th>
              <th>Time</th>
              <th>Pos</th>
              <th>AG</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${recent20
              .map((r) => {
                const d = new Date(r.date);
                const dateStr = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' });
                return `
                <tr class="${r.is_pb ? 'pb-row' : ''}">
                  <td>${dateStr}</td>
                  <td>${r.event}</td>
                  <td class="time-cell">${r.time}</td>
                  <td>${r.position || '—'}</td>
                  <td>${r.age_grade ? r.age_grade.toFixed(1) + '%' : '—'}</td>
                  <td>${r.is_pb ? '<span class="pb-badge">PB</span>' : ''}</td>
                </tr>
              `;
              })
              .join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  app.className = '';
  app.innerHTML = html;

  // ── Charts ──
  const chartDefaults = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { labels: { color: '#a0a0b8', font: { size: 11 } } },
    },
    scales: {
      x: {
        ticks: { color: '#6b6b80', maxTicksLimit: 12, font: { size: 10 } },
        grid: { color: 'rgba(42,42,69,0.5)' },
      },
      y: {
        ticks: { color: '#6b6b80', font: { size: 10 } },
        grid: { color: 'rgba(42,42,69,0.5)' },
      },
    },
  };

  // Filter to last 18 months for charts
  const eighteenMonthsAgo = new Date();
  eighteenMonthsAgo.setMonth(eighteenMonthsAgo.getMonth() - 18);
  const chartResults = results.filter((r) => new Date(r.date) >= eighteenMonthsAgo);
  const chartAvg4w = rollingAvg(chartResults, 4);

  // Performance chart
  const perfCtx = document.getElementById('perfChart').getContext('2d');
  new Chart(perfCtx, {
    type: 'line',
    data: {
      labels: chartResults.map((r) => {
        const d = new Date(r.date);
        return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      }),
      datasets: [
        {
          label: 'Time (seconds)',
          data: chartResults.map((r) => r.time_seconds),
          borderColor: '#00d4aa',
          backgroundColor: 'rgba(0,212,170,0.1)',
          pointBackgroundColor: chartResults.map((r) =>
            r.is_pb ? '#ffd700' : '#00d4aa'
          ),
          pointRadius: chartResults.map((r) => (r.is_pb ? 6 : 2)),
          borderWidth: 2,
          tension: 0.3,
          fill: true,
        },
        {
          label: '4-Week Avg',
          data: chartAvg4w.map((a) => a.avg),
          borderColor: '#ff6b35',
          borderWidth: 2,
          borderDash: [5, 5],
          pointRadius: 0,
          tension: 0.3,
          fill: false,
        },
        {
          label: 'PB Line',
          data: chartResults.map(() => pb),
          borderColor: '#ffd700',
          borderWidth: 1,
          borderDash: [3, 3],
          pointRadius: 0,
          fill: false,
        },
      ],
    },
    options: {
      ...chartDefaults,
      scales: {
        ...chartDefaults.scales,
        y: {
          ...chartDefaults.scales.y,
          reverse: true,
          ticks: {
            ...chartDefaults.scales.y.ticks,
            callback: (v) => formatTime(v),
          },
        },
      },
      plugins: {
        ...chartDefaults.plugins,
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${formatTime(ctx.parsed.y)}`,
          },
        },
      },
    },
  });

  // Age grade chart
  const agResults = chartResults.filter((r) => r.age_grade);
  if (agResults.length > 0) {
    const agCtx = document.getElementById('agChart').getContext('2d');
    new Chart(agCtx, {
      type: 'line',
      data: {
        labels: agResults.map((r) => {
          const d = new Date(r.date);
          return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
        }),
        datasets: [
          {
            label: 'Age Grade %',
            data: agResults.map((r) => r.age_grade),
            borderColor: '#4a9eff',
            backgroundColor: 'rgba(74,158,255,0.1)',
            pointRadius: 2,
            borderWidth: 2,
            tension: 0.3,
            fill: true,
          },
        ],
      },
      options: {
        ...chartDefaults,
        scales: {
          ...chartDefaults.scales,
          y: {
            ...chartDefaults.scales.y,
            ticks: {
              ...chartDefaults.scales.y.ticks,
              callback: (v) => v + '%',
            },
          },
        },
      },
    });
  }
}
