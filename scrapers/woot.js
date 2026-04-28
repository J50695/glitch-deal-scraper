// ============================================================
//  scrapers/woot.js — Woot Price Glitch Detector
//
//  Woot is Amazon's official daily-deal/clearance site.
//  Electronics, computers, and refurbs routinely hit 50-90% off.
//  Their deals page and category endpoints expose structured JSON.
// ============================================================

const axios = require('axios');
const { parsePrice, sleep } = require('./playwright-base');

const WOOT_CATEGORIES = [
  { slug: 'electronics',  name: 'Woot Electronics'  },
  { slug: 'computers',    name: 'Woot Computers'     },
  { slug: 'tools-garden', name: 'Woot Tools'         },
  { slug: 'sports',       name: 'Woot Sports'        },
  { slug: 'home',         name: 'Woot Home'          },
  { slug: 'kids',         name: 'Woot Toys'          },
];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0 Safari/537.36',
  'Accept': 'application/json',
};

async function fetchCategory(slug) {
  try {
    const url = 'https://www.woot.com/plus/api/offers/list?site=' + slug + '&perpage=50&page=1';
    const res = await axios.get(url, { headers: HEADERS, timeout: 15000 });
    return res.data && res.data.offers ? res.data.offers : [];
  } catch (err) {
    try {
      // fallback: hits section
      const url2 = 'https://www.woot.com/' + slug + '/deals';
      const res2 = await axios.get(url2, { headers: { ...HEADERS, Accept: 'text/html' }, timeout: 15000 });
      // parse __NEXT_DATA__
      const m = res2.data.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (!m) return [];
      const json = JSON.parse(m[1]);
      const offers = json && json.props && json.props.pageProps && json.props.pageProps.offers;
      return Array.isArray(offers) ? offers : [];
    } catch (e) {
      return [];
    }
  }
}

async function scrape(minDiscountPct) {
  if (minDiscountPct === undefined) minDiscountPct = 70;
  console.log('[Woot] Starting scrape...');
  var deals = [];

  for (var i = 0; i < WOOT_CATEGORIES.length; i++) {
    var cat = WOOT_CATEGORIES[i];
    try {
      var offers = await fetchCategory(cat.slug);
      console.log('[Woot] ' + cat.name + ': ' + offers.length + ' offers');

      for (var j = 0; j < offers.length; j++) {
        var offer = offers[j];
        if (!offer) continue;

        var name = offer.title || offer.name || '';
        var url = offer.url || offer.fullUrl || ('https://www.woot.com/' + cat.slug + '/offers/' + (offer.urlKey || ''));
        var price = parseFloat(offer.minPrice || offer.salePrice || offer.price || 0);
        var listPrice = parseFloat(offer.maxListPrice || offer.listPrice || offer.regularPrice || 0);
        var imgUrl = offer.image || (offer.photos && offer.photos[0]) || null;

        if (!price || price <= 0) continue;

        var discountPct = 0;
        if (listPrice && listPrice > price) {
          discountPct = ((listPrice - price) / listPrice) * 100;
        } else if (offer.percentOff) {
          discountPct = parseFloat(offer.percentOff);
        }

        if (discountPct >= minDiscountPct) {
          console.log('[Woot] DEAL: ' + name + ' — $' + price + ' (' + Math.round(discountPct) + '% off)');
          deals.push({
            productId:   'woot_' + Buffer.from(url).toString('base64').slice(0, 20),
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
    await sleep(2000);
  }

  console.log('[Woot] Done. ' + deals.length + ' glitch deal(s) found.');
  return deals;
}

module.exports = { scrape };
