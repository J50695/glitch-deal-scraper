// ============================================================
//  scrapers/farfetch.js — Farfetch Designer Price Glitch Detector
//
//  Farfetch is the world's largest luxury fashion platform.
//  Their sale section regularly hits 70-80% off on designer
//  items — and occasionally sees pricing errors well beyond that.
//
//  Monitors: Farfetch Sale, Outlet, and designer clearance pages
// ============================================================

const { newPage, goto, parsePrice, sleep } = require('./playwright-base');

const FARFETCH_TARGETS = [
  {
    url:   'https://www.farfetch.com/shopping/men/sale-2/items.aspx?view=180&sort=2',
    label: 'Farfetch — Men\'s Sale (Most Discounted)',
  },
  {
    url:   'https://www.farfetch.com/shopping/women/sale-2/items.aspx?view=180&sort=2',
    label: 'Farfetch — Women\'s Sale (Most Discounted)',
  },
  {
    url:   'https://www.farfetch.com/shopping/men/sneakers-1/items.aspx?view=180&sort=2&priceTo=200',
    label: 'Farfetch — Men\'s Sneakers Sale',
  },
  {
    url:   'https://www.farfetch.com/shopping/women/sneakers-1/items.aspx?view=180&sort=2&priceTo=200',
    label: 'Farfetch — Women\'s Sneakers Sale',
  },
  {
    url:   'https://www.farfetch.com/shopping/men/clothing-1/items.aspx?view=180&sort=2&priceTo=100',
    label: 'Farfetch — Men\'s Clothing Deep Sale',
  },
];

async function scrape(minDiscountPct = 70) {
  console.log('[Farfetch] Starting designer sale scrape...');
  const deals = [];

  for (const target of FARFETCH_TARGETS) {
    let page;
    try {
      page = await newPage();
      await goto(page, target.url);

      // Farfetch loads dynamically — wait for product grid
      await page.waitForSelector('[data-component="ProductCard"], [data-testid="product-card"]', {
        timeout: 25000,
      }).catch(() => {});
      await sleep(3000);

      // Accept cookie banner if it appears
      await page.evaluate(() => {
        const btn = document.querySelector('[data-testid="accept-cookies"], [data-component="CookiesAcceptButton"], #onetrust-accept-btn-handler');
        if (btn) btn.click();
      }).catch(() => {});
      await sleep(1000);

      // Scroll to load more products
      for (let i = 0; i < 4; i++) {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
        await sleep(1500);
      }

      const products = await page.$$eval(
        '[data-component="ProductCard"], [data-testid="product-card"], [class*="ProductCard"], li[data-testid]',
        (cards) => cards.slice(0, 60).map(card => {
          const brandEl  = card.querySelector('[data-component="ProductCardBrandName"], [data-testid="brand-name"], [class*="BrandName"]');
          const nameEl   = card.querySelector('[data-component="ProductCardDescription"], [data-testid="product-description"], [class*="Description"]');
          const brand    = brandEl?.textContent?.trim() || '';
          const name     = nameEl?.textContent?.trim() || '';
          const fullName = brand ? `${brand} — ${name}` : name;

          const linkEl = card.querySelector('a[href*="/shopping/"], a[href*="/product/"]');
          const href   = linkEl?.href;

          const salePriceEl  = card.querySelector('[data-component="Price"] [data-component="DiscountedPrice"], [data-testid="price-current"], [class*="DiscountedPrice"], [class*="SalePrice"]');
          const salePriceStr = salePriceEl?.textContent?.trim();

          const allPriceEls  = card.querySelectorAll('[data-component="Price"] span, [class*="Price"] span');
          const priceTexts   = Array.from(allPriceEls).map(el => el.textContent.trim()).filter(t => t.includes('$') || t.includes('\u00a3') || t.includes('\u20ac'));

          const origPriceEl  = card.querySelector('[data-component="Price"] [data-component="OriginalPrice"], [data-testid="price-original"], del, s, [class*="OriginalPrice"], [class*="WasPrice"]');
          const origPriceStr = origPriceEl?.textContent?.trim();

          const discountEl  = card.querySelector('[data-component="DiscountPercentage"], [data-testid="discount"], [class*="Discount"], [class*="discount-badge"]');
          const discountStr = discountEl?.textContent?.trim();

          const imgEl  = card.querySelector('img[src*="farfetch"], img[src*="cdn-images"], picture img');
          const imgSrc = imgEl?.src || imgEl?.dataset?.src;

          return { name: fullName, href, salePriceStr: salePriceStr || priceTexts[0] || null, origPriceStr: origPriceStr || priceTexts[1] || null, discountStr, imgSrc };
        })
      );

      console.log(`[Farfetch] ${target.label}: found ${products.length} items`);

      for (const p of products) {
        if (!p.name || !p.href) continue;

        const url      = p.href.startsWith('http') ? p.href : `https://www.farfetch.com${p.href}`;
        const price    = parsePrice(p.salePriceStr);
        const wasPrice = parsePrice(p.origPriceStr);
        if (!price || price <= 0) continue;

        let discountPct = 0;
        let normalPrice = wasPrice;

        if (wasPrice && wasPrice > price) {
          discountPct = ((wasPrice - price) / wasPrice) * 100;
        } else if (p.discountStr) {
          const match = p.discountStr.match(/(\d+)/);
          if (match) discountPct = parseInt(match[1], 10);
          if (discountPct > 0 && price > 0) {
            normalPrice = price / (1 - discountPct / 100);
          }
        }

        if (discountPct >= minDiscountPct) {
          console.log(`[Farfetch] Glitch: ${p.name} - $${price} (${Math.round(discountPct)}% off)`);
          deals.push({
            productId:   `farfetch_${Buffer.from(url).toString('base64').slice(0, 20)}`,
            retailer:    'Farfetch',
            name:        p.name,
            url,
            imageUrl:    p.imgSrc || null,
            price,
            normalPrice: normalPrice || null,
            discountPct,
            source:      target.label,
          });
        }
      }

    } catch (err) {
      console.error(`[Farfetch] Error on ${target.label}:`, err.message);
    } finally {
      if (page) await page.context().close().catch(() => {});
    }

    await sleep(4000);
  }

  console.log(`[Farfetch] Done. ${deals.length} glitch deal(s) found.`);
  return deals;
}

module.exports = { scrape };
