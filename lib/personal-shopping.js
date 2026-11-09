const fs = require('fs');
const path = require('path');

const APPAREL = /\b(shirts?|t[ -]?shirts?|tees?|hoodies?|sweatshirts?|sweaters?|cardigans?|jackets?|coats?|parkas?|pants?|trousers?|jeans|shorts?|joggers?|chinos?|polos?|dresses?|skirts?|blouses?|leggings?|suits?|blazers?|clothing|apparel|underwear|socks?)\b/i;
const SHOES = /\b(shoes?|sneakers?|trainers?|boots?|sandals?|slides?|loafers?|heels?|dunks?|air max|air force|pegasus|vomero|cortez|air jordan)\b/i;
const DESIGNERS = /\b(gucci|prada|balenciaga|burberry|versace|saint laurent|ysl|givenchy|moncler|stone island|off[ -]?white|amiri|alexander mcqueen|valentino|fendi|balmain|dolce\s*(?:&|and)\s*gabbana|bottega veneta|maison margiela|loewe|tom ford|brunello cucinelli|rick owens|kenzo|moschino|ferragamo)\b/i;
const ACCESSORY = /\b(controller|dualsense|headset|earbuds?|charger|charging|stand|mount|bracket|skin|decal|case|cover|replacement|repair|disc drive|disk drive|cables?|remote|subscription|gift card|screen protector)\b/i;
const UNSUITABLE = /\b(replica|counterfeit|for parts|parts only|not working|broken|empty box|box only|wanted|looking to buy|down payment|per month|monthly payment)\b/i;

function loadShoppingConfig(env = process.env) {
  const filename = env.SHOPPING_LIST_FILE || path.join(__dirname, '..', 'shopping-list.json');
  const config = JSON.parse(fs.readFileSync(filename, 'utf8'));
  config.mode = env.SHOPPING_MODE || config.mode || 'all';
  if (!['personal', 'all'].includes(config.mode)) throw new Error('SHOPPING_MODE must be personal or all');
  config.ranking = config.ranking || 'quality';
  if (!['quality', 'lowest-price'].includes(config.ranking)) throw new Error('Invalid shopping ranking');
  config.maxAlertsPerRule = config.maxAlertsPerRule ?? 3;
  if (!Number.isInteger(config.maxAlertsPerRule) || config.maxAlertsPerRule < 1) throw new Error('Invalid maxAlertsPerRule');
  if (!Array.isArray(config.rules)) throw new Error('Shopping list must contain rules');
  for (const rule of config.rules) {
    if (!rule.id || !rule.label || !['ps5-pro', 'nike-shoes', 'designer', 'tv', 'clothes'].includes(rule.kind)) {
      throw new Error('Invalid shopping rule: ' + (rule.id || 'missing id'));
    }
    if (!Number.isFinite(rule.minDiscountPct) || rule.minDiscountPct < 0 || rule.minDiscountPct >= 100) {
      throw new Error('Invalid minimum discount for ' + rule.id);
    }
    if (rule.maxPrice != null && (!Number.isFinite(rule.maxPrice) || rule.maxPrice <= 0)) {
      throw new Error('Invalid maximum price for ' + rule.id);
    }
  }
  return config;
}

function matchesKind(deal, rule) {
  const name = String(deal.name || '');
  const merchant = String(deal.merchant || deal.retailer || '');
  switch (rule.kind) {
    case 'ps5-pro':
      return /\b(?:ps\s*5|playstation\s*5)\s*pro\b/i.test(name)
        && !ACCESSORY.test(name) && !/\b(for|compatible with)\s+(?:sony\s+)?(?:ps5|playstation\s*5)\b/i.test(name)
        && !/\b(?:digital download|game code|game only|enhanced|upgrade kit)\b/i.test(name)
        && (/^\s*(?:(?:new|used|refurbished|open[ -]box|sony|certified|geek squad)\s*[-: ]*|\([^)]*\)\s*)*(?:ps\s*5|playstation\s*5)\s*pro\b/i.test(name)
          || /\b(?:ps\s*5|playstation\s*5)\s*pro\s+(?:\d+\s*tb\s+)?(?:console|bundle)\b/i.test(name));
    case 'nike-shoes':
      return /\b(nike|jordan)\b/i.test(name) && SHOES.test(name) && !/\b(shoe cleaner|laces?|insoles?|keychain|poster)\b/i.test(name);
    case 'designer':
      return (DESIGNERS.test(name) || /\b(farfetch|ssense)\b/i.test(merchant)) && (APPAREL.test(name) || SHOES.test(name));
    case 'tv':
      return /\b(tv|television)\b/i.test(name) && !ACCESSORY.test(name)
        && !/\b(tv stand|tv console|fire tv stick|streaming stick|streaming player|apple tv|tv box|roku express|projectors?|sound\s*bars?|subwoofers?|speakers?|antennas?|receivers?|tuners?|splitters?|dongles?)\b/i.test(name);
    case 'clothes':
      return APPAREL.test(name);
    default:
      return false;
  }
}

