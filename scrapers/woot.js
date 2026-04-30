// ============================================================
//  scrapers/woot.js — Woot Price Glitch Detector
//
//  Woot is Amazon's official daily-deal/clearance site.
//  Electronics, computers, and refurbs routinely hit 50-90% off.
//  Their deals page and category endpoints expose structured JSON.
// ============================================================

const { newPage, goto, parsePrice, sleep } = require('./playwright-base');
const { buildProductId } = require('../lib/product-id');

const WOOT_CATEGORIES = [
  { url: 'https://www.woot.com/category/electronics', name: 'Woot Electronics', categoryKey: 'tech', structuredOnly: true, enabled: true },
  { url: 'https://www.woot.com/category/computers', name: 'Woot Computers', categoryKey: 'pc', structuredOnly: true, enabled: true },
  { url: 'https://www.woot.com/category/home', name: 'Woot Home', categoryKey: 'home', structuredOnly: true, enabled: true },
  { url: 'https://www.woot.com/category/tools-garden', name: 'Woot Tools', enabled: false, skipReason: 'No stable structured searchOffers response' },
  { url: 'https://www.woot.com/category/sports', name: 'Woot Sports', enabled: false, skipReason: 'No stable structured searchOffers response' },
  { url: 'https://www.woot.com/category/kids', name: 'Woot Toys', enabled: false, skipReason: 'Mixed-category results produced noisy false positives' },
];

function extractOfferHit(decodedUrl, json) {
  const offers = json?.data?.searchOffers?.Offers;
  if (!Array.isArray(offers)) return null;
  const categoryKeyMatch = decodedUrl.match(/Categories:\s*\[\s*"([^"]+)"\s*\]/);
  const sortMatch = decodedUrl.match(/Sort:\s*([A-Za-z]+)/);
  return {
    categoryKey: categoryKeyMatch ? categoryKeyMatch[1] : null,
    sort: sortMatch ? sortMatch[1] : null,
    offers,
  };
}

function scoreOfferHit(target, hit) {
  let score = hit.offers.length;
  if (target.categoryKey && hit.categoryKey === target.categoryKey) score += 100;
  if (hit.sort === 'BestSelling') score += 30;
  if (hit.sort === 'NewestFirst') score += 20;

  for (const offer of hit.offers.slice(0, 5)) {
    const item = Array.isArray(offer?.Items) ? offer.Items[0] : null;
    if (offer?.Title) score += 4;
    if (offer?.Slug) score += 3;
    if (item?.SalePrice != null) score += 3;
    if (item?.ListPrice != null) score += 3;
  }

  return score;
}

function pickBestStructuredOffers(target, hits) {
  const candidates = hits
    .filter((hit) => Array.isArray(hit.offers) && hit.offers.length > 0)
    .filter((hit) => !target.categoryKey || !hit.categoryKey || hit.categoryKey === target.categoryKey)
    .sort((a, b) => scoreOfferHit(target, b) - scoreOfferHit(target, a));

  return candidates[0]?.offers || [];
}

async function fetchCategoryOffers(target) {
  let page;
  try {
    page = await newPage();
    const responseHits = [];

    page.on('response', async (res) => {
      const url = res.url();
      if (res.status() !== 200 || !url.includes('/graphql?query=') || !url.includes('searchOffers')) return;
      try {
        const decodedUrl = decodeURIComponent(url);
        const json = await res.json();
        const hit = extractOfferHit(decodedUrl, json);
        if (hit) responseHits.push(hit);
      } catch {
        // Ignore individual response parsing failures.
      }
    });

    await goto(page, target.url, { timeout: 15000 });
    await sleep(4500);

    const structuredOffers = pickBestStructuredOffers(target, responseHits);
    if (structuredOffers.length > 0) {
      return structuredOffers;
    }

    if (target.structuredOnly) {
      return [];
    }

    return await page.$$eval('a[href*="/offers/"]', (links) => {
      const seen = new Set();
      return links.map((link) => {
        const href = link.href || '';
        if (!href || seen.has(href)) return null;
        seen.add(href);
        const card = link.closest('[data-test-ui], li, section, div');
        const text = (card?.textContent || link.textContent || '').replace(/\s+/g, ' ').trim();
        const prices = text.match(/\$[\d,.]+/g) || [];
        const listPriceMatch = text.match(/Save:\s*\$[\d,.]+\s*\((\d+)%\)/i);
        const image = card?.querySelector('img')?.src || null;
        const title = link.getAttribute('title') || text.split('$')[0]?.trim() || '';
        if (!title || title.length < 3) return null;
        return {
          Title: title,
          Slug: href.split('/offers/')[1]?.split('?')[0] || '',
          Photos: image ? [{ Url: image }] : [],
          Items: [{
            SalePrice: prices[0] || null,
            ListPrice: prices[1] || null,
            Attributes: listPriceMatch ? [{ Key: 'percentOff', Value: listPriceMatch[1] }] : [],
          }],
        };
      }).filter(Boolean);
    });
  } finally {
    if (page) await page.context().close().catch(() => {});
  }
}

