const crypto = require('crypto');

function buildProductId(prefix, rawValue) {
  const normalizedPrefix = String(prefix || 'item').toLowerCase().replace(/[^a-z0-9]/g, '') || 'item';
  const key = String(rawValue || '').trim();
  const digest = crypto.createHash('sha1').update(key).digest('hex').slice(0, 24);
  return `${normalizedPrefix}_${digest}`;
}

module.exports = { buildProductId };
