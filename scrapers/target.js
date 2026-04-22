// ============================================================
//  scrapers/target.js â Target Price Glitch Detector
// ============================================================

const { newPage, goto, parsePrice, sleep } = require('./playwright-base');

const TARGET_TARGETS = [
  { url: 'https://www.target.com/c/electronics/-/N-5xt1a?type=category&sortBy=pricelow', label: 'Target Electronics' },
  { url: 'https://www.target.com/c/video-games/-/N-5xsxs?sortBy=pricelow',              label: 'Target Video Games' },
  { url: 'https://www.target.com/c/shoes/-/N-55r0k?sortBy=pricelow',                    label: 'Target Shoes'       },
  { url: 'https://www.target.com/c/clearance/-/N-4zc5d',                                label: 'Target Clearance'   },
];

async function scrape(minDiscountPct = 70) {
  console.log('[Target] Starting scrape...');
  const deals = [];

  for (const target of TARGET_TARGETS) {
    let page;
    try {
      page = await newPage();
      await goto(page, target.url);
      await page.waitForSelector('[data-test="product-details"], [data-test="@web/ProductCard/ProductCardBody"]', { timeout: 20000 }).catch(() => {});
      await sleep(3000);

      const products = await page.$$eval(
        '[data-test="product-details"], [data-test="@web/ProductCard/ProductCardBody"]',
        (cards) => cards.slice(0, 48).map(card => {
          const name  = card.querySelector('[data-test="product-title"], a[data-test="product-title"]')?.textContent?.trim();
          const href  = card.querySelector('a[data-test="product-title"], a[href*="/p/"]')?.href;
          const url   = href && !href.startsWith('http') ? 'https://www.target.com' + href : href;

          // Current price
          const priceEl  = card.querySelector('[data-test="current-price"] span, [class*="Price__currentPrice"]');
          const priceStr = priceEl?.textContent?.trim();

          // Regular/was price
          const wasEl    = card.querySelector('[data-test="regular-price"] span, [class*="Price__regularPrice"] del, s');
          const wasStr   = wasEl?.textContent?.trim();

          // Savings shown
          const saveEl   = card.querySelector('[data-test="savings"], [class*="Price__savings"]');
          const saveStr  = saveEl?.textContent?.trim();

          const imgEl  = card.querySelector('img[src*="target"], picture img');
          const imgSrc = imgEl?.src;

          return { name, url, priceStr, wasStr, saveStr, imgSrc };
        })
      );

      console.log(`[Target] ${target.label}: ${products.length} items`);

      for (const p of products) {
        if (!p.name || !p.url || !p.priceStr) continue;

        const price    = parsePrice(p.priceStr);
        const wasPrice = parsePrice(p.wasStr);
        if (!price) continue;

        let discountPct = 0;
        let normalPrice = wasPrice;

        if (wasPrice && wasPrice > price) {
          discountPct = ((wasPrice - price) / wasPrice) * 100;
        } else if (p.saveStr) {
          const m = p.saveStr.match(/(\d+)%/);
          if (m) {
            discountPct = parseInt(m[1]);
          } else {
            const saveAmt = parsePrice(p.saveStr);
            if (saveAmt && saveAmt > 0) {
              normalPrice = price + saveAmt;
              discountPct = (saveAmt / normalPrice) * 100;
            }
          }
        }

        if (discountPct >= minDiscountPct) {
          console.log(`[Target] ð¥ ${p.name} â $${price} (${Math.round(discountPct)}% off)`);
          deals.push({
            productId:   `target_${Buffer.from(p.url).toString('base64').slice(0, 20)}`,
            retailer:    'Target',
            name:        p.name,
            url:         p.url,
            imageUrl:    p.imgSrc || null,
            price,
            normalPrice: normalPrice || null,
            discountPct,
            source:      target.label,
          });
        }
      }

    } catch (err) {
      console.error(`[Target] Error on ${target.label}:`, err.message);
    } finally {
      if (page) await page.context().close().catch(() => {});
    }

    await sleep(4000);
  }

  console.log(`[Target] Done. ${deals.length} glitch deal(s) found.`);
  return deals;
}

module.exports = { scrape };
