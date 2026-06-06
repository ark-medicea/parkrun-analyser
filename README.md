# ParkRun Dashboard 🏃

A family & friends parkrun tracker for Cassiobury parkrun. Built with SQLite + [sql.js](https://sql.js.org/) — the entire dashboard runs client-side with no backend.

## Architecture

- **Database:** SQLite (`data/parkrun.db`) with athletes + results tables
- **Scraper:** Node.js + Playwright scripts that populate the SQLite DB from parkrun.org.uk
- **Dashboard:** Static HTML/CSS/JS served via GitHub Pages, using sql.js (SQLite compiled to WASM) to query the DB directly in the browser
- **Updates:** GitHub Actions cron job every Saturday at 12:00 UK time

## Quick Start

```bash
# Install dependencies
npm install

# Generate sample data
npm run db:init

# Export to docs for the dashboard
npm run db:export

# Open docs/index.html in your browser
```

## Scripts

| Script | Description |
|--------|-------------|
| `npm run db:init` | Generate sample database |
| `npm run db:export` | Copy DB to `docs/data/` for the dashboard |
| `npm run scrape:discover` | Find athletes by surname in recent results |
| `npm run scrape:update` | Update all active athletes' results |
| `npm run scrape` | Run discover + update |

## Pages

- **Dashboard** (`docs/index.html`) — Overview with highlights, this week's results, milestones, athlete cards
- **Athlete** (`docs/athlete.html?id=X`) — Individual performance charts, stats, streaks, history
- **Add Athlete** (`docs/add.html`) — Request adding a new athlete via GitHub issue

## Configuration

Edit `config.json` to change tracked surnames or event:

```json
{
  "event": "cassiobury",
  "eventId": 1152,
  "surnames": ["PANJU", "MEGHJEE", "TEJANI", "KANANI"]
}
```

## Tech Stack

- [sql.js](https://sql.js.org/) — SQLite compiled to WASM (browser + Node.js)
- [Chart.js](https://www.chartjs.org/) — Performance charts
- [Playwright](https://playwright.dev/) — Web scraping
- GitHub Pages — Static hosting
- GitHub Actions — Automated weekly updates