async function scrape(minDiscountPct, options = {}) {
  if (minDiscountPct === undefined) minDiscountPct = 70;
  const isAborted = typeof options.isAborted === 'function' ? options.isAborted : () => false;
  console.log('[Woot] Starting scrape...');
  var deals = [];
  var seenIds = new Set();

  for (var i = 0; i < WOOT_CATEGORIES.length; i++) {
    if (isAborted()) {
      console.warn('[Woot] Aborted before starting ' + WOOT_CATEGORIES[i].name);
      break;
    }

    var cat = WOOT_CATEGORIES[i];
    if (cat.enabled === false) {
      console.log('[Woot] Skipping ' + cat.name + ': ' + cat.skipReason);
      continue;
    }
    try {
      var offers = await fetchCategoryOffers(cat);
      console.log('[Woot] ' + cat.name + ': ' + offers.length + ' offers');

      for (var j = 0; j < offers.length; j++) {
        if (isAborted()) {
          console.warn('[Woot] Aborted during ' + cat.name);
          break;
        }
        var offer = offers[j];
        if (!offer || offer.SoldOut) continue;

        var item = Array.isArray(offer.Items) ? offer.Items[0] : (offer.items && offer.items[0]) || {};
        var name = offer.Title || offer.title || offer.name || '';
        var slug = offer.Slug || offer.slug || offer.urlKey || '';
        var url = offer.url || offer.fullUrl || (slug ? ('https://www.woot.com/offers/' + slug) : cat.url);
        var price = parsePrice(String(item.SalePrice || offer.minPrice || offer.salePrice || offer.price || ''));
        var listPrice = parsePrice(String(item.ListPrice || offer.maxListPrice || offer.listPrice || offer.regularPrice || ''));
        var imgUrl = offer.image || offer.Image || (offer.Photos && offer.Photos[0] && offer.Photos[0].Url) || (offer.photos && offer.photos[0]) || null;

        if (!name || name.length < 3 || !url || !price || price <= 0) continue;

        var discountPct = 0;
        if (listPrice && listPrice > price) {
          discountPct = ((listPrice - price) / listPrice) * 100;
        } else if (offer.percentOff) {
          discountPct = parseFloat(offer.percentOff);
        } else if (Array.isArray(item.Attributes)) {
          var percentAttr = item.Attributes.find(function(attr) { return String(attr.Key).toLowerCase().includes('percent'); });
          if (percentAttr) discountPct = parseFloat(percentAttr.Value || 0);
        }

        if (discountPct >= minDiscountPct) {
          console.log('[Woot] DEAL: ' + name + ' — $' + price + ' (' + Math.round(discountPct) + '% off)');
          var productId = buildProductId('woot', url);
          if (seenIds.has(productId)) continue;
          seenIds.add(productId);
          deals.push({
            productId:   productId,
            retailer:    'Woot',
            name:        name,
            url:         url,
            imageUrl:    imgUrl,
            price:       price,
            normalPrice: listPrice || null,
            discountPct: discountPct,
            source:      cat.name,
          });
        }
      }
    } catch (err) {
      console.error('[Woot] Error on ' + cat.name + ': ' + err.message);
    }
    if (isAborted()) break;
    await sleep(2000);
  }

  console.log('[Woot] Done. ' + deals.length + ' glitch deal(s) found.');
  return deals;
}

module.exports = { scrape };
