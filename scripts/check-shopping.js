const { loadShoppingConfig, matchPersonalDeal, evaluatePersonalDeal } = require('../lib/personal-shopping');
const { parseSlickdealsHtml } = require('../lib/slickdeals-data');

// Read-only diagnostic: no database writes, browser, or Discord messages.
async function main() {
  const config = loadShoppingConfig();
  for (const rule of config.rules.filter((entry) => entry.enabled !== false && entry.searchQuery)) {
    try {
      const url = 'https://slickdeals.net/search?' + new URLSearchParams({ q: rule.searchQuery, sort: 'recent' });
      const response = await fetch(url, {
        signal: AbortSignal.timeout(15000),
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' },
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const items = parseSlickdealsHtml(await response.text(), { maxAgeDays: config.maxDealAgeDays });
      if (items === null) throw new Error('Structured search data unavailable');
      const matched = items.map((item) => ({ item, matches: matchPersonalDeal(item, { ...config, mode: 'personal' }) }))
        .filter(({ matches }) => matches.some((entry) => entry.id === rule.id));
      const qualified = matched.filter(({ item, matches }) => evaluatePersonalDeal(item, matches));
      console.log(JSON.stringify({
        interest: rule.label, recentResults: items.length, matching: matched.length,
        qualifying: qualified.length,
        sample: qualified.slice(0, 2).map(({ item }) => ({ name: item.name, price: item.price, url: item.url })),
      }));
    } catch (error) {
      console.error(JSON.stringify({ interest: rule.label, error: error.message }));
      process.exitCode = 1;
    }
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
