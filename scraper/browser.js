/**
 * Shared Playwright browser utilities for parkrun scraping.
 * Uses system Chrome to avoid WAF/bot detection issues.
 */
const { chromium } = require('playwright');

const BROWSER_OPTIONS = {
  channel: 'chrome',
  headless: true,
  args: [
    '--disable-blink-features=AutomationControlled',
    '--no-sandbox',
  ],
};

const CONTEXT_OPTIONS = {
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  viewport: { width: 1280, height: 800 },
  locale: 'en-GB',
};

async function createBrowser() {
  const browser = await chromium.launch(BROWSER_OPTIONS);
  const context = await browser.newContext(CONTEXT_OPTIONS);
  return { browser, context };
}

async function navigateWithRetry(page, url, { maxRetries = 3, waitSelector = null } = {}) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`  → Loading ${url} (attempt ${attempt})`);
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

      // Wait for JS-rendered content
      if (waitSelector) {
        await page.waitForSelector(waitSelector, { timeout: 15000 });
      } else {
        // Generic wait for parkrun SPA content
        await page.waitForTimeout(3000);
      }

      return true;
    } catch (err) {
      console.warn(`  ⚠ Attempt ${attempt} failed: ${err.message}`);
      if (attempt === maxRetries) throw err;
      await page.waitForTimeout(2000 * attempt);
    }
  }
}

module.exports = { createBrowser, navigateWithRetry };
