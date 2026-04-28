// ============================================================
//  lib/notifier.js  - Discord + Email Alerts
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
const EMAIL_TO        = process.env.EMAIL_TO || EMAIL_USER;

// --- Helpers ---

function fmtPrice(n) {
  return n != null ? `$${Number(n).toFixed(2)}` : 'N/A';
}

function discountColor(pct) {
  if (pct >= 90) return 0xFF1111;
  if (pct >= 80) return 0xFF6600;
  return 0xFF3333;
}

// --- Discord ---

async function sendDiscordAlert(deal) {
  if (!DISCORD_WEBHOOK) {
    console.warn('[Discord] No webhook URL set - skipping alert');
    return;
  }
  const pct   = deal.discountPct || 0;
  const color = discountColor(pct);
  const embed = {
    title:       `${pct}% OFF - ${deal.name}`,
    url:         deal.url || '',
    color:       color,
    description: `**${deal.retailer || deal.storeName}** price glitch detected!`,
    fields: [
      { name: 'Glitch Price', value: fmtPrice(deal.price),         inline: true },
      { name: 'Normal Price', value: fmtPrice(deal.normalPrice || deal.originalPrice), inline: true },
      { name: 'Discount',     value: `${pct}% off`,                inline: true },
    ],
    footer:    { text: `Glitch Deal Scraper | ${new Date().toLocaleString()}` },
    thumbnail: deal.imageUrl ? { url: deal.imageUrl } : undefined,
  };
  try {
    await axios.post(DISCORD_WEBHOOK, { username: 'Glitch Deal Bot', embeds: [embed] });
    console.log(`[Discord] Alert sent: ${deal.name} (${pct}% off)`);
  } catch (err) {
    console.error('[Discord] Failed:', err.response?.data || err.message);
  }
}

async function sendSystemAlert({
  title,
  message,
  fields = [],
  color = 0xFFAA00,
}) {
  if (!DISCORD_WEBHOOK) {
    console.warn('[Discord] No webhook URL set - skipping system alert');
    return;
  }

  const embed = {
    title,
    color,
    description: message,
    fields,
    footer: { text: `Glitch Deal Scraper | ${new Date().toLocaleString()}` },
  };

  try {
    await axios.post(DISCORD_WEBHOOK, { username: 'Glitch Deal Bot', embeds: [embed] });
    console.log(`[Discord] System alert sent: ${title}`);
  } catch (err) {
    console.error('[Discord] System alert failed:', err.response?.data || err.message);
  }
}

// --- Email ---

async function sendEmailDigest(deals) {
  if (!EMAIL_USER || !EMAIL_PASS) {
    console.warn('[Email] Credentials not set - skipping digest');
    return;
  }
  if (!deals || deals.length === 0) return;
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_USER, pass: EMAIL_PASS },
  });
  const dealCards = deals.map(d => `
    <div style="border:2px solid #FF3333;border-radius:12px;padding:16px;margin:12px 0;background:#1a1a1a">
      <h3 style="margin:0 0 8px;color:#fff"><a href="${d.url}" style="color:#FF6666;text-decoration:none">${d.name}</a></h3>
      <p>Glitch: <b style="color:#FF3333">${fmtPrice(d.price)}</b> | Normal: <span style="text-decoration:line-through;color:#999">${fmtPrice(d.normalPrice || d.originalPrice)}</span></p>
      <a href="${d.url}" style="display:inline-block;padding:8px 20px;background:#FF3333;color:#fff;border-radius:6px;text-decoration:none">BUY NOW</a>
    </div>`).join('');
  const html = `<!DOCTYPE html><html><body style="background:#111;color:#fff;font-family:sans-serif;padding:20px;max-width:600px;margin:auto"><h1 style="color:#FF3333">Glitch Deals Alert</h1><p>${deals.length} deal${deals.length > 1 ? 's' : ''} found!</p>${dealCards}<p style="color:#666;font-size:12px">Glitch Deal Scraper | ${new Date().toLocaleString()}</p></body></html>`;
  try {
    await transporter.sendMail({
      from:    `Glitch Deal Bot <${EMAIL_USER}>`,
      to:      EMAIL_TO,
      subject: `${deals.length} GLITCH DEAL${deals.length > 1 ? 'S' : ''} - Act Fast!`,
      html,
    });
    console.log(`[Email] Digest sent: ${deals.length} deals`);
  } catch (err) {
    console.error('[Email] Failed:', err.message);
  }
}

module.exports = { sendDiscordAlert, sendSystemAlert, sendEmailDigest };
