// ============================================================
//  scrapers/nike.js â Nike Price Glitch Detector
//
//  Monitors Nike's sale and clearance sections.
//  Nike's sale page shows original + sale price â we detect
//  when something drops unusually far (70%+) vs. its listed
//  original price, or when known glitch patterns appear.
// ============================================================

const { newPage, goto, parsePrice, sleep } = require('./playwright-base');

const NIKE_TARGETS = [
  { url: 'https://www.nike.com/w/sale-3yaep',            label: 'Nike â Sale' },
  { url: 'https://www.nike.com/w/mens-shoes-nik1zy7ok',  label: 'Nike â Men\'s Shoes Sale' },
  { url: 'https://www.nike.com/w/womens-shoes-5e1x6zy7ok', label: 'Nike â Women\'s Shoes Sale' },
  { url: 'https://www.nike.com/w/mens-clothing-6ymx6znik1', label: 'Nike â Men\'s Apparel Sale' },
];

async function scrape(minDiscountPct = 70) {
  console.log('[Nike] Starting scrape...');
  const deals = [];

  for (const target of NIKE_TARGETS) {
    let page;
    try {
      page = await newPage();
      await goto(page, target.url);

      // Nike loads products lazily â scroll to get more items
      await page.waitForSelector('[data-testid="product-card"], .product-card', { timeout: 20000 }).catch(() => {});
      await sleep(2000);

      // Scroll down to load more products
      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
        await sleep(1500);
      }

      const products = await page.$$eval(
        '[data-testid="product-card"], .product-card',
        (cards) => cards.map(card => {
          const name    = card.querySelector('[data-testid="product-card__title"], .product-card__title')?.textContent?.trim();
          const subname = card.querySelector('[data-testid="product-card__subtitle"], .product-card__subtitle')?.textContent?.trim();
          const href    = card.querySelector('[data-testid="product-card__link-overlay"], a.product-card__link-overlay')?.href;

          // Current / sale price
          const currentEl  = card.querySelector('[data-testid="product-price"], .product-price');
          const currentStr = currentEl?.textContent?.trim();

          // Original price (before sale)
          const originalEl  = card.querySelector('[data-testid="product-price-reduced"], .product-price__wrapper del, .is--strikethrough');
          const originalStr = originalEl?.textContent?.trim();

          // Discount % shown by Nike
          const discountEl  = card.querySelector('.product-card__discount, [data-testid="product-card__discount"]');
          const discountStr = discountEl?.textContent?.trim();

          const imgEl  = card.querySelector('img.product-card__hero-image, [data-testid="product-card__hero-image"]');
          const imgSrc = imgEl?.src;

          return { name, subname, url: href, currentStr, originalStr, discountStr, imgSrc };
        })
      );

      console.log(`[Nike] ${target.label}: ${products.length} items`);

      for (const p of products) {
        if (!p.name || !p.url) continue;

        const current  = parsePrice(p.currentStr);
        const original = parsePrice(p.originalStr);
        if (!current) continue;

        let discountPct = 0;
        let normalPrice = original;

        if (original && original > current) {
          discountPct = ((original - current) / original) * 100;
        } else if (p.discountStr) {
          const m = p.discountStr.match(/(\d+)%/);
          if (m) discountPct = parseInt(m[1]);
        }

        if (discountPct >= minDiscountPct) {
          const fullName = p.subname ? `${p.name} â ${p.subname}` : p.name;
          console.log(`[Nike] ð¥ ${fullName} â $${current} (${Math.round(discountPct)}% off)`);
          deals.push({
            productId:   `nike_${Buffer.from(p.url).toString('base64').slice(0, 20)}`,
            retailer:    'Nike',
            name:        fullName,
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
      console.error(`[Nike] Error on ${target.label}:`, err.message);
    } finally {
      if (page) await page.context().close().catch(() => {});
    }

    await sleep(5000); // Nike is picky about request timing
  }

  console.log(`[Nike] Done. ${deals.length} glitch deal(s) found.`);
  return deals;
}

module.exports = { scrape };
