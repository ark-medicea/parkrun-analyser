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

function badgeImg(badge, cls = 'badge-icon-lg') {
  if (!badge) return '';
  return `<img src="badges/badge-${badge}.svg" alt="${badge} badge" class="${cls}" title="${badge} parkruns">`;
}

function renderAthlete(db, athleteId) {
  const app = document.getElementById('app');

  // Get athlete
  const athlete = querySingle(db, 'SELECT * FROM athletes WHERE id = ?', [athleteId]);
  if (!athlete) {
    app.innerHTML = '<div class="error">Athlete not found. <a href="index.html">Back to dashboard</a></div>';
    return;
  }
  const { first, last } = splitName(athlete.name);

  // All results
  const allResults = query(db,
    'SELECT * FROM results WHERE athlete_id = ? ORDER BY date ASC',
    [athleteId]
  );

  // 5k results only (default view)
  const results5k = allResults.filter(r => !r.is_junior);
  const juniorResults = allResults.filter(r => r.is_junior);

  // Use pb_5k from DB, not calculated
  const pb = athlete.pb_5k || null;
  const pbSeconds = athlete.pb_5k_seconds || null;

  // Stats from 5k results
  const totalRuns5k = athlete.total_5k || results5k.length;
  const totalJunior = athlete.total_junior || juniorResults.length;
  const volCount = athlete.volunteer_count || 0;

  const worst5k = results5k.length > 0 ? Math.max(...results5k.map(r => r.time_seconds)) : null;
  const avgTime5k = results5k.length > 0
    ? Math.round(results5k.reduce((s, r) => s + r.time_seconds, 0) / results5k.length)
    : null;
  const bestAG = results5k.filter(r => r.age_grade).length > 0
    ? Math.max(...results5k.filter(r => r.age_grade).map(r => r.age_grade))
    : 0;
  const avgAG = results5k.filter(r => r.age_grade && r.age_grade > 0).length > 0
    ? results5k.filter(r => r.age_grade && r.age_grade > 0).reduce((s, r) => s + r.age_grade, 0) /
      results5k.filter(r => r.age_grade && r.age_grade > 0).length
    : 0;

  // Streaks (5k only)
  const dates = [...new Set(results5k.map(r => r.date))].sort();
  let currentStreak = 0;
  let longestStreak = 0;
  let tempStreak = 1;

  const reverseDates = [...dates].reverse();
  if (reverseDates.length > 0) {
    currentStreak = 1;
    for (let i = 1; i < reverseDates.length; i++) {
      const diff = (new Date(reverseDates[i - 1]) - new Date(reverseDates[i])) / (1000 * 60 * 60 * 24);
      if (diff <= 8) currentStreak++;
      else break;
    }
  }

  for (let i = 1; i < dates.length; i++) {
    const diff = (new Date(dates[i]) - new Date(dates[i - 1])) / (1000 * 60 * 60 * 24);
    if (diff <= 8) tempStreak++;
    else { longestStreak = Math.max(longestStreak, tempStreak); tempStreak = 1; }
  }
  longestStreak = Math.max(longestStreak, tempStreak);

  // Consistency
  const firstDate = dates.length > 0 ? new Date(dates[0]) : null;
  const lastDate = dates.length > 0 ? new Date(dates[dates.length - 1]) : null;
  const totalWeeks = firstDate && lastDate ? Math.round((lastDate - firstDate) / (1000 * 60 * 60 * 24 * 7)) + 1 : 0;
  const consistency = totalWeeks > 0 ? Math.round((totalRuns5k / totalWeeks) * 100) : 0;

  // Milestone
  const milestoneTargets = [25, 50, 100, 250, 500, 1000];
  const nextMilestone = milestoneTargets.find(t => t > totalRuns5k) || null;

  // Rolling averages
  const recent4 = results5k.slice(-4);
  const recent12 = results5k.slice(-12);
  const current4wAvg = recent4.length > 0
    ? Math.round(recent4.reduce((s, r) => s + r.time_seconds, 0) / recent4.length) : null;
  const current12wAvg = recent12.length > 0
    ? Math.round(recent12.reduce((s, r) => s + r.time_seconds, 0) / recent12.length) : null;

  const pbCount = results5k.filter(r => r.is_pb).length;

  // Per-event breakdown
  const eventBreakdown = query(db, `
    SELECT event,
      COUNT(*) as cnt,
      MIN(time_seconds) as best_time_s,
      MIN(time) as best_time,
      MAX(age_grade) as best_ag
    FROM results
    WHERE athlete_id = ? AND is_junior = 0
    GROUP BY event
    ORDER BY cnt DESC
  `, [athleteId]);

  // 2026 results
  const results2026 = results5k.filter(r => r.date >= '2026-01-01');

  document.title = `${athlete.name} — ParkRun Dashboard`;

  // ── Build HTML ──
  let html = '';
  html += '<a href="index.html" class="back-link">← Back to dashboard</a>';

  // Hero
  html += `
    <div class="athlete-hero">
      <h1>
        <span class="first-name">${first}</span> <span class="last-name">${last}</span>
        ${badgeImg(athlete.badge)}
      </h1>
      <div class="meta">${athlete.age_group || ''} · ${athlete.home_event || 'cassiobury'} · parkrunner #${athleteId}</div>
      <div class="hero-stats">
        <div class="hero-stat">
          <div class="value">${totalRuns5k}</div>
          <div class="label">5k Runs</div>
        </div>
        <div class="hero-stat">
          <div class="value gold">${pb || '—'}</div>
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

  // Averages + volunteer
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
        <div class="value">${avgTime5k ? formatTime(avgTime5k) : '—'}</div>
        <div class="label">All-Time Average</div>
      </div>
      <div class="avg-card">
        <div class="value blue">${volCount}</div>
        <div class="label">Volunteered</div>
      </div>
    </div>
  `;

  // Performance chart (5k only)
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

  // 2026 Progress chart
  if (results2026.length >= 3) {
    html += `
      <div class="chart-container">
        <h3>📊 2026 Progress</h3>
        <div class="chart-wrapper">
          <canvas id="chart2026"></canvas>
        </div>
      </div>
    `;
  }

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
        <div class="value">${consistency}%</div>
        <div class="label">Consistency</div>
      </div>
    </div>
  `;

  // Stats
  html += `
    <div class="section">
      <div class="section-header">
        <span class="section-icon">📊</span>
        <h2>Stats</h2>
      </div>
      <div class="averages-grid">
        <div class="avg-card">
          <div class="value gold">${pb || '—'}</div>
          <div class="label">Personal Best</div>
        </div>
        <div class="avg-card">
          <div class="value">${worst5k ? formatTime(worst5k) : '—'}</div>
          <div class="label">Slowest</div>
        </div>
        <div class="avg-card">
          <div class="value">${avgTime5k ? formatTime(avgTime5k) : '—'}</div>
          <div class="label">Average</div>
        </div>
        <div class="avg-card">
          <div class="value orange">${avgAG ? avgAG.toFixed(1) + '%' : '—'}</div>
          <div class="label">Avg Age Grade</div>
        </div>
      </div>
    </div>
  `;

  // Per-event breakdown
  if (eventBreakdown.length > 0) {
    html += `
      <div class="section">
        <div class="section-header">
          <span class="section-icon">📍</span>
          <h2>Events</h2>
        </div>
        <div style="overflow-x:auto">
          <table class="event-breakdown-table">
            <thead>
              <tr>
                <th>Event</th>
                <th>Runs</th>
                <th>Best Time</th>
                <th>Best AG</th>
              </tr>
            </thead>
            <tbody>
              ${eventBreakdown.map(e => `
                <tr>
                  <td>${e.event}</td>
                  <td>${e.cnt}</td>
                  <td style="font-weight:700;color:var(--accent-gold)">${e.best_time || formatTime(e.best_time_s)}</td>
                  <td style="color:var(--accent-orange)">${e.best_ag ? e.best_ag.toFixed(1) + '%' : '—'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  // Recent results with toggle for junior
  html += `
    <div class="section">
      <div class="section-header">
        <span class="section-icon">🕐</span>
        <h2>Recent Results</h2>
      </div>
      ${juniorResults.length > 0 ? `
        <div class="toggle-row">
          <label class="toggle-switch">
            <input type="checkbox" id="showJunior">
            <span class="toggle-slider"></span>
          </label>
          <span>Show junior (2k) results</span>
        </div>
      ` : ''}
      <div style="overflow-x:auto">
        <table class="history-table" id="results-table">
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
          <tbody id="results-body"></tbody>
        </table>
      </div>
    </div>
  `;

  app.className = '';
  app.innerHTML = html;

  // ── Render results table ──
  function renderResultsTable(includeJunior) {
    const displayResults = includeJunior
      ? [...allResults].reverse().slice(0, 30)
      : [...results5k].reverse().slice(0, 20);

    document.getElementById('results-body').innerHTML = displayResults.map(r => {
      const d = new Date(r.date);
      const dateStr = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' });
      const juniorTag = r.is_junior ? ' <span style="font-size:0.7rem;color:var(--accent-blue)">(2k)</span>' : '';
      return `
        <tr class="${r.is_pb ? 'pb-row' : ''}">
          <td>${dateStr}</td>
          <td>${r.event}${juniorTag}</td>
          <td class="time-cell">${r.time}</td>
          <td>${r.position || '—'}</td>
          <td>${r.age_grade ? r.age_grade.toFixed(1) + '%' : '—'}</td>
          <td>${r.is_pb ? '<span class="pb-badge">PB</span>' : ''}</td>
        </tr>
      `;
    }).join('');
  }

  renderResultsTable(false);

  // Toggle junior results
  const toggle = document.getElementById('showJunior');
  if (toggle) {
    toggle.addEventListener('change', () => renderResultsTable(toggle.checked));
  }

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

  // Last 18 months of 5k results for main charts
  const eighteenMonthsAgo = new Date();
  eighteenMonthsAgo.setMonth(eighteenMonthsAgo.getMonth() - 18);
  const chartResults = results5k.filter(r => new Date(r.date) >= eighteenMonthsAgo);
  const chartAvg4w = rollingAvg(chartResults, 4);

  // Performance chart
  if (chartResults.length > 0) {
    const perfCtx = document.getElementById('perfChart').getContext('2d');
    new Chart(perfCtx, {
      type: 'line',
      data: {
        labels: chartResults.map(r => {
          const d = new Date(r.date);
          return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
        }),
        datasets: [
          {
            label: 'Time (seconds)',
            data: chartResults.map(r => r.time_seconds),
            borderColor: '#00d4aa',
            backgroundColor: 'rgba(0,212,170,0.1)',
            pointBackgroundColor: chartResults.map(r => r.is_pb ? '#ffd700' : '#00d4aa'),
            pointRadius: chartResults.map(r => r.is_pb ? 6 : 2),
            borderWidth: 2,
            tension: 0.3,
            fill: true,
          },
          {
            label: '4-Week Avg',
            data: chartAvg4w.map(a => a.avg),
            borderColor: '#ff6b35',
            borderWidth: 2,
            borderDash: [5, 5],
            pointRadius: 0,
            tension: 0.3,
            fill: false,
          },
          {
            label: 'PB Line',
            data: chartResults.map(() => pbSeconds),
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
              callback: v => formatTime(v),
            },
          },
        },
        plugins: {
          ...chartDefaults.plugins,
          tooltip: {
            callbacks: {
              label: ctx => `${ctx.dataset.label}: ${formatTime(ctx.parsed.y)}`,
            },
          },
        },
      },
    });
  }

  // Age grade chart
  const agResults = chartResults.filter(r => r.age_grade);
  if (agResults.length > 0) {
    const agCtx = document.getElementById('agChart').getContext('2d');
    new Chart(agCtx, {
      type: 'line',
      data: {
        labels: agResults.map(r => {
          const d = new Date(r.date);
          return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
        }),
        datasets: [{
          label: 'Age Grade %',
          data: agResults.map(r => r.age_grade),
          borderColor: '#4a9eff',
          backgroundColor: 'rgba(74,158,255,0.1)',
          pointRadius: 2,
          borderWidth: 2,
          tension: 0.3,
          fill: true,
        }],
      },
      options: {
        ...chartDefaults,
        scales: {
          ...chartDefaults.scales,
          y: {
            ...chartDefaults.scales.y,
            ticks: {
              ...chartDefaults.scales.y.ticks,
              callback: v => v + '%',
            },
          },
        },
      },
    });
  }

  // 2026 Progress chart with trend line
  if (results2026.length >= 3) {
    const ctx2026 = document.getElementById('chart2026').getContext('2d');

    // Simple linear regression for trend
    const xs = results2026.map((_, i) => i);
    const ys = results2026.map(r => r.time_seconds);
    const n = xs.length;
    const sumX = xs.reduce((a, b) => a + b, 0);
    const sumY = ys.reduce((a, b) => a + b, 0);
    const sumXY = xs.reduce((a, x, i) => a + x * ys[i], 0);
    const sumX2 = xs.reduce((a, x) => a + x * x, 0);
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    const trendData = xs.map(x => Math.round(slope * x + intercept));

    new Chart(ctx2026, {
      type: 'line',
      data: {
        labels: results2026.map(r => {
          const d = new Date(r.date);
          return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
        }),
        datasets: [
          {
            label: 'Time',
            data: ys,
            borderColor: '#00d4aa',
            backgroundColor: 'rgba(0,212,170,0.1)',
            pointBackgroundColor: results2026.map(r => r.is_pb ? '#ffd700' : '#00d4aa'),
            pointRadius: 3,
            borderWidth: 2,
            tension: 0.3,
            fill: true,
          },
          {
            label: 'Trend',
            data: trendData,
            borderColor: '#ff6b35',
            borderWidth: 2,
            borderDash: [8, 4],
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
              callback: v => formatTime(v),
            },
          },
        },
        plugins: {
          ...chartDefaults.plugins,
          tooltip: {
            callbacks: {
              label: ctx => `${ctx.dataset.label}: ${formatTime(ctx.parsed.y)}`,
            },
          },
        },
      },
    });
  }
}
