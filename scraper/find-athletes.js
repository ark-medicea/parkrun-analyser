#!/usr/bin/env node
const { chromium } = require('playwright');

const EVENTS = ['cassiobury', 'canonspark', 'bushey', 'harrow'];
const SURNAMES = [
  'ALIHASSAN', 'KHIMJI', 'KASSAM', 'KALYAN', 'TEJANI', 'WALJI',
  'SIDIK', 'HAMIR', 'PANJU', 'ISMAIL', 'MERALI', 'SHABIR',
  'BHIMJI', 'DHARAMSI', 'MEGHJEE', 'KANANI', 'THAROO', 'MUSTAFA'
];

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    locale: 'en-GB',
  });
  const page = await context.newPage();
  const found = new Map();

  for (const event of EVENTS) {
    console.log(`\n=== ${event} ===`);
    try {
      await page.goto(`https://www.parkrun.org.uk/${event}/results/latestresults/`, { waitUntil: 'networkidle', timeout: 45000 });
      await page.waitForTimeout(3000);

      // Try multiple selectors for event number
      const h3texts = await page.$$eval('h3', els => els.map(e => e.textContent.trim()));
      let latest = null;
      for (const t of h3texts) {
        const m = t.match(/#(\d+)/);
        if (m) { latest = parseInt(m[1]); break; }
      }
      if (!latest) { console.log('Could not get latest event. H3s:', h3texts.slice(0,3)); continue; }
      console.log(`Latest: #${latest}`);

      const scanCount = event === 'harrow' ? 5 : 15;
      const scanRange = Array.from({ length: scanCount }, (_, i) => latest - i).filter(n => n > 0);

      for (const num of scanRange) {
        process.stdout.write(`  #${num}...`);
        try {
          await page.goto(`https://www.parkrun.org.uk/${event}/results/${num}/`, { waitUntil: 'networkidle', timeout: 30000 });
          await page.waitForTimeout(2000);

          const rows = await page.$$eval('tr.Results-table-row', trs => trs.map(tr => {
            const a = tr.querySelector('.Results-table-td--name a');
            if (!a) return null;
            const href = a.getAttribute('href') || '';
            const idm = href.match(/parkrunner\/(\d+)/);
            return {
              id: idm ? idm[1] : null,
              name: a.textContent.trim(),
              gender: tr.querySelector('.Results-table-td--gender')?.textContent.trim() || null,
              age_group: tr.querySelector('.Results-table-td--ageGroup')?.textContent.trim() || null,
            };
          }));

          let ef = 0;
          for (const r of rows) {
            if (!r?.id) continue;
            const sn = r.name.split(' ').pop().toUpperCase();
            if (SURNAMES.includes(sn) && !found.has(r.id)) {
              found.set(r.id, { ...r, event });
              ef++;
            }
          }
          process.stdout.write(` ${rows.filter(Boolean).length} runners, ${ef} new\n`);
        } catch (e) { process.stdout.write(` FAILED: ${e.message.substring(0,50)}\n`); }
        await page.waitForTimeout(1500);
      }
    } catch (e) { console.error(`Failed ${event}: ${e.message}`); }
  }

  await browser.close();

  console.log('\n\n=== ALL FOUND BY SURNAME ===');
  const sorted = [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const a of sorted) {
    console.log(`${a.name.padEnd(30)} ID: ${a.id.padEnd(10)} ${(a.age_group||'').padEnd(12)} ${a.event}`);
  }
  console.log(`\nTotal unique athletes: ${found.size}`);
}

main().catch(e => { console.error(e); process.exit(1); });
