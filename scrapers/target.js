// ============================================================
//  scrapers/target.js - Target Price Glitch Detector
// ============================================================

const axios = require('axios');
const { newPage, goto, parsePrice, sleep } = require('./playwright-base');
const { buildProductId } = require('../lib/product-id');

const TARGET_TARGETS = [
  { url: 'https://www.target.com/c/electronics/-/N-5xt1a?type=category&sortBy=pricelow', label: 'Target Electronics'     },
  { url: 'https://www.target.com/c/video-games/-/N-5xsxs?sortBy=pricelow',              label: 'Target Video Games'     },
  { url: 'https://www.target.com/c/clearance/-/N-4zc5d',                                label: 'Target Clearance'       },
  { url: 'https://www.target.com/c/laptops/-/N-5xsxm?sortBy=pricelow',                  label: 'Target Laptops'         },
  { url: 'https://www.target.com/c/tvs/-/N-5xsxk?sortBy=pricelow',                     label: 'Target TVs'             },
  { url: 'https://www.target.com/c/shoes/-/N-55r0k?sortBy=pricelow',                    label: 'Target Shoes'           },
];

const TARGET_CARD_SELECTOR = '[data-test="product-details"], [data-test="@web/ProductCard/ProductCardBody"]';
const TARGET_BLOCKED_PATTERNS = [
  /access denied/i,
  /verify you are human/i,
  /please enable cookies/i,
  /security check/i,
  /captcha/i,
  /targetgrocery/i,
  /shop groceries/i,
  /sign in for the best experience/i,
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
  return TARGET_BLOCKED_PATTERNS.some((pattern) => pattern.test(text));
}

async function isWrongCategoryShell(url) {
  try {
    const res = await axios.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0 Safari/537.36',
        'Accept': 'text/html',
      },
      validateStatus: () => true,
    });
    const html = String(res.data || '').replace(/\s+/g, ' ');
    return /<title[^>]*>\s*shop groceries\s*:\s*target\s*<\/title>/i.test(html) ||
      /rel="canonical"[^>]*\/c\/grocery\/-\/N-5xt1a/i.test(html);
  } catch {
    return false;
  }
}

async function scrape(minDiscountPct = 70, options = {}) {
  const isAborted = typeof options.isAborted === 'function' ? options.isAborted : () => false;
  console.log('[Target] Starting scrape...');
  const deals = [];
  let emptyTargets = 0;
  let blockedTargets = 0;

  for (const target of TARGET_TARGETS) {
    if (isAborted()) {
      console.warn('[Target] Aborted before starting ' + target.label);
      break;
    }

    let page;
    try {
      if (await isWrongCategoryShell(target.url)) {
        console.log('[Target] ' + target.label + ': stale Target shell / grocery redirect');
        blockedTargets += 1;
        emptyTargets += 1;
        if (blockedTargets >= 1) {
          console.warn('[Target] Target category route is stale or redirected, stopping early.');
          break;
        }
        continue;
      }

      page = await newPage();
      await goto(page, target.url, { timeout: 15000 });
      await page.waitForSelector(TARGET_CARD_SELECTOR, { timeout: 8000 }).catch(() => {});
      await sleep(1500);

      const snapshot = await readPageSnapshot(page);

      const products = await page.$$eval(
        TARGET_CARD_SELECTOR,
        (cards) => cards.slice(0, 48).map(card => {
          const name  = card.querySelector('[data-test="product-title"], a[data-test="product-title"]')?.textContent?.trim();
          const href  = card.querySelector('a[data-test="product-title"], a[href*="/p/"]')?.href;
          const url   = href && !href.startsWith('http') ? 'https://www.target.com' + href : href;
          const priceEl  = card.querySelector('[data-test="current-price"] span, [class*="Price__currentPrice"]');
          const priceStr = priceEl?.textContent?.trim();
          const wasEl    = card.querySelector('[data-test="regular-price"] span, [class*="Price__regularPrice"] del, s');
          const wasStr   = wasEl?.textContent?.trim();
          const saveEl   = card.querySelector('[data-test="savings"], [class*="Price__savings"]');
          const saveStr  = saveEl?.textContent?.trim();
          const imgEl  = card.querySelector('img[src*="target"], picture img');
          const imgSrc = imgEl?.src;
          return { name, url, priceStr, wasStr, saveStr, imgSrc };
        })
      );

      const blocked = products.length === 0 && looksBlocked(snapshot);
      console.log('[Target] ' + target.label + ': ' + products.length + ' items' + (blocked ? ' (blocked)' : ''));

      if (blocked) {
        blockedTargets += 1;
        emptyTargets += 1;
        if (blockedTargets >= 2) {
          console.warn('[Target] Repeated blocked pages, stopping early.');
          break;
        }
        continue;
      }

      if (products.length === 0) {
        emptyTargets += 1;
        if (emptyTargets >= 3) {
          console.warn('[Target] Repeated empty pages, stopping early.');
          break;
        }
      } else {
        emptyTargets = 0;
      }

      for (const p of products) {
        if (isAborted()) {
          console.warn('[Target] Aborted during ' + target.label);
          break;
        }
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
          if (m) { discountPct = parseInt(m[1]); }
          else {
            const saveAmt = parsePrice(p.saveStr);
            if (saveAmt && saveAmt > 0) { normalPrice = price + saveAmt; discountPct = (saveAmt / normalPrice) * 100; }
          }
        }
        if (discountPct >= minDiscountPct) {
          deals.push({
            productId:   buildProductId('target', p.url),
            retailer:    'Target', name: p.name, url: p.url,
            imageUrl:    p.imgSrc || null, price,
            normalPrice: normalPrice || null, discountPct,
            source:      target.label,
          });
        }
      }
    } catch (err) { console.error('[Target] Error on ' + target.label + ':', err.message); }
    finally { if (page) await page.context().close().catch(() => {}); }
    if (isAborted()) break;
    await sleep(1500);
  }
  console.log('[Target] Done. ' + deals.length + ' glitch deal(s) found.');
  return deals;
}

module.exports = { scrape };
