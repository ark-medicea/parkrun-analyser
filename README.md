# 🏃 ParkRun Family Dashboard

A static dashboard tracking parkrun results for family and friends. Designed to be deployed on GitHub Pages with automated weekly data updates.

## Live Dashboard

Deploy to GitHub Pages from the `docs/` directory. The dashboard works immediately with the included sample data.

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Discover Athletes

The discover script scrapes recent Cassiobury parkrun results and finds athletes matching the configured surnames (PANJU, MEGHJEE, TEJANI, KANANI):

```bash
npm run scrape:discover        # Check last 4 weeks
npm run scrape:discover -- --weeks=8   # Check more weeks
```

This updates `config.json` with discovered athlete IDs.

### 3. Update Data

Scrape full history for all configured athletes:

```bash
npm run scrape:update
```

### 4. Full Scrape (Discover + Update)

```bash
npm run scrape
```

### 5. Copy Data for Dashboard

After scraping, copy the data file to the docs directory:

```bash
cp data/athletes.json docs/data/athletes.json
```

## Configuration

Edit `config.json`:

```json
{
  "event": "cassiobury",
  "surnames": ["PANJU", "MEGHJEE", "TEJANI", "KANANI"],
  "athletes": []
}
```

- **event**: The parkrun event to search (URL slug)
- **surnames**: Surnames to search for in results pages
- **athletes**: Auto-populated by the discover script

## GitHub Pages Deployment

1. Push to GitHub
2. Go to Settings → Pages → Source: **Deploy from a branch**
3. Branch: `main`, Folder: `/docs`
4. The dashboard will be live at `https://<user>.github.io/parkrun-dashboard/`

## Automated Updates

The included GitHub Actions workflow (`.github/workflows/update.yml`) runs every Saturday at 14:00 UTC to:

1. Discover any new athletes matching the surnames
2. Scrape updated results for all tracked athletes
3. Commit and push the new data

You can also trigger it manually from the Actions tab.

## Requirements

- Node.js 22+
- Playwright (for scraping) — uses system Chrome
- The scraper needs a real browser because parkrun.org.uk is a JS-rendered SPA with WAF protection

## Project Structure

```
parkrun-dashboard/
├── config.json              # Tracked athletes & event config
├── data/
│   └── athletes.json        # Scraped athlete data
├── docs/                    # GitHub Pages root
│   ├── index.html
│   ├── style.css
│   ├── app.js
│   └── data/
│       └── athletes.json    # Copy of scraped data
├── scraper/
│   ├── index.js             # Main entry (discover + update)
│   ├── discover.js          # Find athletes by surname
│   ├── update.js            # Scrape athlete histories
│   ├── browser.js           # Shared Playwright utilities
│   └── generate-sample-data.js  # Sample data generator
└── .github/workflows/
    └── update.yml           # Weekly auto-update
```

## Dashboard Features

- **Highlights** — PBs, milestones, notable achievements
- **This Week's Results** — who ran, times, positions, age grades
- **Who Didn't Run** — absentees with broken streak notices
- **Upcoming Milestones** — progress toward 50/100/200/etc run targets
- **Athlete Cards** — expandable cards with stats, form bars, trends
- Dark theme, mobile-first responsive design
