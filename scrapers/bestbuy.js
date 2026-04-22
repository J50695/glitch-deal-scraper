// ============================================================
//  scrapers/bestbuy.js â Best Buy Price Glitch Detector
//
//  Scrapes Best Buy's Deals & Outlet pages.
//  Compares current price to the "Save $X" or crossed-out
//  original price shown on the page.
// ============================================================

const { newPage, goto, parsePrice, sleep } = require('./playwright-base');

// Best Buy pages worth monitoring for glitches
const BESTBUY_TARGETS = [
  {
    url:   'https://www.bestbuy.com/site/misc/all-deals/pcmcat211400050001.c',
    label: 'Best Buy â All Deals',
  },
  {
    url:   'https://www.bestbuy.com/site/computers-pcs/pcmcat247400050000.c?id=pcmcat247400050000&intl=nosplash',
    label: 'Best Buy â Computers',
  },
  {
    url:   'https://www.bestbuy.com/site/electronics/open-box/pcmcat225600050002.c',
    label: 'Best Buy â Open Box',
  },
  {
    url:   'https://www.bestbuy.com/site/electronics/tvs/abcat0101000.c',
    label: 'Best Buy â TVs',
  },
];

async function scrape(minDiscountPct = 70) {
  console.log('[Best Buy] Starting scrape...');
  const deals = [];

  for (const target of BESTBUY_TARGETS) {
    let page;
    try {
      page = await newPage();
      await goto(page, target.url);

      // Wait for product grid to load
      await page.waitForSelector('.sku-item, [data-testid="grid-cell"]', { timeout: 15000 }).catch(() => {});
      await sleep(2000);

      // Extract product cards
      const products = await page.$$eval(
        '.sku-item, [data-testid="grid-cell"]',
        (cards) => cards.map(card => {
          // Product name
          const name = card.querySelector('.sku-header a, [data-testid="product-title"]')?.textContent?.trim();
          const url  = card.querySelector('.sku-header a, [data-testid="product-title"]')?.href;

          // Current price (what it costs now)
          const priceEl  = card.querySelector('.priceView-customer-price span:first-child, [data-testid="customer-price"] span');
          const priceStr = priceEl?.textContent?.trim();

          // Original / was price (crossed out)
          const wasEl  = card.querySelector('.pricing-price__regular-price, .priceView-was-price, del');
          const wasStr = wasEl?.textContent?.trim();

          // Savings amount shown explicitly
          const saveEl  = card.querySelector('.priceView-savings, .pricing-price__savings');
          const saveStr = saveEl?.textContent?.trim();

          // Image
          const imgEl  = card.querySelector('.product-image img, [data-testid="product-image"] img');
          const imgSrc = imgEl?.src;

          return { name, url, priceStr, wasStr, saveStr, imgSrc };
        })
      );

      console.log(`[Best Buy] ${target.label}: found ${products.length} items`);

      for (const p of products) {
        if (!p.name || !p.url || !p.priceStr) continue;

        const price    = parsePrice(p.priceStr);
        const wasPrice = parsePrice(p.wasStr);
        if (!price || price <= 0) continue;

        let discountPct = 0;
        let normalPrice = wasPrice;

        if (wasPrice && wasPrice > price) {
          discountPct = ((wasPrice - price) / wasPrice) * 100;
        } else if (p.saveStr) {
          // "Save $150" type display
          const saveAmount = parsePrice(p.saveStr);
          if (saveAmount && saveAmount > 0) {
            const implied = price + saveAmount;
            discountPct   = (saveAmount / implied) * 100;
            normalPrice   = implied;
          }
        }

        if (discountPct >= minDiscountPct) {
          console.log(`[Best Buy] ð¥ ${p.name} â $${price} (${Math.round(discountPct)}% off)`);
          deals.push({
            productId:   `bestbuy_${Buffer.from(p.url).toString('base64').slice(0, 20)}`,
            retailer:    'Best Buy',
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
      console.error(`[Best Buy] Error on ${target.label}:`, err.message);
    } finally {
      if (page) await page.context().close().catch(() => {});
    }

    await sleep(3000); // Be polite between pages
  }

  console.log(`[Best Buy] Done. ${deals.length} glitch deal(s) found.`);
  return deals;
}

module.exports = { scrape };
