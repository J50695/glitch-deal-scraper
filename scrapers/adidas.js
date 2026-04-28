// ============================================================
//  scrapers/adidas.js â Adidas Price Glitch Detector
// ============================================================

const { newPage, goto, parsePrice, sleep } = require('./playwright-base');

const ADIDAS_TARGETS = [
  { url: 'https://www.adidas.com/us/sale',                       label: 'Adidas Sale' },
  { url: 'https://www.adidas.com/us/outlet',                     label: 'Adidas Outlet' },
  { url: 'https://www.adidas.com/us/men-shoes?sort=price-asc',   label: 'Adidas Mens Shoes' },
];

const ADIDAS_CARD_SELECTOR = '[data-auto-id="glass-product-card"], .glass-product-card';
const BLOCKED_PATTERNS = [
  /access denied/i,
  /verify you are human/i,
  /security check/i,
  /captcha/i,
  /forbidden/i,
];

async function readPageSnapshot(page) {
  try {
    return await page.evaluate(() => ({
      title: document.title || '',
      body: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 240),
    }));
  } catch {
    return { title: '', body: '' };
  }
}

function looksBlocked(snapshot) {
  const text = `${snapshot.title} ${snapshot.body}`;
  return BLOCKED_PATTERNS.some((pattern) => pattern.test(text));
}

async function scrape(minDiscountPct = 70, options = {}) {
  const isAborted = typeof options.isAborted === 'function' ? options.isAborted : () => false;
  console.log('[Adidas] Starting scrape...');
  const deals = [];
  let emptyTargets = 0;
  let blockedTargets = 0;

  for (const target of ADIDAS_TARGETS) {
    if (isAborted()) {
      console.warn('[Adidas] Aborted before starting ' + target.label);
      break;
    }

    let page;
    try {
      page = await newPage();
      await goto(page, target.url, { timeout: 15000 });
      await page.waitForSelector(ADIDAS_CARD_SELECTOR, { timeout: 8000 }).catch(() => {});
      await sleep(1500);

      // Scroll to load lazy items
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2)).catch(() => {});
      await sleep(1000);

      const snapshot = await readPageSnapshot(page);

      const products = await page.$$eval(
        ADIDAS_CARD_SELECTOR,
        (cards) => cards.map(card => {
          const name    = card.querySelector('[class*="product-description_name"], [data-auto-id="glass-product-card-title"]')?.textContent?.trim();
          const href    = card.querySelector('a[href]')?.href;

          // Adidas shows both prices when on sale
          const prices     = Array.from(card.querySelectorAll('[data-auto-id="glass-product-card-price"] span, [class*="gl-price"] span'))
            .map(el => el.textContent?.trim())
            .filter(Boolean);

          const discountEl = card.querySelector('[class*="discount"], [data-auto-id="gl-badge"]');
          const discountStr = discountEl?.textContent?.trim();

          const imgEl  = card.querySelector('img[class*="product-card__image"], img[src*="adidas"]');
          const imgSrc = imgEl?.src;

          return { name, url: href, prices, discountStr, imgSrc };
        })
      );

      const blocked = products.length === 0 && looksBlocked(snapshot);
      console.log('[Adidas] ' + target.label + ': ' + products.length + ' items' + (blocked ? ' (blocked)' : ''));

      if (blocked) {
        blockedTargets += 1;
        emptyTargets += 1;
        if (blockedTargets >= 2) {
          console.warn('[Adidas] Repeated blocked pages, stopping early.');
          break;
        }
        continue;
      }

      if (products.length === 0) {
        emptyTargets += 1;
        if (emptyTargets >= 3) {
          console.warn('[Adidas] Repeated empty pages, stopping early.');
          break;
        }
      } else {
        emptyTargets = 0;
      }

      for (const p of products) {
        if (isAborted()) {
          console.warn('[Adidas] Aborted during ' + target.label);
          break;
        }
        if (!p.name || !p.url || !p.prices?.length) continue;

        // Adidas typically shows: ["$150", "$45"] â higher is original
        const parsedPrices = p.prices.map(parsePrice).filter(Boolean).sort((a, b) => a - b);
        if (parsedPrices.length < 1) continue;

        const current  = parsedPrices[0];
        const original = parsedPrices.length > 1 ? parsedPrices[parsedPrices.length - 1] : null;

        let discountPct = 0;
        let normalPrice = original;

        if (original && original > current) {
          discountPct = ((original - current) / original) * 100;
        } else if (p.discountStr) {
          const m = p.discountStr.match(/(\d+)%/);
          if (m) discountPct = parseInt(m[1]);
        }

        if (discountPct >= minDiscountPct) {
          console.log(`[Adidas] ð¥ ${p.name} â $${current} (${Math.round(discountPct)}% off)`);
          deals.push({
            productId:   `adidas_${Buffer.from(p.url).toString('base64').slice(0, 20)}`,
            retailer:    'Adidas',
            name:        p.name,
            url:         p.url,
            imageUrl:    p.imgSrc || null,
            price:       current,
            normalPrice: normalPrice || null,
            discountPct,
            source:      target.label,
          });
        }
      }

    } catch (err) {
      console.error(`[Adidas] Error on ${target.label}:`, err.message);
    } finally {
      if (page) await page.context().close().catch(() => {});
    }

    if (isAborted()) break;
    await sleep(1500);
  }

  console.log(`[Adidas] Done. ${deals.length} glitch deal(s) found.`);
  return deals;
}

module.exports = { scrape };
