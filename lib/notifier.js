// ============================================================
//  lib/notifier.js â Discord + Email Alerts
//  Fires the moment a price glitch is detected.
//  Discord: instant embed per deal
//  Email:   batched digest (1 email per scrape run with new deals)
// ============================================================

require('dotenv').config();
const axios      = require('axios');
const nodemailer = require('nodemailer');

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const EMAIL_USER      = process.env.EMAIL_USER;
const EMAIL_PASS      = process.env.EMAIL_PASS;
const EMAIL_TO        = process.env.EMAIL_TO;

// ââ Helpers âââââââââââââââââââââââââââââââââââââââââââââââââââ

function fmtPrice(n) {
  return n != null ? `$${Number(n).toFixed(2)}` : 'N/A';
}

function discountColor(pct) {
  if (pct >= 90) return 0xFF1111; // bright red â insane deal
  if (pct >= 80) return 0xFF6600; // orange
  if (pct >= 70) return 0xFFAA00; // amber
  return 0x00CCFF;                 // blue â moderate
}

function retailerEmoji(retailer) {
  const map = {
    Amazon:   'ð¦',
    'Best Buy': 'ð',
    Walmart:  'ð¦',
    Nike:     'ð',
    Adidas:   'ð²',
    Target:   'ð¯',
  };
  return map[retailer] || 'ð';
}

// ââ Discord âââââââââââââââââââââââââââââââââââââââââââââââââââ

/**
 * Send a single Discord embed for a glitch deal.
 *
 * deal = {
 *   name, url, retailer, price, normalPrice,
 *   discountPct, imageUrl, source
 * }
 */
async function sendDiscordAlert(deal) {
  if (!DISCORD_WEBHOOK) {
    console.warn('[Notifier] DISCORD_WEBHOOK_URL not set â skipping Discord alert');
    return;
  }

  const emoji   = retailerEmoji(deal.retailer);
  const savings = deal.normalPrice ? (deal.normalPrice - deal.price).toFixed(2) : null;

  const embed = {
    title:      `${emoji} GLITCH DEAL â  ${deal.retailer}`,
    description: `**[${deal.name}](${deal.url})**`,
    url:         deal.url,
    color:       discountColor(deal.discountPct),
    fields: [
      {
        name:   'ð¸ Glitch Price',
        value:  `**${fmtPrice(deal.price)}**`,
        inline: true,
      },
      {
        name:   'ð Normal Price',
        value:  deal.normalPrice ? `'~${fmtPrice(deal.normalPrice)}~~` : 'Building historyâ¦',
        inline: true,
      },
      {
        name:   'ð¥ You Save',
        value:  savings
          ? `**${fmtPrice(savings)} (${Math.round(deal.discountPct)}% off)**`
          : `**${Math.round(deal.discountPct)}% off**`,
        inline: true,
      },
      {
        name:   'ð Buy Now',
        value:  `[Click here before it's gone](${deal.url})`,
        inline: false,
      },
    ],
    footer: {
      text: `Glitch Deal Scraper â¢ ${deal.source || deal.retailer} â¢ ${new Date().toLocaleString()}`,
    },
    timestamp: new Date().toISOString(),
  };

  // Add product image if available
  if (deal.imageUrl) {
    embed.thumbnail = { url: deal.imageUrl };
  }

  try {
    await axios.post(
      DISCORD_WEBHOOK,
      {
        username:   'ð¥ Glitch Deal Bot',
        avatar_url: 'https://i.imgur.com/4M34hi2.png',
        embeds:     [embed],
      },
      { timeout: 10000 }
    );
    console.log(`[Discord] â Alert sent: ${deal.name} â ${fmtPrice(deal.price)} (${Math.round(deal.discountPct)}% off)`);
  } catch (err) {
    console.error('[Discord] Failed to send alert:', err.response?.data || err.message);
  }
}

// ââ Email âââââââââââââââââââââââââââââââââââââââââââââââââââââ

/**
 * Send an email digest for a batch of new glitch deals.
 * Only called once per scrape run to avoid inbox flooding.
 */
async function sendEmailDigest(deals) {
  if (!EMAIL_USER || !EMAIL_PASS || !EMAIL_TO) return;
  if (!deals || deals.length === 0) return;

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_USER, pass: EMAIL_PASS },
  });

  const dealCards = deals.map(d => `
  <div style="border:2px solid #FF3333;border-radius:12px;padding:16px;margin:12px 0;background:#1a1a1a">
    <h3 style="margin:0 0 8px;color:#fff"><a href="${d.url}" style="color:#FF6666;text-decoration:none">${d.name}</a></h3>
    <p>Glitch: <b style="color:#FF3333">${fmtPrice(d.price)}</b> | Normal: <span style="text-decoration:line-through;color:#888">${d.normalPrice ? fmtPrice(d.normalPrice) : 'N/A'}</span> | <b style="color:#FFD700">${Math.round(d.discountPct)}% OFF</b></p>
    <a href="${d.url}" style="display:inline-block;padding:8px 20px;background:#FF3333;color:#fff;border-radius:6px;text-decoration:none;font-weight:bold">BUY NOW â</a>
  </div>
`).join('');

  const html = `<!DOCTYPE html><html><body style="background:#111;color:#fff;font-family:sans-serif;padding:20px;max-width:600px;margin:0 auto"><h1 style="color:#FF3333">ð¤ ${deals.length} Glitch Deal${deals.length > 1 ? 's' : ''} Detected!</h1>${dealCards}</body></html>`;

  try {
    await transporter.sendMail({
      from:  A$nbsp;Glitch Deal Bot ð¥" <${EMAIL_USER}>`,
      to:      EMAIL_TO,
      subject: `ð¤ ${deals.length} GLITCH DEAL${deals.length > 1 ? 'S' : ''} â Act Fast!`,
      html,
    });
    console.log(`[Email] â Digest sent: ${deals.length} deals`);
  } catch (err) {
    console.error('[Email] Failed:', err.message);
  }
}

module.exports = { sendDiscordAlert, sendEmailDigest };
