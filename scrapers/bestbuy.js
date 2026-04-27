// ============================================================
//  scrapers/bestbuy.js - Best Buy Price Glitch Detector
//
//  Scrapes Best Buy's Deals & Outlet pages.
//  Compares current price to the "Save $X" or crossed-out
//  original price shown on the page.
// ============================================================

const { newPage, goto, parsePrice, sleep } = require('./playwright-base');

// Current Best Buy pages that still expose SKU cards in headless Playwright.
const BESTBUY_TARGETS = [
  {
    url:   'https://www.bestbuy.com/site/all-laptops/pc-laptops/pcmcat247400050000.c?id=pcmcat247400050000',
    label: 'Best Buy - All Laptops',
  },
  {
    url:   'https://www.bestbuy.com/site/outlet-refurbished-clearance/open-box-electronics/pcmcat748300666861.c?id=pcmcat748300666861',
    label: 'Best Buy - Open Box',
  },
  {
    url:   'https://www.bestbuy.com/site/outlet-refurbished-clearance/clearance-electronics/pcmcat748300666044.c?id=pcmcat748300666044',
    label: 'Best Buy - Clearance',
  },
];

async function scrape(minDiscountPct = 70) {
  console.log('[Best Buy] Starting scrape...');
  const deals = [];
  let emptyTargets = 0;

  for (const target of BESTBUY_TARGETS) {
    let page;
    try {
      page = await newPage();
      await goto(page, target.url, { timeout: 15000 });
      await page.waitForSelector('a.sku-title, .sku-header a', { timeout: 7000 }).catch(() => {});
      await sleep(1500);

      const products = await page.$$eval(
        'a.sku-title, .sku-header a',
        (anchors) => {
          const seen = new Set();

          const textList = (root, selector) => Array.from(root.querySelectorAll(selector))
            .map(el => (el.textContent || '').trim())
            .filter(Boolean);

          return anchors.map(anchor => {
            const card = anchor.closest('.product-flexbox, .sku-item');
            if (!card) return null;

            const url = anchor.href;
            if (!url || seen.has(url)) return null;
            seen.add(url);

            const priceTexts = textList(card, '[data-testid="price-block"] span, .priceView-customer-price span, [data-testid="customer-price"] span');
            const wasTexts = textList(card, '.pricing-price__regular-price, .priceView-was-price, del, [data-testid="crossed-price"] span, [data-testid="list-price"] span, [data-testid="comp-price"] span');
            const saveTexts = textList(card, '.priceView-savings, .pricing-price__savings, [data-testid="savings-regular-price"], [data-testid="savings-price"]');
            const imgSrc = card.querySelector('.product-image, .image-section img, img.product-image')?.src || null;

            return {
              name: (anchor.textContent || '').trim(),
              url,
              priceStr: priceTexts.find(text => /\$/.test(text)) || priceTexts[0] || '',
              wasStr: wasTexts.find(text => /\$/.test(text)) || wasTexts[0] || '',
              saveStr: saveTexts.find(text => /(save|off|\$)/i.test(text)) || saveTexts[0] || '',
              imgSrc,
            };
          }).filter(Boolean);
        }
      );

      console.log('[Best Buy] ' + target.label + ': found ' + products.length + ' items');
      if (products.length === 0) {
        emptyTargets++;
        if (emptyTargets >= 2) {
          console.warn('[Best Buy] Repeated empty pages, stopping early.');
          break;
        }
      } else {
        emptyTargets = 0;
      }

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
          const saveAmount = parsePrice(p.saveStr);
          if (saveAmount && saveAmount > 0) {
            const implied = price + saveAmount;
            discountPct   = (saveAmount / implied) * 100;
            normalPrice   = implied;
          }
        }
        if (discountPct >= minDiscountPct) {
          console.log('[Best Buy] Glitch: ' + p.name + ' - $' + price + ' (' + Math.round(discountPct) + '% off)');
          deals.push({
            productId:   'bestbuy_' + Buffer.from(p.url).toString('base64').slice(0, 20),
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
      console.error('[Best Buy] Error on ' + target.label + ':', err.message);
    } finally {
      if (page) await page.context().close().catch(() => {});
    }
    await sleep(1000);
  }
  console.log('[Best Buy] Done. ' + deals.length + ' glitch deal(s) found.');
  return deals;
}

module.exports = { scrape };
