/* ── ParkRun Dashboard App ── */

(function () {
  'use strict';

  const DATA_URL = 'data/athletes.json';
  const MILESTONES = [50, 100, 150, 200, 250, 300, 500];

  // ── Data Loading ──
  async function loadData() {
    // Try relative path (GitHub Pages serves from docs/)
    // Data is copied/symlinked into docs/data/ for deployment
    const paths = ['data/athletes.json', '../data/athletes.json'];
    for (const p of paths) {
      try {
        const res = await fetch(p);
        if (res.ok) return await res.json();
      } catch (_) {}
    }
    throw new Error('Could not load athlete data');
  }

  // ── Helpers ──
  function formatName(fullName) {
    const parts = fullName.split(' ');
    const last = parts.pop();
    return `<span class="first-name">${parts.join(' ')}</span> <span class="last-name">${last}</span>`;
  }

  function firstName(fullName) {
    return fullName.split(' ')[0];
  }

  function getLatestDate(data) {
    return data.lastUpdated || '';
  }

  function formatDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  }

  function formatDateShort(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }

  function thisWeekResults(athlete, latestDate) {
    return athlete.results.filter(r => r.date === latestDate);
  }

  function getRecentResults(athlete, n) {
    const sorted = [...athlete.results].sort((a, b) => b.date.localeCompare(a.date));
    return sorted.slice(0, n);
  }

  function computeTrend(athlete) {
    const recent = getRecentResults(athlete, 10);
    if (recent.length < 3) return { direction: 'flat', symbol: '→' };
    const recentAvg = recent.slice(0, 3).reduce((s, r) => s + r.timeSeconds, 0) / 3;
    const olderAvg = recent.slice(-3).reduce((s, r) => s + r.timeSeconds, 0) / 3;
    const diff = recentAvg - olderAvg;
    if (diff < -10) return { direction: 'up', symbol: '↑' }; // faster = improving
    if (diff > 10) return { direction: 'down', symbol: '↓' };
    return { direction: 'flat', symbol: '→' };
  }

  function nextMilestone(totalRuns) {
    for (const m of MILESTONES) {
      if (totalRuns < m) return { target: m, remaining: m - totalRuns };
    }
    return null;
  }

  function consecutiveWeekStreak(athlete, latestDate) {
    // Calculate from results data
    if (!latestDate) return 0;
    const dates = new Set(athlete.results.map(r => r.date));
    let streak = 0;
    let d = new Date(latestDate + 'T00:00:00');
    while (dates.has(d.toISOString().split('T')[0])) {
      streak++;
      d.setDate(d.getDate() - 7);
    }
    return streak;
  }

  // ── Rendering ──
  function render(data) {
    const app = document.getElementById('app');
    const latestDate = getLatestDate(data);

    // Update header
    document.getElementById('last-updated').textContent =
      `Cassiobury parkrun · ${formatDate(latestDate)}`;

    // Show sample data notice
    if (data._meta?.sampleData) {
      document.getElementById('sample-notice').style.display = 'block';
    }

    // Compute derived data
    const athletes = data.athletes.map(a => ({
      ...a,
      thisWeek: thisWeekResults(a, latestDate),
      recent: getRecentResults(a, 10),
      trend: computeTrend(a),
      milestone: nextMilestone(a.totalRuns),
      streak: a.currentStreak || consecutiveWeekStreak(a, latestDate),
    }));

    const ran = athletes.filter(a => a.thisWeek.length > 0);
    const didntRun = athletes.filter(a => a.thisWeek.length === 0);

    // Sort runners by time
    ran.sort((a, b) => (a.thisWeek[0]?.timeSeconds || 9999) - (b.thisWeek[0]?.timeSeconds || 9999));

    let html = '';
    html += renderHighlights(athletes, ran, latestDate);
    html += renderThisWeek(ran);
    html += renderAbsent(didntRun);
    html += renderMilestones(athletes);
    html += renderAthleteCards(athletes);

    app.innerHTML = html;

    // Attach card toggle listeners
    document.querySelectorAll('.athlete-header').forEach(el => {
      el.addEventListener('click', () => {
        el.closest('.athlete-card').classList.toggle('expanded');
      });
    });
  }

  function renderHighlights(athletes, ran, latestDate) {
    const highlights = [];

    // PBs this week
    for (const a of ran) {
      for (const r of a.thisWeek) {
        if (r.isPB) {
          highlights.push({
            type: 'pb',
            emoji: '🏆',
            html: `<strong>${firstName(a.name)}</strong> set a new PB! <strong>${r.time}</strong>`,
          });
        }
      }
    }

    // Big streaks
    for (const a of athletes) {
      if (a.streak >= 10) {
        highlights.push({
          type: 'streak',
          emoji: '🔥',
          html: `<strong>${firstName(a.name)}</strong> is on a <strong>${a.streak}-week streak</strong>`,
        });
      }
    }

    // Close milestones (within 5 runs)
    for (const a of athletes) {
      if (a.milestone && a.milestone.remaining <= 5) {
        highlights.push({
          type: 'milestone',
          emoji: '⭐',
          html: `<strong>${firstName(a.name)}</strong> is <strong>${a.milestone.remaining} run${a.milestone.remaining === 1 ? '' : 's'}</strong> from <strong>${a.milestone.target}</strong>!`,
        });
      }
    }

    // Best age grade this week
    const bestAG = ran.reduce((best, a) => {
      const ag = a.thisWeek[0]?.ageGrade || 0;
      return ag > (best?.ag || 0) ? { name: a.name, ag } : best;
    }, null);
    if (bestAG && bestAG.ag > 0) {
      highlights.push({
        type: 'streak',
        emoji: '📊',
        html: `Best age grade this week: <strong>${firstName(bestAG.name)}</strong> with <strong>${bestAG.ag.toFixed(1)}%</strong>`,
      });
    }

    if (highlights.length === 0) return '';

    return `
      <div class="section">
        <div class="section-header">
          <span class="section-icon">✨</span>
          <h2>Highlights</h2>
        </div>
        <div class="highlights">
          ${highlights.map(h => `
            <div class="highlight-card ${h.type}">
              <span class="highlight-emoji">${h.emoji}</span>
              <span class="highlight-text">${h.html}</span>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  function renderThisWeek(ran) {
    if (ran.length === 0) {
      return `
        <div class="section">
          <div class="section-header">
            <span class="section-icon">📋</span>
            <h2>This Week's Results</h2>
          </div>
          <p style="color: var(--text-secondary); padding: 1rem;">No results yet for this week.</p>
        </div>
      `;
    }

    return `
      <div class="section">
        <div class="section-header">
          <span class="section-icon">📋</span>
          <h2>This Week's Results</h2>
        </div>
        <div class="results-grid">
          ${ran.map(a => {
            const r = a.thisWeek[0];
            return `
              <div class="result-row">
                <div class="result-name">
                  ${formatName(a.name)}
                  ${r.isPB ? '<span class="pb-badge">PB!</span>' : ''}
                </div>
                <div class="result-ag">${r.ageGrade ? r.ageGrade.toFixed(1) + '%' : ''}</div>
                <div class="result-pos">#${r.position}</div>
                <div class="result-time ${r.isPB ? 'is-pb' : ''}">${r.time}</div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  function renderAbsent(didntRun) {
    if (didntRun.length === 0) return '';

    return `
      <div class="section">
        <div class="section-header">
          <span class="section-icon">😴</span>
          <h2>Didn't Run This Week</h2>
        </div>
        <div class="absent-list">
          ${didntRun.map(a => {
            const streakNote = a.streak > 3 ? `<span class="streak-lost">broke ${a.streak}w streak</span>` : '';
            return `<span class="absent-chip">${firstName(a.name)} ${a.name.split(' ').pop()}${streakNote}</span>`;
          }).join('')}
        </div>
      </div>
    `;
  }

  function renderMilestones(athletes) {
    const upcoming = athletes
      .filter(a => a.milestone && a.milestone.remaining <= 20)
      .sort((a, b) => a.milestone.remaining - b.milestone.remaining);

    if (upcoming.length === 0) return '';

    return `
      <div class="section">
        <div class="section-header">
          <span class="section-icon">🎯</span>
          <h2>Upcoming Milestones</h2>
        </div>
        <div class="milestone-list">
          ${upcoming.map(a => {
            const pct = (a.totalRuns / a.milestone.target) * 100;
            const r = 20;
            const circ = 2 * Math.PI * r;
            const offset = circ - (pct / 100) * circ;
            return `
              <div class="milestone-item">
                <div class="milestone-progress">
                  <svg viewBox="0 0 48 48">
                    <circle class="bg" cx="24" cy="24" r="${r}" />
                    <circle class="fg" cx="24" cy="24" r="${r}"
                      stroke-dasharray="${circ}" stroke-dashoffset="${offset}" />
                  </svg>
                  <span class="milestone-count">${a.totalRuns}</span>
                </div>
                <div class="milestone-detail">
                  <div class="milestone-name">${a.name}</div>
                  <div class="milestone-desc">${a.milestone.remaining} run${a.milestone.remaining === 1 ? '' : 's'} to reach <strong>${a.milestone.target}</strong></div>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  function renderAthleteCards(athletes) {
    // Sort by total runs descending
    const sorted = [...athletes].sort((a, b) => b.totalRuns - a.totalRuns);

    return `
      <div class="section">
        <div class="section-header">
          <span class="section-icon">👥</span>
          <h2>Athletes</h2>
        </div>
        <div class="athlete-cards">
          ${sorted.map(a => renderAthleteCard(a)).join('')}
        </div>
      </div>
    `;
  }

  function renderAthleteCard(a) {
    const trend = a.trend;
    const recent5 = getRecentResults(a, 10);

    // Form bars: normalize times relative to PB and slowest
    const times = recent5.map(r => r.timeSeconds);
    const maxT = Math.max(...times);
    const minT = Math.min(...times);
    const range = maxT - minT || 60;

    const bars = recent5.reverse().map(r => {
      // Higher bar = faster time (inverted)
      const pct = 20 + ((maxT - r.timeSeconds) / range) * 80;
      return `
        <div class="form-bar ${r.isPB ? 'is-pb' : ''}" style="height: ${pct}%">
          <div class="form-bar-tooltip">${formatDateShort(r.date)}: ${r.time}${r.isPB ? ' PB!' : ''}</div>
        </div>
      `;
    }).join('');

    // Age grade trend
    const recentAG = recent5.length > 0 ? recent5[recent5.length - 1].ageGrade : 0;

    return `
      <div class="athlete-card">
        <div class="athlete-header">
          <div class="athlete-info">
            <h3>${formatName(a.name)}</h3>
            <div class="athlete-meta">
              <span>${a.ageGroup}</span>
              <span>${a.gender === 'M' ? '♂' : '♀'}</span>
            </div>
          </div>
          <span class="expand-arrow">▼</span>
        </div>

        <div class="athlete-stat-row">
          <div class="stat-box">
            <div class="stat-value">${a.totalRuns}</div>
            <div class="stat-label">Runs</div>
          </div>
          <div class="stat-box">
            <div class="stat-value gold">${a.pb}</div>
            <div class="stat-label">PB</div>
          </div>
          <div class="stat-box">
            <div class="stat-value blue">${a.streak}w</div>
            <div class="stat-label">Streak</div>
          </div>
          <div class="stat-box">
            <div class="stat-value orange">${a.bestAgeGrade.toFixed(1)}%</div>
            <div class="stat-label">Best AG</div>
          </div>
        </div>

        <div class="athlete-detail">
          <div class="recent-form">
            <h4>Recent Form <span class="trend ${trend.direction}">${trend.symbol} ${trend.direction === 'up' ? 'improving' : trend.direction === 'down' ? 'slowing' : 'steady'}</span></h4>
            <div class="form-bars">${bars}</div>
          </div>
          ${a.milestone ? `
            <p style="margin-top: 0.75rem; font-size: 0.85rem; color: var(--text-secondary);">
              🎯 ${a.milestone.remaining} run${a.milestone.remaining === 1 ? '' : 's'} to <strong style="color: var(--accent-orange)">${a.milestone.target}</strong>
            </p>
          ` : ''}
        </div>
      </div>
    `;
  }

  // ── Init ──
  loadData().then(render).catch(err => {
    document.getElementById('app').innerHTML = `
      <div class="loading" style="color: var(--accent-red);">
        Failed to load data: ${err.message}<br>
        <small style="color: var(--text-muted)">Make sure data/athletes.json exists in the docs/ directory</small>
      </div>
    `;
  });
})();
