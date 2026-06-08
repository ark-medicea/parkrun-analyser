/* ── ParkRun Dashboard — athlete-app.js (Server API version) ── */
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
    const resp = await fetch('api.php?athlete=' + encodeURIComponent(athleteId));
    if (!resp.ok) throw new Error('API request failed');
    const data = await resp.json();

    renderAthlete(data, athleteId);
  } catch (err) {
    app.innerHTML = `<div class="error">Failed to load: ${err.message}</div>`;
    console.error(err);
  }
})();

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

/* ── Date label formatter ── */
function makeDateLabel(dateStr, multiYear) {
  const d = new Date(dateStr);
  if (multiYear) {
    const day = d.getDate();
    const mon = d.toLocaleDateString('en-GB', { month: 'short' });
    const yr = String(d.getFullYear()).slice(2);
    return `${day} ${mon} '${yr}`;
  }
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function isMultiYear(results) {
  if (results.length < 2) return false;
  const first = new Date(results[0].date).getFullYear();
  const last = new Date(results[results.length - 1].date).getFullYear();
  return first !== last;
}

/* ── Medal gallery builder ── */
function buildMedalGallery(totalRuns, volCount, ageGroup) {
  const runMilestones = [25, 50, 100, 250, 500, 1000];
  const volMilestones = [25, 50, 100, 250];

  // Jr 10 badge only for junior age categories (JM10, JW10, JM11-14, JW11-14, JM15-17, JW15-17)
  const isJunior = ageGroup && /^J[MW]/.test(ageGroup);

  let html = '<div class="medal-gallery">';

  // Junior milestone (badge-10) — only for junior athletes
  if (isJunior && totalRuns >= 10) {
    html += `<div class="medal-item earned"><img src="badges/badge-10.svg" alt="10 runs" class="medal-badge"><span class="medal-label">10</span></div>`;
  }

  // Run milestones
  runMilestones.forEach(m => {
    if (totalRuns >= m) {
      html += `<div class="medal-item earned"><img src="badges/badge-${m}.svg" alt="${m} runs" class="medal-badge"><span class="medal-label">${m}</span></div>`;
    }
  });

  // Separator if any vol badges earned
  const earnedVol = volMilestones.filter(m => volCount >= m);
  if (earnedVol.length > 0) {
    html += '<div class="medal-separator"></div>';
    earnedVol.forEach(m => {
      html += `<div class="medal-item earned vol"><img src="badges/badge-vol.svg" alt="Volunteer ${m}" class="medal-badge"><span class="medal-label">${m}v</span></div>`;
    });
  }

  html += '</div>';
  return html;
}

/* ── Time window filter ── */
function filterByTimeWindow(results, windowKey) {
  if (windowKey === 'all') return results;
  const now = new Date();
  let cutoff;
  switch (windowKey) {
    case '1m':
      cutoff = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
      break;
    case '3m':
      cutoff = new Date(now.getFullYear(), now.getMonth() - 3, now.getDate());
      break;
    case '12m':
      cutoff = new Date(now.getFullYear(), now.getMonth() - 12, now.getDate());
      break;
    case 'ytd':
      cutoff = new Date(now.getFullYear(), 0, 1);
      break;
    default:
      return results;
  }
  return results.filter(r => new Date(r.date) >= cutoff);
}

function renderAthlete(data, athleteId) {
  const app = document.getElementById('app');

  // Get athlete
  const athlete = data.athlete;
  if (!athlete) {
    app.innerHTML = '<div class="error">Athlete not found. <a href="index.html">Back to dashboard</a></div>';
    return;
  }
  const { first, last } = splitName(athlete.name);

  // All results (full, unfiltered) — sorted ASC by date from API
  const allResults = data.results;

  const allResults5k = allResults.filter(r => !r.is_junior);
  const allJuniorResults = allResults.filter(r => r.is_junior);

  // Totals from API
  const totalRuns5k = athlete.total_5k || allResults5k.length;
  const totalJunior = athlete.total_junior || allJuniorResults.length;
  const totalRuns = totalRuns5k + totalJunior;
  const volCount = athlete.volunteer_count || 0;

  // Use pb_5k from API
  const pb = athlete.pb_5k || null;
  const pbSeconds = athlete.pb_5k_seconds || null;

  // Best AG (all-time, for hero) — from allTimeStats or computed
  const bestAGAllTime = data.allTimeStats && data.allTimeStats.best_ag
    ? data.allTimeStats.best_ag
    : (allResults5k.filter(r => r.age_grade).length > 0
        ? Math.max(...allResults5k.filter(r => r.age_grade).map(r => r.age_grade))
        : 0);

  // Current streak (all-time, not time-filtered)
  const allDates = [...new Set(allResults5k.map(r => r.date))].sort();
  let currentStreakAllTime = 0;
  const revDates = [...allDates].reverse();
  if (revDates.length > 0) {
    currentStreakAllTime = 1;
    for (let i = 1; i < revDates.length; i++) {
      const diff = (new Date(revDates[i - 1]) - new Date(revDates[i])) / (1000 * 60 * 60 * 24);
      if (diff <= 8) currentStreakAllTime++;
      else break;
    }
  }

  const pbCount = allResults5k.filter(r => r.is_pb).length;

  document.title = `${athlete.name} — #NoMasti`;

  // ── Build static shell HTML ──
  let html = '';
  html += '<a href="index.html" class="back-link">← Back to dashboard</a>';

  // Hero
  html += `
    <div class="athlete-hero">
      <h1>
        <span class="first-name">${first}</span> <span class="last-name">${last}</span>
      </h1>
      ${buildMedalGallery(totalRuns, volCount, athlete.age_group)}
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
          <div class="value orange">${bestAGAllTime ? bestAGAllTime.toFixed(1) + '%' : '—'}</div>
          <div class="label">Best Age Grade</div>
        </div>
        <div class="hero-stat">
          <div class="value blue">${currentStreakAllTime}</div>
          <div class="label">Current Streak</div>
        </div>
      </div>
    </div>
  `;

  // Time controls
  html += `
    <div class="time-controls">
      <button class="time-pill" data-window="1m">Last Month</button>
      <button class="time-pill" data-window="3m">Last 3 Months</button>
      <button class="time-pill" data-window="12m">Last 12 Months</button>
      <button class="time-pill" data-window="ytd">Year to Date</button>
      <button class="time-pill active" data-window="all">All Time</button>
    </div>
  `;

  // Dynamic content container
  html += '<div id="dynamic-content"></div>';

  app.className = '';
  app.innerHTML = html;

  // ── Time control wiring ──
  let activeWindow = 'all';
  const pills = document.querySelectorAll('.time-pill');
  pills.forEach(pill => {
    pill.addEventListener('click', () => {
      pills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      activeWindow = pill.dataset.window;
      renderDynamic(activeWindow);
    });
  });

  // Initial render
  renderDynamic('all');

  function renderDynamic(windowKey) {
    const container = document.getElementById('dynamic-content');

    // Filter results by time window
    const filteredAll = filterByTimeWindow(allResults, windowKey);
    const filtered5k = filteredAll.filter(r => !r.is_junior);
    const filteredJunior = filteredAll.filter(r => r.is_junior);

    // Stats from filtered 5k results
    const worst5k = filtered5k.length > 0 ? Math.max(...filtered5k.map(r => r.time_seconds)) : null;
    const avgTime5k = filtered5k.length > 0
      ? Math.round(filtered5k.reduce((s, r) => s + r.time_seconds, 0) / filtered5k.length)
      : null;
    const bestAG = filtered5k.filter(r => r.age_grade).length > 0
      ? Math.max(...filtered5k.filter(r => r.age_grade).map(r => r.age_grade))
      : 0;
    const avgAG = filtered5k.filter(r => r.age_grade && r.age_grade > 0).length > 0
      ? filtered5k.filter(r => r.age_grade && r.age_grade > 0).reduce((s, r) => s + r.age_grade, 0) /
        filtered5k.filter(r => r.age_grade && r.age_grade > 0).length
      : 0;

    // Streaks (from filtered 5k)
    const dates = [...new Set(filtered5k.map(r => r.date))].sort();
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
    const consistency = totalWeeks > 0 ? Math.round((filtered5k.length / totalWeeks) * 100) : 0;

    // Rolling averages (from filtered 5k)
    const recent4 = filtered5k.slice(-4);
    const recent12 = filtered5k.slice(-12);
    const current4wAvg = recent4.length > 0
      ? Math.round(recent4.reduce((s, r) => s + r.time_seconds, 0) / recent4.length) : null;
    const current12wAvg = recent12.length > 0
      ? Math.round(recent12.reduce((s, r) => s + r.time_seconds, 0) / recent12.length) : null;

    const filteredPbCount = filtered5k.filter(r => r.is_pb).length;

    // Per-event breakdown (5k)
    const event5kMap = {};
    filtered5k.forEach(r => {
      if (!event5kMap[r.event]) event5kMap[r.event] = { event: r.event, cnt: 0, best_time_s: Infinity, best_time: null, best_ag: 0 };
      const e = event5kMap[r.event];
      e.cnt++;
      if (r.time_seconds < e.best_time_s) { e.best_time_s = r.time_seconds; e.best_time = r.time; }
      if (r.age_grade && r.age_grade > e.best_ag) e.best_ag = r.age_grade;
    });
    const eventBreakdown5k = Object.values(event5kMap).sort((a, b) => b.cnt - a.cnt);

    // Per-event breakdown (junior)
    const eventJuniorMap = {};
    filteredJunior.forEach(r => {
      if (!eventJuniorMap[r.event]) eventJuniorMap[r.event] = { event: r.event, cnt: 0, best_time_s: Infinity, best_time: null };
      const e = eventJuniorMap[r.event];
      e.cnt++;
      if (r.time_seconds < e.best_time_s) { e.best_time_s = r.time_seconds; e.best_time = r.time; }
    });
    const eventBreakdownJunior = Object.values(eventJuniorMap).sort((a, b) => b.cnt - a.cnt);

    // Chart data uses filtered 5k
    const chartResults = filtered5k;
    const chartAvg4w = rollingAvg(chartResults, 4);
    const multiYear = isMultiYear(chartResults);

    // ── Build dynamic HTML ──
    let dhtml = '';

    // Averages + volunteer
    dhtml += `
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
    if (chartResults.length > 0) {
      dhtml += `
        <div class="chart-container">
          <h3>📈 Performance Over Time</h3>
          <div class="chart-wrapper">
            <canvas id="perfChart"></canvas>
          </div>
        </div>
      `;
    }

    // Age grade chart
    const agResults = chartResults.filter(r => r.age_grade);
    if (agResults.length > 0) {
      dhtml += `
        <div class="chart-container">
          <h3>🎯 Age Grade Over Time</h3>
          <div class="chart-wrapper">
            <canvas id="agChart"></canvas>
          </div>
        </div>
      `;
    }

    // Streaks
    dhtml += `
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
          <div class="value">${filteredPbCount}</div>
          <div class="label">PBs Set</div>
        </div>
        <div class="streak-card">
          <div class="value">${consistency}%</div>
          <div class="label">Consistency</div>
        </div>
      </div>
    `;

    // Stats
    dhtml += `
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

    // Events - 5k
    if (eventBreakdown5k.length > 0) {
      dhtml += `
        <div class="section">
          <div class="section-header">
            <span class="section-icon">📍</span>
            <h2>5k Events</h2>
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
                ${eventBreakdown5k.map(e => `
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

    // Events - Junior
    if (eventBreakdownJunior.length > 0) {
      dhtml += `
        <div class="section">
          <div class="section-header">
            <span class="section-icon">🏃‍♂️</span>
            <h2>Junior Events</h2>
          </div>
          <div style="overflow-x:auto">
            <table class="event-breakdown-table">
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Runs</th>
                  <th>Best Time</th>
                </tr>
              </thead>
              <tbody>
                ${eventBreakdownJunior.map(e => `
                  <tr>
                    <td>${e.event}</td>
                    <td>${e.cnt}</td>
                    <td style="font-weight:700;color:var(--accent-gold)">${e.best_time || formatTime(e.best_time_s)}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      `;
    }

    // Volunteering
    if (volCount > 0) {
      dhtml += `
        <div class="section">
          <div class="section-header">
            <span class="section-icon">🤝</span>
            <h2>Volunteering</h2>
          </div>
          <div class="vol-card">
            <div class="vol-count">${volCount}</div>
            <div class="vol-label">Total volunteer sessions</div>
          </div>
        </div>
      `;
    }

    // Recent results — all results, no toggle, up to 30
    const displayResults = [...filteredAll].reverse().slice(0, 30);
    dhtml += `
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
              ${displayResults.map(r => {
                const d = new Date(r.date);
                const dateStr = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' });
                const juniorTag = r.is_junior ? ' <span class="junior-tag">(Junior)</span>' : '';
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
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;

    container.innerHTML = dhtml;

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

    // Performance chart
    if (chartResults.length > 0) {
      const perfCtx = document.getElementById('perfChart').getContext('2d');
      new Chart(perfCtx, {
        type: 'line',
        data: {
          labels: chartResults.map(r => makeDateLabel(r.date, multiYear)),
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
    if (agResults.length > 0) {
      const agMultiYear = isMultiYear(agResults);
      const agCtx = document.getElementById('agChart').getContext('2d');
      new Chart(agCtx, {
        type: 'line',
        data: {
          labels: agResults.map(r => makeDateLabel(r.date, agMultiYear)),
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
  }
}