function screenSize(name) {
  const match = String(name).match(/\b(\d{2,3}(?:\.\d+)?)\s*(?:["\u201d]|[ -]?(?:inch|in\b))/i);
  return match ? Number(match[1]) : null;
}

function matchPersonalDeal(deal, config) {
  if (config.mode !== 'personal') return [];
  if (deal.expired || deal.soldOut || deal.available === false || UNSUITABLE.test(String(deal.name || ''))) return [];
  // OfferUp's old flip values are estimates, not observed regular prices.
  if (deal.priceBasis === 'estimated_resale' || deal.retailer === 'OfferUp') return [];
  return config.rules.filter((rule) => {
    if (rule.enabled === false || !matchesKind(deal, rule)) return false;
    if (rule.sizes?.length) {
      if (!Array.isArray(deal.availableSizes)) return false;
      if (!rule.sizes.some((size) => deal.availableSizes.some((available) => String(size).toLowerCase() === String(available).toLowerCase()))) return false;
    }
    const inches = screenSize(deal.name);
    if (rule.minScreenInches != null && (inches == null || inches < rule.minScreenInches)) return false;
    if (rule.maxScreenInches != null && (inches == null || inches > rule.maxScreenInches)) return false;
    return true;
  }).sort((a, b) => (b.priority || 0) - (a.priority || 0));
}

function evaluatePersonalDeal(deal, matches) {
  const price = Number(deal.price);
  const discount = Number(deal.discountPct);
  if (!Number.isFinite(price) || price <= 0) return null;
  const rule = matches.find((entry) => entry.maxPrice != null
    ? price <= entry.maxPrice
    : entry.minDiscountPct === 0 || (Number.isFinite(discount) && discount >= entry.minDiscountPct));
  if (!rule) return null;
  const reason = rule.maxPrice != null
    ? `At or below your $${rule.maxPrice.toFixed(2)} target`
    : rule.minDiscountPct === 0 ? 'Matched your shopping list; ranked by lowest listed price'
      : `${Math.round(discount)}% off; your minimum is ${rule.minDiscountPct}%`;
  return {
    ruleId: rule.id,
    label: rule.label,
    priority: rule.priority || 0,
    reason,
    possiblePricingMistake: discount >= 70,
  };
}

function selectPersonalDeals(candidates, config) {
  const sorted = [...candidates].sort((a, b) => {
    const priority = (b.personalMatch?.priority || 0) - (a.personalMatch?.priority || 0);
    if (priority) return priority;
    if (config.ranking === 'lowest-price') {
      const price = Number(a.price) - Number(b.price);
      if (price) return price;
    }
    return (b.qualityScore || 0) - (a.qualityScore || 0);
  });
  const counts = new Map();
  const seen = new Set();
  return sorted.filter((deal) => {
    const ruleId = deal.personalMatch?.ruleId;
    const key = `${deal.retailer}:${deal.productId}`;
    if (!ruleId || seen.has(key) || !(Number(deal.price) > 0) || !Number.isFinite(Number(deal.price))) return false;
    if ((counts.get(ruleId) || 0) >= config.maxAlertsPerRule) return false;
    seen.add(key);
    counts.set(ruleId, (counts.get(ruleId) || 0) + 1);
    return true;
  }).map((deal) => ({
    ...deal,
    personalMatch: {
      ...deal.personalMatch,
      reason: config.ranking === 'lowest-price'
        ? `Among the ${config.maxAlertsPerRule} lowest listed prices found for ${deal.personalMatch.label} in this scan`
        : deal.personalMatch.reason,
    },
  }));
}

module.exports = { loadShoppingConfig, matchPersonalDeal, evaluatePersonalDeal, selectPersonalDeals };
