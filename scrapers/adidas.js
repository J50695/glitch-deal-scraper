// ============================================================
//  scrapers/adidas.js â Adidas Price Glitch Detector
// ============================================================

const { newPage, goto, parsePrice, sleep } = require('./playwright-base');

const ADIDAS_TARGETS = [
  { url: 'https://www.adidas.com/us/sale',                           label: 'Adidas â Sale'          },
  { url: 'https://www.adidas.com/us/men-shoes?sort=price-asc',       label: 'Adidas â Men\'s Shoes'  },
  { url: 'https://www.adidas.com/us/women-shoes?sort=price-asc',     label: 'Adidas â Women\'s Shoes' },
  { url: 'https://www.adidas.com/us/outlet',                         label: 'Adidas â Outlet'        },
];

async function scrape(minDiscountPct = 70) {
  console.log('[Adidas] Starting scrape...');
  const deals = [];

  for (const target of ADIDAS_TARGETS) {
    let page;
    try {
      page = await newPage();
      await goto(page, target.url);
      await page.waitForSelector('[data-auto-id="glass-product-card"], .glass-product-card', { timeout: 20000 }).catch(() => {});
      await sleep(2500);

      // Scroll to load lazy items
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 3));
      await sleep(2000);

      const products = await page.$$eval(
        '[data-auto-id="glass-product-card"], .glass-product-card',
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

      console.log(`[Adidas] ${target.label}: ${products.length} items`);

      for (const p of products) {
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

    await sleep(5000);
  }

  console.log(`[Adidas] Done. ${deals.length} glitch deal(s) found.`);
  return deals;
}

module.exports = { scrape };
