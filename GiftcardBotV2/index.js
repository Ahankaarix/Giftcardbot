require('dotenv').config();

// Strip accidental "KEY=value" prefix if user copy-pasted entire env line as secret value
function getEnv(key, fallback = '') {
  const raw = process.env[key] || fallback;
  const prefix = key + '=';
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
}

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
  PermissionFlagsBits,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
  ActivityType
} = require('discord.js');
const mysql = require('mysql2/promise');
const express = require('express');
const Razorpay = require('razorpay');

// ========================================
// CONFIGURATION
// ========================================

const CONFIG = {
  BOT_TOKEN: getEnv('BOT_TOKEN'),
  DB: {
    host: getEnv('DB_HOST', '104.234.180.242'),
    user: getEnv('DB_USER', 'u82822_PZ9oYvFPp2'),
    password: getEnv('DB_PASSWORD'),
    database: getEnv('DB_NAME', 's82822_vipshop'),
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 30000
  },
  CHANNEL_ID: process.env.CHANNEL_ID || '1490955092541575180',
  STATUS_CHANNEL_ID: process.env.STATUS_CHANNEL_ID || '1490971944290488363',
  QR_IMAGE: process.env.QR_IMAGE || 'https://r2.fivemanage.com/Ys9r66xkAMyCtiby4q1Oj/kotakupi.png',
  STORE_LOGO: process.env.STORE_LOGO || 'https://r2.fivemanage.com/Ys9r66xkAMyCtiby4q1Oj/GIFTCARDLOGO.png',
  UPI_ID: process.env.UPI_ID || 'davidbarma19@okicici',
  PAYPAL_ID: process.env.PAYPAL_ID || 'jarmantyson@gmail.com',
  ADMIN_ROLE_IDS: (process.env.ADMIN_ROLE_IDS || '1475465692479361085,1471528112880746559').split(',').map(s => s.trim()).filter(Boolean),
  SUPER_USER_IDS: (process.env.SUPER_USER_IDS || '879396413010743337,1054207830292447324,661812193242906675').split(',').map(s => s.trim()).filter(Boolean),
  WEBHOOK_PORT: process.env.WEBHOOK_PORT || process.env.PORT || 3001,
  TEBEX_URL: process.env.TEBEX_URL || 'https://projectirace.tebex.com',

  // Future payment gateways (not shown to users yet — manual UPI is primary)
  RAZORPAY: {
    key_id: process.env.RAZORPAY_KEY_ID || 'YOUR_RAZORPAY_KEY_ID',
    key_secret: process.env.RAZORPAY_KEY_SECRET || 'YOUR_RAZORPAY_KEY_SECRET'
  },
  CASHFREE: {
    app_id: process.env.CASHFREE_APP_ID || 'YOUR_CASHFREE_APP_ID',
    secret_key: process.env.CASHFREE_SECRET_KEY || 'YOUR_CASHFREE_SECRET_KEY'
  },

  DB_RETRY_DELAY: 5000,
  DB_MAX_RETRIES: 10,
  DEFAULT_MAX_STOCK: 10,
  LOW_STOCK_THRESHOLD: 3,

  // All available gift card face values (in INR)
  PACKAGES: [100, 500, 1000, 2500, 5000, 10000],

  // Offer discounts: face_value -> { pct: discount%, price: discounted_price }
  OFFERS: {
    1000:  { pct: 10, price: 900  },
    2500:  { pct: 15, price: 2125 },
    5000:  { pct: 20, price: 4000 },
    10000: { pct: 30, price: 7000 }
  }
};

// Helper: get the actual amount user pays (discounted if offer applies)
function getPayPrice(faceValue) {
  return CONFIG.OFFERS[faceValue] ? CONFIG.OFFERS[faceValue].price : faceValue;
}

// Helper: get offer label string
function getOfferLabel(faceValue) {
  const o = CONFIG.OFFERS[faceValue];
  if (!o) return null;
  return `${o.pct}% OFF — Pay ₹${o.price}`;
}


// ========================================
// SLASH COMMAND DEFINITIONS
// ========================================

const commands = [
  new SlashCommandBuilder()
    .setName('addcard')
    .setDescription('Add a gift card to inventory (Admin only)')
    .addIntegerOption(opt =>
      opt.setName('amount').setDescription('Gift card face value').setRequired(true)
        .addChoices(
          { name: '₹100', value: 100 },
          { name: '₹500', value: 500 },
          { name: '₹1000', value: 1000 },
          { name: '₹2500', value: 2500 },
          { name: '₹5000', value: 5000 },
          { name: '₹10000', value: 10000 }
        )
    )
    .addStringOption(opt => opt.setName('code').setDescription('Gift card code').setRequired(true))
    .addIntegerOption(opt =>
      opt.setName('offer_pct').setDescription('Discount % for this denomination (e.g. 10 = 10% off). Clears offer if 0.')
        .setRequired(false).setMinValue(0).setMaxValue(99)
    )
    .addIntegerOption(opt =>
      opt.setName('offer_price').setDescription('Override: exact amount users pay (auto-calc from offer_pct if not set)')
        .setRequired(false).setMinValue(1)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('stock')
    .setDescription('Check gift card stock with limits (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('syncstock')
    .setDescription('Force a full SQL→Discord stock reconciliation and refresh all embeds (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('setstock')
    .setDescription('Set max stock limit for a package (Admin only)')
    .addIntegerOption(opt =>
      opt.setName('amount').setDescription('Package face value').setRequired(true)
        .addChoices(
          { name: '₹100', value: 100 },
          { name: '₹500', value: 500 },
          { name: '₹1000', value: 1000 },
          { name: '₹2500', value: 2500 },
          { name: '₹5000', value: 5000 },
          { name: '₹10000', value: 10000 }
        )
    )
    .addIntegerOption(opt =>
      opt.setName('limit').setDescription('New maximum stock limit').setRequired(true).setMinValue(1).setMaxValue(1000)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('restockall')
    .setDescription('Reset sold count and restock all packages to max limit (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('transactions')
    .setDescription('View recent transactions (Admin only)')
    .addIntegerOption(opt =>
      opt.setName('limit').setDescription('Number to show (default 10)').setRequired(false).setMinValue(1).setMaxValue(25)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('store')
    .setDescription('Post the gift card store in this channel (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('dashboard')
    .setDescription('Show bot status dashboard (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('dbstatus')
    .setDescription('Show database health, record counts, and last sync (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('dbsync')
    .setDescription('Manually trigger a database sync and health check (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
].map(cmd => cmd.toJSON());

// ========================================
// DATABASE LAYER — AUTO-RECONNECT
// ========================================

let pool;
let dbConnected = false;

async function createPool() {
  pool = mysql.createPool(CONFIG.DB);
  setInterval(async () => {
    try {
      await pool.query('SELECT 1');
      dbConnected = true;
    } catch (err) {
      console.error('[DB] Keepalive failed:', err.message);
      dbConnected = false;
      await reconnectDB();
    }
  }, 30000);
}

async function reconnectDB(retries = 0) {
  if (retries >= CONFIG.DB_MAX_RETRIES) {
    console.error('[DB] Max retries reached. DB offline.');
    return;
  }
  try {
    if (pool) try { await pool.end(); } catch (_) {}
    await createPool();
    await initDatabase();
    dbConnected = true;
    console.log(`[DB] Reconnected (attempt ${retries + 1})`);
  } catch (err) {
    console.error(`[DB] Reconnect ${retries + 1} failed:`, err.message);
    setTimeout(() => reconnectDB(retries + 1), CONFIG.DB_RETRY_DELAY);
  }
}

async function initDatabase() {
  const conn = await pool.getConnection();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS gift_cards (
        id INT AUTO_INCREMENT PRIMARY KEY,
        amount INT NOT NULL,
        code VARCHAR(255) NOT NULL UNIQUE,
        is_used TINYINT(1) DEFAULT 0,
        used_by VARCHAR(255) DEFAULT NULL,
        assigned_at DATETIME DEFAULT NULL,
        expiry DATETIME DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        amount INT NOT NULL,
        paid_amount INT DEFAULT NULL,
        payment_id VARCHAR(255) DEFAULT NULL,
        upi_txn VARCHAR(255) DEFAULT NULL,
        sender VARCHAR(255) DEFAULT NULL,
        payment_app VARCHAR(100) DEFAULT NULL,
        gateway_txn VARCHAR(255) DEFAULT NULL,
        status ENUM('pending','approved','rejected','captured') DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Add paid_amount and payment_app columns if they don't exist yet (for existing DBs)
    await conn.query(`
      ALTER TABLE transactions
        ADD COLUMN IF NOT EXISTS paid_amount INT DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS payment_app VARCHAR(100) DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS admin_msg_id VARCHAR(255) DEFAULT NULL
    `).catch(() => {});

    // Add 'expired' status to the enum if not already present
    await conn.query(`
      ALTER TABLE transactions
        MODIFY COLUMN status ENUM('pending','approved','rejected','captured','expired') DEFAULT 'pending'
    `).catch(() => {});

    await conn.query(`
      CREATE TABLE IF NOT EXISTS action_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        action VARCHAR(255) NOT NULL,
        user_id VARCHAR(255) DEFAULT NULL,
        details TEXT DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS bot_config (
        key_name VARCHAR(100) PRIMARY KEY,
        value TEXT DEFAULT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS stock_config (
        amount INT PRIMARY KEY,
        max_stock INT NOT NULL DEFAULT 10,
        sold_count INT NOT NULL DEFAULT 0,
        low_stock_threshold INT NOT NULL DEFAULT 3,
        last_restocked DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS stock_history (
        id INT AUTO_INCREMENT PRIMARY KEY,
        amount INT NOT NULL,
        event_type ENUM('sale','restock','limit_change','manual_add') NOT NULL,
        quantity_change INT NOT NULL,
        sold_count_after INT NOT NULL,
        max_stock_after INT NOT NULL,
        performed_by VARCHAR(255) DEFAULT NULL,
        notes TEXT DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS db_sync_log (
        id INT AUTO_INCREMENT PRIMARY KEY,
        sync_type ENUM('startup','reconnect','manual','scheduled') NOT NULL DEFAULT 'startup',
        tables_checked INT DEFAULT 0,
        tables_created INT DEFAULT 0,
        total_gift_cards INT DEFAULT 0,
        available_cards INT DEFAULT 0,
        total_transactions INT DEFAULT 0,
        pending_transactions INT DEFAULT 0,
        total_stock_events INT DEFAULT 0,
        triggered_by VARCHAR(255) DEFAULT 'system',
        notes TEXT DEFAULT NULL,
        synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Seed stock_config for all 6 packages
    for (const amount of CONFIG.PACKAGES) {
      await conn.query(`
        INSERT INTO stock_config (amount, max_stock, sold_count, low_stock_threshold)
        VALUES (?, ?, 0, ?)
        ON DUPLICATE KEY UPDATE amount = amount
      `, [amount, CONFIG.DEFAULT_MAX_STOCK, CONFIG.LOW_STOCK_THRESHOLD]);
    }

    dbConnected = true;
    console.log('[DB] All tables initialized. Stock seeded for all packages.');
  } finally {
    conn.release();
  }
}

// ========================================
// BOT CONFIG HELPERS
// ========================================

async function getConfig(key) {
  try {
    const [rows] = await pool.query('SELECT value FROM bot_config WHERE key_name = ?', [key]);
    return rows.length > 0 ? rows[0].value : null;
  } catch { return null; }
}

async function setConfig(key, value) {
  try {
    await pool.query(
      'INSERT INTO bot_config (key_name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = ?, updated_at = NOW()',
      [key, value, value]
    );
  } catch (err) {
    console.error('[CONFIG SET ERROR]', err.message);
  }
}

async function saveOfferToDB(amount, offerData) {
  const key = `offer_${amount}`;
  await setConfig(key, offerData ? JSON.stringify(offerData) : null);
}

async function loadOffersFromDB() {
  try {
    for (const amount of CONFIG.PACKAGES) {
      const raw = await getConfig(`offer_${amount}`);
      if (raw === null || raw === undefined) continue;
      if (raw === 'null' || raw === '') {
        delete CONFIG.OFFERS[amount];
      } else {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && parsed.pct !== undefined && parsed.price !== undefined) {
            CONFIG.OFFERS[amount] = parsed;
          }
        } catch (_) {}
      }
    }
    console.log('[OFFERS] Loaded custom offers from DB:', JSON.stringify(CONFIG.OFFERS));
  } catch (err) {
    console.error('[OFFERS LOAD ERROR]', err.message);
  }
}

// ========================================
// AUTO DATABASE SYNC
// ========================================

async function runAutoDbSync(syncType = 'scheduled', triggeredBy = 'system') {
  const conn = await pool.getConnection();
  try {
    const tables = ['gift_cards', 'transactions', 'action_logs', 'bot_config', 'stock_config', 'stock_history', 'db_sync_log'];
    const [[{ total_gift_cards }]] = await conn.query('SELECT COUNT(*) as total_gift_cards FROM gift_cards');
    const [[{ available_cards }]] = await conn.query('SELECT COUNT(*) as available_cards FROM gift_cards WHERE is_used = 0');
    const [[{ total_transactions }]] = await conn.query('SELECT COUNT(*) as total_transactions FROM transactions');
    const [[{ pending_transactions }]] = await conn.query('SELECT COUNT(*) as pending_transactions FROM transactions WHERE status = "pending"');
    const [[{ total_stock_events }]] = await conn.query('SELECT COUNT(*) as total_stock_events FROM stock_history');

    await conn.query(`
      INSERT INTO db_sync_log
        (sync_type, tables_checked, tables_created, total_gift_cards, available_cards,
         total_transactions, pending_transactions, total_stock_events, triggered_by, notes)
      VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
    `, [
      syncType, tables.length,
      total_gift_cards, available_cards,
      total_transactions, pending_transactions,
      total_stock_events, triggeredBy,
      `Auto sync completed at ${new Date().toISOString()}`
    ]);

    dbConnected = true;
    conn.release();

    // Reconcile stock_config against actual gift_cards table to fix any drift
    const reconciledStock = await reconcileStockFromDB().catch(err => {
      console.error('[STOCK RECONCILE ERROR]', err.message);
      return null;
    });

    const driftedPackages = reconciledStock ? reconciledStock.filter(s => s.drifted).map(s => `₹${s.amount}`) : [];
    if (driftedPackages.length > 0) {
      console.log(`[DB SYNC] Stock drift corrected for: ${driftedPackages.join(', ')}`);
    }

    console.log(`[DB SYNC] ${syncType} sync complete — ${total_gift_cards} cards, ${total_transactions} txns`);
    return { total_gift_cards, available_cards, total_transactions, pending_transactions, total_stock_events, reconciledStock };
  } catch (err) {
    console.error('[DB SYNC ERROR]', err.message);
    conn.release();
    return null;
  }
}

async function getRecentSyncLogs(limit = 5) {
  try {
    const [rows] = await pool.query('SELECT * FROM db_sync_log ORDER BY synced_at DESC LIMIT ?', [limit]);
    return rows;
  } catch { return []; }
}

// ========================================
// POST DB REPORT TO STATUS CHANNEL
// ========================================

async function postDbReport(client, stats, syncType = 'scheduled') {
  try {
    const statusChannel = await client.channels.fetch(CONFIG.STATUS_CHANNEL_ID).catch(() => null);
    if (!statusChannel) return;

    const recentLogs = await getRecentSyncLogs(3);
    const historyText = recentLogs.length > 0
      ? recentLogs.map(r =>
          `\`${new Date(r.synced_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\` — ` +
          `**${r.sync_type}** | Cards: ${r.total_gift_cards} | Txns: ${r.total_transactions} | Pending: ${r.pending_transactions}`
        ).join('\n')
      : 'No sync records yet';

    const icons = { startup: '🚀', reconnect: '🔄', manual: '🛠️', scheduled: '⏰' };

    // Build per-denomination stock breakdown if reconciliation data is present
    let stockBreakdown = '—';
    if (stats.reconciledStock && stats.reconciledStock.length > 0) {
      stockBreakdown = stats.reconciledStock.map(r => {
        const icon = r.is_sold_out ? '🔴' : r.is_low_stock ? '🟡' : '🟢';
        const drift = r.drifted ? ' ⚠️' : '';
        return `${icon} **₹${r.amount}**: ${r.avail_codes}/${r.total_codes} unused${drift}`;
      }).join('\n');
    }

    const embed = new EmbedBuilder()
      .setTitle(`${icons[syncType] || '🔄'} Database Sync — ${syncType.charAt(0).toUpperCase() + syncType.slice(1)}`)
      .setDescription(`Auto SQL sync completed. All tables verified and stock reconciled.`)
      .addFields(
        { name: '🎁 Gift Cards', value: `Total: **${stats.total_gift_cards}** | Available: **${stats.available_cards}**`, inline: true },
        { name: '💳 Transactions', value: `Total: **${stats.total_transactions}** | Pending: **${stats.pending_transactions}**`, inline: true },
        { name: '📊 Stock Events', value: `**${stats.total_stock_events}** recorded`, inline: true },
        { name: '📦 Per-Denomination Stock (from SQL)', value: stockBreakdown, inline: false },
        { name: '🗄️ Tables Verified', value: '`gift_cards` `transactions` `action_logs`\n`bot_config` `stock_config` `stock_history` `db_sync_log`', inline: false },
        { name: '📋 Recent Sync History', value: historyText, inline: false }
      )
      .setColor(0x00BFFF)
      .setTimestamp()
      .setFooter({ text: `DB Sync • ${CONFIG.DB.database} @ ${CONFIG.DB.host}` });

    const savedMsgId = await getConfig('db_report_message_id');
    if (savedMsgId) {
      try {
        const msg = await statusChannel.messages.fetch(savedMsgId);
        await msg.edit({ embeds: [embed] });
        return;
      } catch (_) {}
    }
    const msg = await statusChannel.send({ embeds: [embed] });
    await setConfig('db_report_message_id', msg.id);
  } catch (err) {
    console.error('[DB REPORT ERROR]', err.message);
  }
}

// ========================================
// STOCK HELPERS
// ========================================

async function getStockStatus(amount) {
  const [[cfg]] = await pool.query('SELECT * FROM stock_config WHERE amount = ?', [amount]);
  if (!cfg) return null;
  // Count actual unused and used codes directly from gift_cards — never cap by max_stock
  const [[counts]] = await pool.query(`
    SELECT
      SUM(CASE WHEN is_used = 0 THEN 1 ELSE 0 END) AS available,
      SUM(CASE WHEN is_used = 1 THEN 1 ELSE 0 END) AS used_count,
      COUNT(*) AS total_codes
    FROM gift_cards WHERE amount = ?
  `, [amount]);
  const available  = Number(counts.available)   || 0;
  const used_count = Number(counts.used_count)  || 0;
  const total      = Number(counts.total_codes) || 0;
  return {
    amount,
    max_stock:       cfg.max_stock,
    sold_count:      used_count,   // actual used, not the tracked counter
    available_codes: available,
    total_codes:     total,
    remaining:       available,    // = actual unused codes in DB, no cap
    is_sold_out:     available <= 0,
    is_low_stock:    available > 0 && available <= cfg.low_stock_threshold,
    pct:             total > 0 ? Math.round((used_count / total) * 100) : 0
  };
}

async function getAllStockStatus() {
  const results = {};
  for (const amt of CONFIG.PACKAGES) {
    results[amt] = await getStockStatus(amt);
  }
  return results;
}

async function recordSale(conn, amount, performedBy) {
  await conn.query(
    'UPDATE stock_config SET sold_count = sold_count + 1, updated_at = NOW() WHERE amount = ?',
    [amount]
  );
  const [[cfg]] = await conn.query('SELECT sold_count, max_stock FROM stock_config WHERE amount = ?', [amount]);
  await conn.query(`
    INSERT INTO stock_history (amount, event_type, quantity_change, sold_count_after, max_stock_after, performed_by, notes)
    VALUES (?, 'sale', -1, ?, ?, ?, ?)
  `, [amount, cfg.sold_count, cfg.max_stock, performedBy, `Gift card sold to user ${performedBy}`]);
}

async function recordRestock(amount, newMax, performedBy, notes = '') {
  const [[prev]] = await pool.query('SELECT sold_count, max_stock FROM stock_config WHERE amount = ?', [amount]);
  await pool.query(`
    INSERT INTO stock_history (amount, event_type, quantity_change, sold_count_after, max_stock_after, performed_by, notes)
    VALUES (?, 'restock', ?, ?, ?, ?, ?)
  `, [amount, newMax - prev.max_stock, prev.sold_count, newMax, performedBy, notes || 'Stock limit updated']);
}

async function recordManualAdd(amount, performedBy) {
  const [[cfg]] = await pool.query('SELECT sold_count, max_stock FROM stock_config WHERE amount = ?', [amount]);
  await pool.query(`
    INSERT INTO stock_history (amount, event_type, quantity_change, sold_count_after, max_stock_after, performed_by, notes)
    VALUES (?, 'manual_add', 1, ?, ?, ?, 'Admin added card manually')
  `, [amount, cfg.sold_count, cfg.max_stock, performedBy]);
}

function stockBar(sold, max) {
  const filled = max > 0 ? Math.round((sold / max) * 10) : 0;
  const empty = 10 - filled;
  return '█'.repeat(filled) + '░'.repeat(empty) + ` ${sold}/${max} sold`;
}

// ========================================
// STOCK RECONCILIATION (SQL → Discord)
// ========================================
// Reads actual gift_cards table, corrects stock_config drift, returns per-denom breakdown.

async function reconcileStockFromDB() {
  const results = [];
  const conn = await pool.getConnection();
  try {
    for (const amt of CONFIG.PACKAGES) {
      const [[counts]] = await conn.query(`
        SELECT
          COUNT(*)                        AS total_codes,
          SUM(CASE WHEN is_used = 0 THEN 1 ELSE 0 END) AS available_codes,
          SUM(CASE WHEN is_used = 1 THEN 1 ELSE 0 END) AS used_codes
        FROM gift_cards WHERE amount = ?
      `, [amt]);

      const total    = Number(counts.total_codes)     || 0;
      const avail    = Number(counts.available_codes) || 0;
      const used     = Number(counts.used_codes)      || 0;

      // Fetch current stock_config
      const [[cfg]] = await conn.query('SELECT * FROM stock_config WHERE amount = ?', [amt]);
      const prevSold = cfg ? cfg.sold_count  : 0;
      const maxStock = cfg ? cfg.max_stock   : CONFIG.DEFAULT_MAX_STOCK;

      // Correct sold_count to match actual used codes
      if (cfg && cfg.sold_count !== used) {
        await conn.query('UPDATE stock_config SET sold_count = ?, updated_at = NOW() WHERE amount = ?', [used, amt]);
        console.log(`[STOCK RECONCILE] ₹${amt}: sold_count corrected ${prevSold} → ${used}`);
      }

      const remaining = Math.max(0, avail);
      results.push({
        amount:      amt,
        total_codes: total,
        avail_codes: avail,
        used_codes:  used,
        max_stock:   maxStock,
        sold_count:  used,
        remaining,
        drifted:     prevSold !== used,
        is_sold_out: remaining === 0,
        is_low_stock: remaining > 0 && remaining <= (cfg?.low_stock_threshold || CONFIG.LOW_STOCK_THRESHOLD)
      });
    }
    return results;
  } finally {
    conn.release();
  }
}

// ========================================
// RAZORPAY INSTANCE (future use)
// ========================================

const razorpay = new Razorpay({ key_id: CONFIG.RAZORPAY.key_id, key_secret: CONFIG.RAZORPAY.key_secret });

// ========================================
// LOGGING HELPER
// ========================================

async function logAction(action, userId, details) {
  try {
    await pool.query('INSERT INTO action_logs (action, user_id, details) VALUES (?, ?, ?)', [action, userId, details]);
  } catch (err) {
    console.error('[LOG ERROR]', err.message);
  }
}

// ========================================
// TRANSACTION XML LOG — sent to status channel
// ========================================

async function sendTransactionLog(client, data) {
  try {
    const now = new Date();
    const ist = now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    const iso = now.toISOString();

    const esc = v => (v == null || v === '' ? 'N/A' : String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'));

    const eventIcons = {
      SUBMITTED: '📥',
      APPROVED:  '✅',
      REJECTED:  '❌',
      CAPTURED:  '💳'
    };

    const xml = [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<transaction>`,
      `  <id>${esc(data.txnId)}</id>`,
      `  <event>${esc(data.event)}</event>`,
      `  <status>${esc(data.status?.toUpperCase())}</status>`,
      `  <timestamp>`,
      `    <utc>${esc(iso)}</utc>`,
      `    <ist>${esc(ist)}</ist>`,
      `  </timestamp>`,
      `  <user>`,
      `    <discord_id>${esc(data.userId)}</discord_id>`,
      `    <tag>${esc(data.userTag)}</tag>`,
      `  </user>`,
      `  <payment>`,
      `    <gift_card_face_value>₹${esc(data.giftCardValue)}</gift_card_face_value>`,
      `    <amount_paid>₹${esc(data.paidAmount)}</amount_paid>`,
      `    <offer_applied>${esc(data.offerApplied)}</offer_applied>`,
      `    <upi_transaction_id>${esc(data.upiTxnId)}</upi_transaction_id>`,
      `    <sender_name>${esc(data.senderName)}</sender_name>`,
      `    <payment_app>${esc(data.paymentApp)}</payment_app>`,
      `    <gateway_reference>${esc(data.gatewayRef)}</gateway_reference>`,
      `    <payment_id>${esc(data.paymentId)}</payment_id>`,
      `  </payment>`,
      data.approvedBy ? `  <admin>` : null,
      data.approvedBy ? `    <actioned_by>${esc(data.approvedBy)}</actioned_by>` : null,
      data.delivered != null ? `    <card_delivered>${data.delivered ? 'YES' : 'NO'}</card_delivered>` : null,
      data.approvedBy ? `  </admin>` : null,
      `</transaction>`
    ].filter(Boolean).join('\n');

    const icon = eventIcons[data.event] || '📋';
    const statusLine = {
      SUBMITTED: '🟡 New payment submitted — awaiting admin review',
      APPROVED:  `🟢 Payment approved by **${data.approvedBy}** — card ${data.delivered ? 'delivered ✅' : 'not delivered ⚠️'}`,
      REJECTED:  `🔴 Payment rejected by **${data.approvedBy}**`,
      CAPTURED:  '💳 Razorpay payment captured — card auto-delivered'
    }[data.event] || '';

    const ch = await client.channels.fetch(CONFIG.STATUS_CHANNEL_ID).catch(() => null);
    if (!ch) return;

    await ch.send({
      content: `${icon} **TXN LOG #${data.txnId}** — <@${data.userId}> • ${statusLine}\n\`\`\`xml\n${xml}\n\`\`\``
    });

    console.log(`[TXN LOG] Sent XML log for txn #${data.txnId} — ${data.event}`);
  } catch (err) {
    console.error('[TXN LOG ERROR]', err.message);
  }
}

// ========================================
// DELIVER GIFT CARD
// ========================================

async function deliverGiftCard(client, userId, amount, paymentId) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Only check actual available codes — max_stock cap removed so real DB count drives delivery
    const [rows] = await conn.query(
      'SELECT * FROM gift_cards WHERE amount = ? AND is_used = 0 LIMIT 1 FOR UPDATE', [amount]
    );
    if (rows.length === 0) {
      await conn.rollback();
      const guild = client.guilds.cache.first();
      if (guild) {
        const user = await client.users.fetch(userId).catch(() => null);
        if (user) await createTicket(guild, user, `No gift card codes in stock for ₹${amount}`, { amount, paymentId });
      }
      await logAction('OUT_OF_STOCK', userId, `₹${amount}, Payment: ${paymentId}`);
      return false;
    }

    const card = rows[0];
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + 7);

    await conn.query(
      'UPDATE gift_cards SET is_used = 1, used_by = ?, assigned_at = NOW(), expiry = ? WHERE id = ?',
      [userId, expiry, card.id]
    );
    await recordSale(conn, amount, userId);
    await conn.commit();

    const expiryStr = expiry.toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' });
    const offerLabel = getOfferLabel(amount);
    const payPrice = getPayPrice(amount);

    try {
      const user = await client.users.fetch(userId);
      await user.send({
        embeds: [
          new EmbedBuilder()
            .setTitle('✅ Payment Approved — Gift Card Delivered!')
            .setDescription('Thank you for your purchase! Your gift card code is below.')
            .addFields(
              { name: '🎁 Gift Card Code', value: `\`\`\`${card.code}\`\`\``, inline: false },
              { name: '💰 Face Value', value: `₹${amount}`, inline: true },
              { name: '💸 You Paid', value: `₹${payPrice}${offerLabel ? ` (${offerLabel})` : ''}`, inline: true },
              { name: '📅 Valid Until', value: expiryStr, inline: true },
              { name: '🔗 Redeem Here', value: `[Click to Redeem](${CONFIG.TEBEX_URL})`, inline: false }
            )
            .setColor(0x00FF00).setTimestamp()
            .setFooter({ text: 'Gift Card Store • Keep your code safe' })
        ]
      });
    } catch (dmErr) {
      console.error('[DM ERROR]', dmErr.message);
    }

    await logAction('CARD_DELIVERED', userId, `Card: ${card.id}, ₹${amount}`);
    return true;
  } catch (err) {
    await conn.rollback();
    console.error('[DELIVER ERROR]', err);
    throw err;
  } finally {
    conn.release();
  }
}

// ========================================
// TICKET SYSTEM
// ========================================

async function createTicket(guild, user, reason, paymentDetails) {
  const safeName = user.username.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 20);
  const ticketName = `ticket-${safeName}`;
  const existing = guild.channels.cache.find(c => c.name === ticketName);
  if (existing) return existing;

  const permOverwrites = [
    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
  ];
  // Grant access to all configured admin roles
  for (const roleId of CONFIG.ADMIN_ROLE_IDS) {
    const role = guild.roles.cache.get(roleId);
    if (role) permOverwrites.push({ id: role.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
  }

  const ch = await guild.channels.create({ name: ticketName, type: ChannelType.GuildText, permissionOverwrites: permOverwrites });
  const embed = new EmbedBuilder()
    .setTitle('🎫 Support Ticket')
    .setDescription(`**Reason:** ${reason}`)
    .addFields({ name: '👤 User', value: `<@${user.id}>`, inline: true }, { name: '🆔 User ID', value: user.id, inline: true })
    .setColor(0xFFA500).setTimestamp();
  if (paymentDetails) embed.addFields(
    { name: '💰 Amount', value: `₹${paymentDetails.amount}`, inline: true },
    { name: '📋 Payment Ref', value: paymentDetails.paymentId || 'N/A', inline: true }
  );
  embed.addFields({ name: '📸 Next Step', value: 'Please upload a screenshot of your payment. An admin will assist you shortly.' });
  await ch.send({ embeds: [embed] });
  await logAction('TICKET_CREATED', user.id, `Ticket: ${ticketName}, Reason: ${reason}`);
  return ch;
}

// ========================================
// DUPLICATE CHECKS
// ========================================

async function hasPendingPayment(userId) {
  const [rows] = await pool.query('SELECT id FROM transactions WHERE user_id = ? AND status = "pending" LIMIT 1', [userId]);
  return rows.length > 0;
}

async function isDuplicateTxn(upiTxn) {
  if (!upiTxn) return false;
  const [rows] = await pool.query('SELECT id FROM transactions WHERE upi_txn = ? LIMIT 1', [upiTxn]);
  return rows.length > 0;
}

// ========================================
// STORE EMBED (with offers + live stock)
// ========================================

async function buildStoreEmbed() {
  const stockAll = await getAllStockStatus();

  const stockLines = CONFIG.PACKAGES.map(amt => {
    const s = stockAll[amt];
    const offer = CONFIG.OFFERS[amt];
    const offerTag = offer ? ` 🏷️ **${offer.pct}% OFF** ~~₹${amt}~~ → ₹${offer.price}` : '';

    if (!s) return `₹${amt}${offerTag} — Unknown`;
    if (s.is_sold_out) return `₹${amt}${offerTag} — 🔴 **SOLD OUT**`;
    if (s.is_low_stock) return `₹${amt}${offerTag} — 🟡 **${s.remaining} remaining** ⚠️ Low Stock`;
    return `₹${amt}${offerTag} — 🟢 **${s.remaining} available**`;
  }).join('\n');

  return new EmbedBuilder()
    .setTitle('🎁 Gift Card Store')
    .setDescription(
      '**Welcome to the Gift Card Store!**\n\n' +
      'Purchase gift cards instantly using **UPI** or **PayPal**.\n\n' +
      '**How it works:**\n' +
      '1️⃣ Select a gift card amount from the dropdown below\n' +
      '2️⃣ Pay via UPI (scan QR) or PayPal — your choice\n' +
      '3️⃣ Submit your transaction details\n' +
      '4️⃣ Receive your gift card via DM after admin approval\n\n' +
      '🔒 Secure | 📱 UPI or 🅿️ PayPal | 🎁 Quick Delivery'
    )
    .addFields({ name: '📦 Current Stock & Offers', value: stockLines, inline: false })
    .setColor(0x5865F2)
    .setThumbnail(CONFIG.STORE_LOGO)
    .setTimestamp()
    .setFooter({ text: 'Gift Card Store | Limited Stock | Best Prices' });
}

async function buildStoreRow() {
  const stockAll = await getAllStockStatus();

  const EMOJIS = { 100: '💰', 500: '💵', 1000: '💎', 2500: '🏆', 5000: '👑', 10000: '🌟' };

  const options = CONFIG.PACKAGES.map(amt => {
    const s = stockAll[amt];
    const soldOut = s ? s.is_sold_out : false;
    const remaining = s ? s.remaining : 0;
    const offer = CONFIG.OFFERS[amt];

    let label, description;
    if (soldOut) {
      label = `₹${amt} Gift Card — SOLD OUT`;
      description = 'Currently out of stock';
    } else if (offer) {
      label = `₹${amt} Gift Card | ${offer.pct}% OFF → Pay ₹${offer.price}`;
      description = `Save ₹${amt - offer.price}! ${remaining} remaining`;
    } else {
      label = `₹${amt} Gift Card (${remaining} left)`;
      description = `Purchase a ₹${amt} gift card`;
    }

    return {
      label: label.substring(0, 100),
      description: description.substring(0, 100),
      value: amt.toString(),
      emoji: EMOJIS[amt] || '🎁',
      default: false
    };
  });

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('select_amount')
      .setPlaceholder('🛒 Select a Gift Card to Purchase')
      .addOptions(options)
  );
}

// ========================================
// DASHBOARD EMBED
// ========================================

async function buildDashboardEmbed(botTag, isOnline = true) {
  let stockSection = 'DB Offline';
  let txnText = '—';
  let pendingText = '—';
  let todayText = '—';
  let historyText = '—';

  try {
    const stockAll = await getAllStockStatus();
    stockSection = CONFIG.PACKAGES.map(amt => {
      const s = stockAll[amt];
      if (!s) return `₹${amt} — N/A`;
      // Bar shows used vs total codes in DB (not capped by max_stock)
      const total = s.total_codes || (s.sold_count + s.available_codes);
      const bar = stockBar(s.sold_count, Math.max(total, 1));
      const status = s.is_sold_out ? '🔴 SOLD OUT' : s.is_low_stock ? '🟡 LOW' : '🟢 OK';
      const offer = CONFIG.OFFERS[amt];
      const offerStr = offer ? ` 🏷️${offer.pct}%OFF` : '';
      return `**₹${amt}**${offerStr} ${status}\n\`${bar}\`\n${s.remaining} available in DB`;
    }).join('\n\n');

    const [[{ total }]] = await pool.query('SELECT COUNT(*) as total FROM transactions WHERE status IN ("approved","captured")');
    const [[{ pending }]] = await pool.query('SELECT COUNT(*) as pending FROM transactions WHERE status = "pending"');
    const [[{ today }]] = await pool.query('SELECT COUNT(*) as today FROM transactions WHERE DATE(created_at) = CURDATE()');

    const [histRows] = await pool.query('SELECT * FROM stock_history ORDER BY created_at DESC LIMIT 3');
    if (histRows.length > 0) {
      historyText = histRows.map(r => {
        const icon = r.event_type === 'sale' ? '📤' : r.event_type === 'restock' ? '📥' : r.event_type === 'limit_change' ? '⚙️' : '➕';
        return `${icon} ₹${r.amount} ${r.event_type} (${r.quantity_change > 0 ? '+' : ''}${r.quantity_change}) — ${new Date(r.created_at).toLocaleString('en-IN')}`;
      }).join('\n');
    } else {
      historyText = 'No events yet';
    }

    txnText = `**${total}** completed`;
    pendingText = `**${pending}** awaiting review`;
    todayText = `**${today}** transactions today`;
  } catch (err) {
    console.error('[DASHBOARD DB]', err.message);
  }

  return new EmbedBuilder()
    .setTitle(isOnline ? '🟢 Bot Online — Gift Card Store Dashboard' : '🔴 Bot Offline')
    .setDescription(isOnline
      ? `**${botTag}** is online and operational.`
      : `**${botTag}** went offline. Reconnecting...`)
    .addFields(
      { name: '📦 Stock Status', value: stockSection, inline: false },
      { name: '📊 Completed Sales', value: txnText, inline: true },
      { name: '⏳ Pending Reviews', value: pendingText, inline: true },
      { name: '📅 Today', value: todayText, inline: true },
      { name: '📋 Recent Stock Events', value: historyText, inline: false },
      { name: '⚙️ Services', value: `🟢 Discord Bot\n${dbConnected ? '🟢' : '🔴'} Database\n🟢 Webhook Server`, inline: true },
      { name: '🕐 Last Updated', value: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST', inline: true }
    )
    .setColor(isOnline ? 0x00FF00 : 0xFF0000)
    .setTimestamp()
    .setFooter({ text: 'Gift Card Store • Limited Stock Edition' });
}

// ========================================
// POST / UPDATE DASHBOARD & STORE
// ========================================

async function postOrUpdateDashboard(client, isOnline = true) {
  try {
    const channel = await client.channels.fetch(CONFIG.STATUS_CHANNEL_ID).catch(() => null);
    if (!channel) return;
    const embed = await buildDashboardEmbed(client.user.tag, isOnline);
    const savedMsgId = await getConfig('dashboard_message_id');
    if (savedMsgId) {
      try {
        const msg = await channel.messages.fetch(savedMsgId);
        await msg.edit({ embeds: [embed] });
        return;
      } catch (_) {}
    }
    const msg = await channel.send({ embeds: [embed] });
    await setConfig('dashboard_message_id', msg.id);
  } catch (err) {
    console.error('[DASHBOARD ERROR]', err.message);
  }
}

// On startup / reconnect: delete old dashboard panel and post a fresh one
async function cleanupAndPostDashboard(client) {
  try {
    const channel = await client.channels.fetch(CONFIG.STATUS_CHANNEL_ID).catch(() => null);
    if (!channel) return;

    const savedMsgId = await getConfig('dashboard_message_id');

    if (savedMsgId) {
      try {
        const oldMsg = await channel.messages.fetch(savedMsgId);
        await oldMsg.delete();
        console.log(`[DASHBOARD CLEANUP] Deleted old dashboard panel (msg: ${savedMsgId})`);
      } catch (_) {
        console.log('[DASHBOARD CLEANUP] Old dashboard panel already gone or not found.');
      }
      await setConfig('dashboard_message_id', null);
    }

    // Also scan recent messages and delete any orphaned dashboard embeds from this bot
    try {
      const recent = await channel.messages.fetch({ limit: 20 });
      const oldDashboards = recent.filter(m =>
        m.author.id === client.user.id &&
        m.embeds.length > 0 &&
        (m.embeds[0]?.title?.includes('Bot Online') || m.embeds[0]?.title?.includes('Bot Offline'))
      );
      for (const [, m] of oldDashboards) {
        await m.delete().catch(() => {});
        console.log(`[DASHBOARD CLEANUP] Removed orphaned dashboard panel (msg: ${m.id})`);
      }
    } catch (_) {}

    const embed = await buildDashboardEmbed(client.user.tag, true);
    const msg = await channel.send({ embeds: [embed] });
    await setConfig('dashboard_message_id', msg.id);
    console.log('[DASHBOARD CLEANUP] Fresh dashboard panel posted.');
  } catch (err) {
    console.error('[DASHBOARD CLEANUP ERROR]', err.message);
  }
}

async function postOrUpdateStore(client) {
  try {
    const channel = await client.channels.fetch(CONFIG.CHANNEL_ID).catch(() => null);
    if (!channel) { console.warn('[STORE] Channel not found.'); return; }
    const savedMsgId = await getConfig('store_message_id');
    const embed = await buildStoreEmbed();
    const row = await buildStoreRow();
    if (savedMsgId) {
      try {
        const msg = await channel.messages.fetch(savedMsgId);
        await msg.edit({ embeds: [embed], components: [row] });
        return;
      } catch (_) {}
    }
    const msg = await channel.send({ embeds: [embed], components: [row] });
    await setConfig('store_message_id', msg.id);
  } catch (err) {
    console.error('[STORE ERROR]', err.message);
  }
}

// On startup: delete old store panel(s) and post a clean fresh one
async function cleanupAndPostStore(client) {
  try {
    const channel = await client.channels.fetch(CONFIG.CHANNEL_ID).catch(() => null);
    if (!channel) { console.warn('[STORE CLEANUP] Channel not found.'); return; }

    const savedMsgId = await getConfig('store_message_id');

    // Delete the saved store message if it still exists
    if (savedMsgId) {
      try {
        const oldMsg = await channel.messages.fetch(savedMsgId);
        await oldMsg.delete();
        console.log(`[STORE CLEANUP] Deleted old store panel (msg: ${savedMsgId})`);
      } catch (_) {
        console.log('[STORE CLEANUP] Old store panel already gone or not found.');
      }
      await setConfig('store_message_id', null);
    }

    // Also scan the last 20 messages in the channel and delete any
    // leftover bot store embeds (safety net for orphaned panels)
    try {
      const recent = await channel.messages.fetch({ limit: 20 });
      const botStoreMessages = recent.filter(m =>
        m.author.id === client.user.id &&
        m.embeds.length > 0 &&
        m.embeds[0]?.title?.includes('Gift Card Store')
      );
      for (const [, m] of botStoreMessages) {
        await m.delete().catch(() => {});
        console.log(`[STORE CLEANUP] Removed orphaned store panel (msg: ${m.id})`);
      }
    } catch (_) {}

    // Post a fresh store panel
    const embed = await buildStoreEmbed();
    const row = await buildStoreRow();
    const msg = await channel.send({ embeds: [embed], components: [row] });
    await setConfig('store_message_id', msg.id);
    console.log('[STORE CLEANUP] Fresh store panel posted.');
  } catch (err) {
    console.error('[STORE CLEANUP ERROR]', err.message);
  }
}

// ========================================
// DISCORD CLIENT SETUP
// ========================================

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

// ========================================
// READY EVENT
// ========================================

client.once('clientReady', async () => {
  console.log(`[BOT] Logged in as ${client.user.tag} (${client.user.id})`);
  client.user.setPresence({
    activities: [{ name: '🎁 Gift Card Store | Best Offers', type: ActivityType.Watching }],
    status: 'online'
  });

  // Update bot profile picture
  try {
    await client.user.setAvatar('https://r2.fivemanage.com/Ys9r66xkAMyCtiby4q1Oj/iracecoinzx.png');
    console.log('[BOT] Profile picture updated.');
  } catch (err) {
    console.warn('[BOT] Could not update avatar:', err.message);
  }

  try { await createPool(); await initDatabase(); dbConnected = true; await loadOffersFromDB(); }
  catch (err) { console.error('[DB INIT ERROR]', err.message); await reconnectDB(); }

  try {
    const rest = new REST({ version: '10' }).setToken(CONFIG.BOT_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('[BOT] Slash commands registered.');
  } catch (err) { console.error('[COMMANDS ERROR]', err.message); }

  const startupStats = await runAutoDbSync('startup', 'system');
  if (startupStats) await postDbReport(client, startupStats, 'startup');

  await cleanupAndPostDashboard(client);
  await cleanupAndPostStore(client);

  setInterval(async () => {
    // Reconcile stock from DB first, then refresh Discord embeds
    await reconcileStockFromDB().catch(err => console.error('[AUTO RECONCILE]', err.message));
    await postOrUpdateDashboard(client, true);
    await postOrUpdateStore(client);
  }, 5 * 60 * 1000);

  setInterval(async () => {
    const stats = await runAutoDbSync('scheduled', 'system');
    if (stats) await postDbReport(client, stats, 'scheduled');
  }, 30 * 60 * 1000);

  startExpiryChecker(client);
});

client.on('shardReconnecting', () => console.log('[BOT] Reconnecting...'));
client.on('shardResume', async () => {
  console.log('[BOT] Reconnected!');
  client.user?.setPresence({ activities: [{ name: '🎁 Gift Card Store | Best Offers', type: ActivityType.Watching }], status: 'online' });
  try { await pool.query('SELECT 1'); dbConnected = true; } catch (_) { await reconnectDB(); }
  const reconnectStats = await runAutoDbSync('reconnect', 'system');
  if (reconnectStats) await postDbReport(client, reconnectStats, 'reconnect');
  await cleanupAndPostDashboard(client);
  await cleanupAndPostStore(client);
});

// ========================================
// INTERACTION HANDLER
// ========================================

client.on('interactionCreate', async (interaction) => {
  // Guard: ignore if Discord already received a response for this interaction
  if (interaction.replied || interaction.deferred) return;

  try {

    // ---- /dashboard ----
    if (interaction.isChatInputCommand() && interaction.commandName === 'dashboard') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await interaction.editReply({ embeds: [await buildDashboardEmbed(client.user.tag, true)] });
      return;
    }

    // ---- /dbstatus ----
    if (interaction.isChatInputCommand() && interaction.commandName === 'dbstatus') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const logs = await getRecentSyncLogs(10);
      const lines = logs.length > 0
        ? logs.map((r, i) => {
            const ts = new Date(r.synced_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
            return `\`${i + 1}\` **${r.sync_type}** at \`${ts}\`\n` +
              `Cards: **${r.available_cards}**/${r.total_gift_cards} | Txns: **${r.total_transactions}** | Pending: **${r.pending_transactions}**`;
          }).join('\n\n')
        : 'No sync records found.';
      await interaction.editReply({
        embeds: [new EmbedBuilder()
          .setTitle('🗄️ Database Status & Sync History')
          .setDescription(`Last **${logs.length}** sync records:\n\n${lines}`)
          .setColor(0x00BFFF).setTimestamp()
          .setFooter({ text: `Database: ${CONFIG.DB.database} @ ${CONFIG.DB.host}` })]
      });
      return;
    }

    // ---- /dbsync ----
    if (interaction.isChatInputCommand() && interaction.commandName === 'dbsync') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const stats = await runAutoDbSync('manual', interaction.user.tag);
      if (!stats) { await interaction.editReply('❌ DB sync failed. Check console.'); return; }
      await postDbReport(client, stats, 'manual');
      await interaction.editReply({
        embeds: [new EmbedBuilder()
          .setTitle('🛠️ Manual DB Sync Complete')
          .setDescription('All tables verified. Status channel updated.')
          .addFields(
            { name: '🎁 Gift Cards', value: `${stats.available_cards} available / ${stats.total_gift_cards} total`, inline: true },
            { name: '💳 Transactions', value: `${stats.total_transactions} total | ${stats.pending_transactions} pending`, inline: true }
          )
          .setColor(0x00FF7F).setTimestamp().setFooter({ text: `Triggered by ${interaction.user.tag}` })]
      });
      return;
    }

    // ---- /store ----
    if (interaction.isChatInputCommand() && interaction.commandName === 'store') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const embed = await buildStoreEmbed();
      const row = await buildStoreRow();
      const msg = await interaction.channel.send({ embeds: [embed], components: [row] });
      await setConfig('store_message_id', msg.id);
      await interaction.editReply({ content: '✅ Store embed posted!' });
      return;
    }

    // ---- /addcard ----
    if (interaction.isChatInputCommand() && interaction.commandName === 'addcard') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const amount    = interaction.options.getInteger('amount');
      const code      = interaction.options.getString('code').trim();
      const offerPct  = interaction.options.getInteger('offer_pct');   // null if not provided
      const offerPrice = interaction.options.getInteger('offer_price'); // null if not provided

      // ---- Process offer update ----
      let offerChanged = false;
      let newOffer = null;

      if (offerPct !== null) {
        if (offerPct === 0) {
          // Remove any existing offer for this denomination
          delete CONFIG.OFFERS[amount];
          await saveOfferToDB(amount, null);
          offerChanged = true;
        } else {
          // Calculate pay price: use explicit offer_price if given, else calculate from pct
          const calcPrice = offerPrice !== null ? offerPrice : Math.round(amount * (1 - offerPct / 100));
          newOffer = { pct: offerPct, price: calcPrice };
          CONFIG.OFFERS[amount] = newOffer;
          await saveOfferToDB(amount, newOffer);
          offerChanged = true;
        }
      } else if (offerPrice !== null) {
        // offer_price set but no offer_pct — derive pct from price
        const pct = Math.round((1 - offerPrice / amount) * 100);
        newOffer = { pct, price: offerPrice };
        CONFIG.OFFERS[amount] = newOffer;
        await saveOfferToDB(amount, newOffer);
        offerChanged = true;
      }

      // ---- Insert card ----
      try {
        await pool.query('INSERT INTO gift_cards (amount, code) VALUES (?, ?)', [amount, code]);
        const [[{ available }]] = await pool.query(
          'SELECT COUNT(*) as available FROM gift_cards WHERE amount = ? AND is_used = 0', [amount]
        );
        const [[cfg]] = await pool.query('SELECT * FROM stock_config WHERE amount = ?', [amount]);
        await recordManualAdd(amount, interaction.user.id);

        const currentOffer = CONFIG.OFFERS[amount];
        const offerField = currentOffer
          ? `🏷️ **${currentOffer.pct}% OFF** — Pay ₹${currentOffer.price} (face value ₹${amount})`
          : '—  No offer (sold at face value)';
        const offerStatusLine = offerChanged
          ? (newOffer
              ? `\n✅ **Offer updated:** ${newOffer.pct}% OFF → Pay ₹${newOffer.price}`
              : '\n🚫 **Offer removed** — sold at face value ₹' + amount)
          : '';

        await interaction.editReply({
          embeds: [new EmbedBuilder().setTitle('✅ Gift Card Added')
            .setDescription(`Card added to inventory.${offerStatusLine}`)
            .addFields(
              { name: '💰 Face Value', value: `₹${amount}`, inline: true },
              { name: '🎁 Code', value: `\`${code}\``, inline: true },
              { name: '📦 Available Codes', value: `${available}`, inline: true },
              { name: '🏷️ Current Offer', value: offerField, inline: false },
              { name: '📊 Stock Progress', value: `\`${stockBar(cfg.sold_count, cfg.max_stock)}\``, inline: false }
            )
            .setColor(0x00FF00).setTimestamp()]
        });
        await logAction('CARD_ADDED', interaction.user.id, `₹${amount}: ${code}${offerChanged ? ` | Offer: ${newOffer ? newOffer.pct + '%' : 'removed'}` : ''}`);
        await postOrUpdateDashboard(client, true);
        await postOrUpdateStore(client);
      } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return interaction.editReply({
          embeds: [new EmbedBuilder().setTitle('❌ Duplicate Code').setDescription('This code already exists.').setColor(0xFF0000)]
        });
        throw err;
      }
      return;
    }

    // ---- /stock ----
    if (interaction.isChatInputCommand() && interaction.commandName === 'stock') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      // Run a fresh reconciliation so numbers are always accurate
      const reconData = await reconcileStockFromDB().catch(() => null);
      const embed = new EmbedBuilder()
        .setTitle('📦 Gift Card Stock — Live SQL Report')
        .setDescription('Stock counts read **directly from the database** and reconciled with tracking config.')
        .setColor(0x5865F2).setTimestamp();

      let totalAvail = 0, totalUsed = 0, totalCodes = 0;

      for (const amt of CONFIG.PACKAGES) {
        const r = reconData ? reconData.find(x => x.amount === amt) : null;
        const s = r || await getStockStatus(amt);
        const offer = CONFIG.OFFERS[amt];
        const offerStr = offer ? ` 🏷️ ${offer.pct}% OFF (₹${offer.price})` : '';

        const avail   = r ? r.avail_codes : (s.available_codes ?? s.remaining);
        const used    = r ? r.used_codes  : s.sold_count;
        const total   = r ? r.total_codes : (avail + used);
        const maxS    = r ? r.max_stock   : s.max_stock;
        const drifted = r ? r.drifted     : false;

        const statusIcon = avail === 0 ? '🔴' : avail <= (CONFIG.LOW_STOCK_THRESHOLD) ? '🟡' : '🟢';
        const statusTxt  = avail === 0 ? 'SOLD OUT' : avail <= CONFIG.LOW_STOCK_THRESHOLD ? `LOW STOCK` : 'In Stock';

        embed.addFields({
          name: `₹${amt} Package${offerStr}`,
          value: [
            `${statusIcon} **${statusTxt}** — ${avail} of ${total} codes available`,
            `\`${stockBar(used, Math.max(total, 1))}\``,
            `🗄️ DB: **${total}** total | **${avail}** unused | **${used}** used`,
            `⚙️ Config limit: **${maxS}**${drifted ? ' ⚠️ *drift corrected*' : ''}`
          ].join('\n'),
          inline: false
        });

        totalAvail += avail;
        totalUsed  += used;
        totalCodes += total;
      }

      embed.setFooter({ text: `SQL Total: ${totalCodes} codes | ${totalAvail} available | ${totalUsed} used | Synced ${new Date().toLocaleString('en-IN')}` });
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ---- /syncstock ----
    if (interaction.isChatInputCommand() && interaction.commandName === 'syncstock') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const reconData = await reconcileStockFromDB().catch(err => {
        console.error('[SYNCSTOCK]', err.message);
        return null;
      });

      if (!reconData) {
        return interaction.editReply({
          embeds: [new EmbedBuilder().setTitle('❌ Sync Failed').setDescription('Could not connect to database.').setColor(0xFF0000)]
        });
      }

      const drifted = reconData.filter(s => s.drifted);
      const embed = new EmbedBuilder()
        .setTitle('🔄 SQL → Discord Stock Sync Complete')
        .setDescription(
          drifted.length > 0
            ? `✅ Reconciliation done. **${drifted.length}** package(s) had drift and were corrected.`
            : '✅ All packages are in sync — no drift detected.'
        )
        .setColor(0x00FF7F).setTimestamp();

      for (const r of reconData) {
        const offer = CONFIG.OFFERS[r.amount];
        const offerStr = offer ? ` 🏷️ ${offer.pct}% OFF` : '';
        const statusIcon = r.is_sold_out ? '🔴' : r.is_low_stock ? '🟡' : '🟢';
        embed.addFields({
          name: `₹${r.amount}${offerStr}`,
          value: [
            `${statusIcon} **${r.avail_codes}** available / **${r.total_codes}** total in DB`,
            r.drifted ? `⚠️ Drift fixed: sold_count corrected to **${r.used_codes}**` : `✅ In sync`
          ].join('\n'),
          inline: true
        });
      }

      await interaction.editReply({ embeds: [embed] });

      // Refresh Discord embeds to reflect corrected stock
      await postOrUpdateDashboard(client, true);
      await postOrUpdateStore(client);
      await logAction('SYNCSTOCK', interaction.user.id, `Manual SQL sync — ${drifted.length} drift(s) corrected`);
      return;
    }

    // ---- /setstock ----
    if (interaction.isChatInputCommand() && interaction.commandName === 'setstock') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const amount = interaction.options.getInteger('amount');
      const newLimit = interaction.options.getInteger('limit');
      const [[prev]] = await pool.query('SELECT * FROM stock_config WHERE amount = ?', [amount]);
      await pool.query('UPDATE stock_config SET max_stock = ?, updated_at = NOW() WHERE amount = ?', [newLimit, amount]);
      await recordRestock(amount, newLimit, interaction.user.id, `Limit changed from ${prev.max_stock} to ${newLimit}`);
      await interaction.editReply({
        embeds: [new EmbedBuilder().setTitle('⚙️ Stock Limit Updated')
          .addFields(
            { name: '💰 Package', value: `₹${amount}`, inline: true },
            { name: '📉 Old Limit', value: `${prev.max_stock}`, inline: true },
            { name: '📈 New Limit', value: `${newLimit}`, inline: true }
          )
          .setColor(0x5865F2).setTimestamp()]
      });
      await logAction('STOCK_LIMIT_CHANGED', interaction.user.id, `₹${amount}: ${prev.max_stock} → ${newLimit}`);
      await postOrUpdateDashboard(client, true);
      await postOrUpdateStore(client);
      return;
    }

    // ---- /restockall ----
    if (interaction.isChatInputCommand() && interaction.commandName === 'restockall') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      for (const amt of CONFIG.PACKAGES) {
        const [[prev]] = await pool.query('SELECT * FROM stock_config WHERE amount = ?', [amt]);
        await pool.query('UPDATE stock_config SET sold_count = 0, last_restocked = NOW() WHERE amount = ?', [amt]);
        await pool.query(`
          INSERT INTO stock_history (amount, event_type, quantity_change, sold_count_after, max_stock_after, performed_by, notes)
          VALUES (?, 'restock', ?, 0, ?, ?, 'Full restock — sold count reset to 0')
        `, [amt, prev.sold_count, prev.max_stock, interaction.user.id]);
      }

      const embed = new EmbedBuilder().setTitle('📥 All Packages Restocked!')
        .setDescription('Sold counts reset to 0 for all packages. Stock limits unchanged.')
        .setColor(0x00FF00).setTimestamp();

      for (const amt of CONFIG.PACKAGES) {
        const s = await getStockStatus(amt);
        const avail = s ? s.remaining : 0;
        const total = s ? s.total_codes : 0;
        embed.addFields({ name: `₹${amt}`, value: `\`${stockBar(0, Math.max(total, 1))}\` — **${avail}** codes in DB`, inline: true });
      }

      await interaction.editReply({ embeds: [embed] });
      await logAction('RESTOCK_ALL', interaction.user.id, 'All packages restocked');
      await postOrUpdateDashboard(client, true);
      await postOrUpdateStore(client);
      return;
    }

    // ---- /transactions ----
    if (interaction.isChatInputCommand() && interaction.commandName === 'transactions') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const limit = interaction.options.getInteger('limit') || 10;
      const [rows] = await pool.query('SELECT * FROM transactions ORDER BY created_at DESC LIMIT ?', [limit]);
      const embed = new EmbedBuilder().setTitle('📊 Recent Transactions').setColor(0x5865F2).setTimestamp()
        .setFooter({ text: `Showing last ${limit} transactions` });
      if (rows.length === 0) {
        embed.setDescription('No transactions yet.');
      } else {
        const icons = { pending: '⏳', approved: '✅', rejected: '❌', captured: '💳' };
        rows.forEach(r => {
          const paidInfo = r.paid_amount && r.paid_amount !== r.amount ? ` (Paid ₹${r.paid_amount})` : '';
          embed.addFields({
            name: `${icons[r.status] || '?'} #${r.id} · ₹${r.amount}${paidInfo} · ${r.status.toUpperCase()}`,
            value: `<@${r.user_id}> · UPI: \`${r.upi_txn || 'N/A'}\` · App: \`${r.payment_app || 'N/A'}\` · ${new Date(r.created_at).toLocaleString('en-IN')}`,
            inline: false
          });
        });
      }
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ---- DROPDOWN: Amount Selection ----
    if (interaction.isStringSelectMenu() && interaction.customId === 'select_amount') {
      // Defer immediately — DB queries below can exceed Discord's 3-second window
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const amount = parseInt(interaction.values[0]);
      const s = await getStockStatus(amount);

      if (s && s.is_sold_out) {
        return interaction.editReply({
          embeds: [new EmbedBuilder().setTitle('🔴 Package Sold Out')
            .setDescription(`The **₹${amount}** gift card is currently **sold out** — no codes available in stock.\n\nPlease check back later or contact support.`)
            .setColor(0xFF0000)]
        });
      }

      if (await hasPendingPayment(interaction.user.id)) {
        return interaction.editReply({
          embeds: [new EmbedBuilder().setTitle('⚠️ Pending Payment')
            .setDescription('You already have a payment waiting for review. Please wait before making a new purchase.')
            .setColor(0xFFA500)]
        });
      }

      const offer = CONFIG.OFFERS[amount];
      const payPrice = getPayPrice(amount);
      const lowStockWarn = s && s.is_low_stock ? `\n\n⚠️ **Only ${s.remaining} left — grab it fast!**` : '';

      let priceDesc = `**Amount to Pay: ₹${payPrice}**`;
      if (offer) {
        priceDesc = `~~₹${amount}~~ → **₹${payPrice}** 🎉 **${offer.pct}% OFF!**\nYou save ₹${amount - payPrice}!`;
      }

      const embed = new EmbedBuilder()
        .setTitle(`🎁 ₹${amount} Gift Card — Payment`)
        .setDescription(
          `${priceDesc}${lowStockWarn}\n\n` +
          `**Step 1:** Pay via **UPI** or **PayPal** (your choice)\n` +
          `**Step 2:** Click **"I've Paid — Submit Details"** below\n` +
          `**Step 3:** Fill in your transaction details\n` +
          `**Step 4:** Wait for admin approval — gift card sent via DM`
        )
        .addFields(
          { name: '📱 UPI ID', value: `\`\`\`${CONFIG.UPI_ID}\`\`\``, inline: true },
          { name: '🅿️ PayPal', value: `\`\`\`${CONFIG.PAYPAL_ID}\`\`\``, inline: true },
          { name: '💸 Amount to Pay', value: `**₹${payPrice}**${offer ? ` (${offer.pct}% OFF on ₹${amount} face value)` : ''}`, inline: false }
        )
        .setImage(CONFIG.QR_IMAGE)
        .setColor(offer ? 0x00FF88 : (s && s.is_low_stock ? 0xFFA500 : 0x00BFFF))
        .setTimestamp()
        .setFooter({ text: `₹${amount} Gift Card | Pay ₹${payPrice} | ${s ? s.remaining : '?'} remaining` });

      await interaction.editReply({
        embeds: [embed],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`manual_${amount}`)
              .setLabel("I've Paid — Submit Details")
              .setEmoji('📝')
              .setStyle(ButtonStyle.Success)
          )
        ]
      });

      await logAction('AMOUNT_SELECTED', interaction.user.id, `₹${amount} (pay ₹${payPrice})`);
    }

    // ---- BUTTON: Manual → Modal ----
    if (interaction.isButton() && interaction.customId.startsWith('manual_')) {
      const amount = interaction.customId.split('_')[1];
      const payPrice = getPayPrice(parseInt(amount));

      const modal = new ModalBuilder()
        .setCustomId(`manual_modal_${amount}`)
        .setTitle(`Payment Details — ₹${amount} Card (Pay ₹${payPrice})`);

      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('upi_txn')
            .setLabel('UPI Transaction ID *')
            .setPlaceholder('e.g. 123456789012 (from your payment app)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(100)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('sender_name')
            .setLabel('Sender Name *')
            .setPlaceholder('Name shown in your UPI payment app')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(100)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('payment_app')
            .setLabel('Payment App / Gateway *')
            .setPlaceholder('GPay / PhonePe / Paytm / BHIM / Other')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(50)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('gateway_txn')
            .setLabel('Gateway / Reference ID (optional)')
            .setPlaceholder('Extra reference ID from your app, if any')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setMaxLength(100)
        )
      );

      await interaction.showModal(modal);
    }

    // ---- MODAL: Manual Submit ----
    if (interaction.isModalSubmit() && interaction.customId.startsWith('manual_modal_')) {
      // Defer immediately — remote DB operations easily exceed Discord's 3-second window.
      // This keeps the interaction alive for up to 15 minutes so the admin notification
      // is always sent regardless of how long the DB insert takes.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const amount = parseInt(interaction.customId.split('_')[2]);
      const payPrice = getPayPrice(amount);
      const offer = CONFIG.OFFERS[amount];

      const upiTxn     = interaction.fields.getTextInputValue('upi_txn').trim();
      const sender     = interaction.fields.getTextInputValue('sender_name').trim();
      const payApp     = interaction.fields.getTextInputValue('payment_app').trim();
      const gatewayTxn = interaction.fields.getTextInputValue('gateway_txn').trim() || null;

      if (await isDuplicateTxn(upiTxn)) return interaction.editReply({
        embeds: [new EmbedBuilder().setTitle('❌ Duplicate Transaction')
          .setDescription('This UPI Transaction ID has already been submitted.')
          .setColor(0xFF0000)]
      });

      if (await hasPendingPayment(interaction.user.id)) return interaction.editReply({
        embeds: [new EmbedBuilder().setTitle('⚠️ Pending Payment')
          .setDescription('You already have a payment under review. Please wait.')
          .setColor(0xFFA500)]
      });

      const [result] = await pool.query(
        'INSERT INTO transactions (user_id, amount, paid_amount, upi_txn, sender, payment_app, gateway_txn, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [interaction.user.id, amount, payPrice, upiTxn, sender, payApp, gatewayTxn, 'pending']
      );
      const txnId = result.insertId;

      // Build admin notification payload
      const offerInfo = offer ? `\n> 🏷️ **${offer.pct}% Offer Applied** — Face Value ₹${amount}, Paid ₹${payPrice}` : '';
      const adminEmbed = new EmbedBuilder()
        .setTitle('📋 Manual Payment — Review Required')
        .setDescription(`New payment submission needs approval.${offerInfo}`)
        .addFields(
          { name: '👤 Discord User', value: `<@${interaction.user.id}> (${interaction.user.tag})`, inline: false },
          { name: '🎁 Gift Card', value: `₹${amount}`, inline: true },
          { name: '💸 Amount Paid', value: `₹${payPrice}`, inline: true },
          { name: '🆔 Ref', value: `#${txnId}`, inline: true },
          { name: '📝 UPI Txn ID', value: `\`${upiTxn}\``, inline: true },
          { name: '👤 Sender Name', value: sender, inline: true },
          { name: '📱 Payment App', value: payApp, inline: true }
        )
        .setColor(0xFFA500).setTimestamp()
        .setFooter({ text: `Transaction #${txnId} • Submitted by ${interaction.user.tag}` });

      if (gatewayTxn) adminEmbed.addFields({ name: '🔗 Gateway / Ref ID', value: `\`${gatewayTxn}\``, inline: false });

      const adminComponents = [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`approve_${txnId}_${interaction.user.id}_${amount}`)
          .setLabel('✅ Approve & Deliver')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`reject_${txnId}_${interaction.user.id}`)
          .setLabel('❌ Reject')
          .setStyle(ButtonStyle.Danger)
      )];

      // Try to send admin notification — with one automatic retry after 3 seconds.
      // If BOTH attempts fail, roll back the transaction so the user is NOT stuck.
      let adminNotified = false;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const ch = await client.channels.fetch(CONFIG.STATUS_CHANNEL_ID);
          const adminMsg = await ch.send({ embeds: [adminEmbed], components: adminComponents });
          await pool.query('UPDATE transactions SET admin_msg_id = ? WHERE id = ?', [adminMsg.id, txnId]).catch(() => {});
          adminNotified = true;
          break;
        } catch (err) {
          console.error(`[ADMIN NOTIFY] Attempt ${attempt} failed:`, err.message);
          if (attempt === 1) await new Promise(r => setTimeout(r, 3000)); // wait 3s then retry
        }
      }

      if (!adminNotified) {
        // Admin panel could not be delivered — roll back so user is not stuck
        await pool.query('DELETE FROM transactions WHERE id = ?', [txnId]).catch(() => {});
        return interaction.editReply({
          embeds: [new EmbedBuilder()
            .setTitle('⚠️ Submission Failed — Please Retry')
            .setDescription(
              'We could not deliver your payment request to the admin panel due to a temporary error.\n\n' +
              '**Your payment has NOT been recorded** — you are free to try submitting again.\n' +
              'If this keeps happening, please contact support.'
            )
            .setColor(0xFF4500).setTimestamp()]
        });
      }

      // Admin was notified — confirm to user
      await interaction.editReply({
        embeds: [new EmbedBuilder()
          .setTitle('✅ Payment Submitted for Review')
          .setDescription('Your payment details have been submitted.\nAn admin will verify and deliver your gift card via DM.')
          .addFields(
            { name: '🆔 Reference', value: `#${txnId}`, inline: true },
            { name: '🎁 Gift Card', value: `₹${amount}`, inline: true },
            { name: '💸 Amount Paid', value: `₹${payPrice}${offer ? ` (${offer.pct}% OFF)` : ''}`, inline: true },
            { name: '📱 UPI Txn ID', value: `\`${upiTxn}\``, inline: false },
            { name: '⏰ Approval Window', value: 'Admins have **12 hours** to approve or reject.\nIf no action is taken, your request will be automatically cancelled and you will be notified via DM.', inline: false }
          )
          .setColor(0x00FF00).setTimestamp()
          .setFooter({ text: 'Please keep your UPI transaction ID safe' })]
      });

      await logAction('MANUAL_SUBMITTED', interaction.user.id, `UPI: ${upiTxn}, ₹${amount} (paid ₹${payPrice})`);
      await sendTransactionLog(client, {
        event:          'SUBMITTED',
        txnId:          txnId,
        userId:         interaction.user.id,
        userTag:        interaction.user.tag,
        giftCardValue:  amount,
        paidAmount:     payPrice,
        offerApplied:   offer ? `${offer.pct}% OFF (save ₹${amount - payPrice})` : null,
        upiTxnId:       upiTxn,
        senderName:     sender,
        paymentApp:     payApp,
        gatewayRef:     gatewayTxn,
        paymentId:      null,
        status:         'pending'
      });
      await postOrUpdateDashboard(client, true);
    }

    // ---- BUTTON: Approve ----
    if (interaction.isButton() && interaction.customId.startsWith('approve_')) {
      const parts = interaction.customId.split('_');
      const [, txnId, userId, amountStr] = parts;
      const amount = parseInt(amountStr);

      const isAdmin = CONFIG.SUPER_USER_IDS.includes(interaction.user.id) ||
                      interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
                      CONFIG.ADMIN_ROLE_IDS.some(id => interaction.member.roles.cache.has(id));
      if (!isAdmin) return interaction.reply({
        embeds: [new EmbedBuilder().setTitle('❌ Access Denied').setDescription('Admins only.').setColor(0xFF0000)],
        flags: MessageFlags.Ephemeral
      });

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await pool.query('UPDATE transactions SET status = "approved" WHERE id = ?', [txnId]);
      const delivered = await deliverGiftCard(client, userId, amount, `manual-${txnId}`);

      await interaction.editReply({
        embeds: [new EmbedBuilder()
          .setTitle(delivered ? '✅ Approved & Gift Card Delivered' : '⚠️ Approved — No Stock')
          .setDescription(delivered
            ? `₹${amount} gift card delivered to <@${userId}> via DM.`
            : `No ₹${amount} codes available. A support ticket was created for <@${userId}>.`)
          .setColor(delivered ? 0x00FF00 : 0xFFA500)]
      });

      try {
        const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
          .setColor(0x00FF00).setTitle('✅ Payment Approved & Delivered')
          .setFooter({ text: `Approved by ${interaction.user.tag} • ${new Date().toLocaleString('en-IN')}` });
        await interaction.message.edit({ embeds: [updatedEmbed], components: [] });
      } catch (_) {}

      await logAction('APPROVED', interaction.user.id, `Txn #${txnId}, User: ${userId}, ₹${amount}`);

      try {
        const [[txnRow]] = await pool.query('SELECT * FROM transactions WHERE id = ?', [txnId]);
        const approvedUser = await client.users.fetch(userId).catch(() => null);
        const offer = CONFIG.OFFERS[amount];
        await sendTransactionLog(client, {
          event:         'APPROVED',
          txnId:         txnId,
          userId:        userId,
          userTag:       approvedUser?.tag || userId,
          giftCardValue: amount,
          paidAmount:    txnRow?.paid_amount || amount,
          offerApplied:  offer ? `${offer.pct}% OFF (save ₹${amount - offer.price})` : null,
          upiTxnId:      txnRow?.upi_txn,
          senderName:    txnRow?.sender,
          paymentApp:    txnRow?.payment_app,
          gatewayRef:    txnRow?.gateway_txn,
          paymentId:     txnRow?.payment_id,
          status:        'approved',
          approvedBy:    interaction.user.tag,
          delivered:     delivered
        });
      } catch (_) {}

      await postOrUpdateDashboard(client, true);
      await postOrUpdateStore(client);
    }

    // ---- BUTTON: Reject ----
    if (interaction.isButton() && interaction.customId.startsWith('reject_')) {
      const [, txnId, userId] = interaction.customId.split('_');

      const isAdmin = CONFIG.SUPER_USER_IDS.includes(interaction.user.id) ||
                      interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
                      CONFIG.ADMIN_ROLE_IDS.some(id => interaction.member.roles.cache.has(id));
      if (!isAdmin) return interaction.reply({
        embeds: [new EmbedBuilder().setTitle('❌ Access Denied').setDescription('Admins only.').setColor(0xFF0000)],
        flags: MessageFlags.Ephemeral
      });

      // Defer immediately — DB update + DM + message edit can exceed Discord's 3-second window
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      await pool.query('UPDATE transactions SET status = "rejected" WHERE id = ?', [txnId]);

      try {
        const user = await client.users.fetch(userId);
        await user.send({
          embeds: [new EmbedBuilder().setTitle('❌ Payment Rejected')
            .setDescription(`Your payment (Ref #${txnId}) was rejected.\nContact support if you believe this is an error.`)
            .setColor(0xFF0000).setTimestamp()]
        });
      } catch (_) {}

      try {
        const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
          .setColor(0xFF0000).setTitle('❌ Payment Rejected')
          .setFooter({ text: `Rejected by ${interaction.user.tag} • ${new Date().toLocaleString('en-IN')}` });
        await interaction.message.edit({ embeds: [updatedEmbed], components: [] });
      } catch (_) {}

      await interaction.editReply({
        embeds: [new EmbedBuilder().setTitle('❌ Payment Rejected')
          .setDescription(`Transaction #${txnId} rejected. User has been notified.`)
          .setColor(0xFF0000)]
      });
      await logAction('REJECTED', interaction.user.id, `Txn #${txnId}, User: ${userId}`);

      try {
        const [[txnRow]] = await pool.query('SELECT * FROM transactions WHERE id = ?', [txnId]);
        const rejectedUser = await client.users.fetch(userId).catch(() => null);
        const offer = txnRow ? CONFIG.OFFERS[txnRow.amount] : null;
        await sendTransactionLog(client, {
          event:         'REJECTED',
          txnId:         txnId,
          userId:        userId,
          userTag:       rejectedUser?.tag || userId,
          giftCardValue: txnRow?.amount,
          paidAmount:    txnRow?.paid_amount || txnRow?.amount,
          offerApplied:  offer ? `${offer.pct}% OFF (save ₹${txnRow.amount - offer.price})` : null,
          upiTxnId:      txnRow?.upi_txn,
          senderName:    txnRow?.sender,
          paymentApp:    txnRow?.payment_app,
          gatewayRef:    txnRow?.gateway_txn,
          paymentId:     txnRow?.payment_id,
          status:        'rejected',
          approvedBy:    interaction.user.tag,
          delivered:     false
        });
      } catch (_) {}

      await postOrUpdateDashboard(client, true);
    }

  } catch (err) {
    // Suppress "already acknowledged" errors — these are harmless race conditions
    if (err?.code === 40060) return;
    console.error('[INTERACTION ERROR]', err);
    try {
      const replyFn = interaction.deferred || interaction.replied
        ? interaction.editReply.bind(interaction)
        : interaction.reply.bind(interaction);
      await replyFn({
        embeds: [new EmbedBuilder().setTitle('❌ Error').setDescription('An unexpected error occurred. Please try again.').setColor(0xFF0000)],
        flags: MessageFlags.Ephemeral
      });
    } catch (_) {}
  }
});

// ========================================
// EXPRESS WEBHOOK SERVER
// (Primary: manual UPI | Future: Razorpay & Cashfree)
// ========================================

const app = express();
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

app.get('/', (req, res) => res.json({
  status: 'online',
  bot: client.user?.tag || 'starting...',
  db: dbConnected,
  uptime: `${Math.floor(process.uptime())}s`,
  payment_modes: ['manual_upi', 'razorpay (future)', 'cashfree (future)']
}));

app.get('/health', (req, res) => res.json({ ok: true, db: dbConnected, bot: !!client.user }));

app.get('/webhook/success', (req, res) => res.send(`<!DOCTYPE html><html><head><title>Payment Successful</title>
  <style>body{background:#1a1a2e;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;margin:0}
  .box{text-align:center;padding:40px;background:#16213e;border-radius:16px;border:1px solid #00ff88}
  h1{color:#00ff88}p{color:#ccc}</style></head>
  <body><div class="box"><div style="font-size:64px">✅</div><h1>Payment Successful!</h1>
  <p>Your gift card will be delivered to your Discord DMs shortly.</p>
  <p style="color:#888;margin-top:16px">You can close this window.</p></div></body></html>`));

// Razorpay webhook (future use)
app.post('/webhook/razorpay', async (req, res) => {
  try {
    const payload = req.body;
    console.log(`[RAZORPAY WEBHOOK] Event: ${payload.event}`);

    if (payload.event === 'payment.captured' || payload.event === 'payment_link.paid') {
      const entity = payload.event === 'payment_link.paid'
        ? payload.payload.payment_link.entity : payload.payload.payment.entity;
      const userId = entity.notes?.discord_user_id;
      const amount = parseInt(entity.notes?.amount || Math.round(entity.amount / 100));
      const paymentId = entity.id || `rzp_${Date.now()}`;
      if (!userId) return res.status(200).json({ status: 'no user id' });

      await pool.query(
        'INSERT INTO transactions (user_id, amount, paid_amount, payment_id, status) VALUES (?, ?, ?, ?, ?)',
        [userId, amount, Math.round(entity.amount / 100), paymentId, 'captured']
      );
      await deliverGiftCard(client, userId, amount, paymentId);
      await postOrUpdateDashboard(client, true);
      await postOrUpdateStore(client);
      await logAction('RAZORPAY_CAPTURED', userId, `₹${amount}, Payment: ${paymentId}`);
      const rzpUser = await client.users.fetch(userId).catch(() => null);
      const rzpOffer = CONFIG.OFFERS[amount];
      await sendTransactionLog(client, {
        event:         'CAPTURED',
        txnId:         `rzp-${paymentId}`,
        userId:        userId,
        userTag:       rzpUser?.tag || userId,
        giftCardValue: amount,
        paidAmount:    Math.round(entity.amount / 100),
        offerApplied:  rzpOffer ? `${rzpOffer.pct}% OFF (save ₹${amount - rzpOffer.price})` : null,
        upiTxnId:      null,
        senderName:    null,
        paymentApp:    'Razorpay',
        gatewayRef:    null,
        paymentId:     paymentId,
        status:        'captured'
      });
    }
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('[RAZORPAY WEBHOOK ERROR]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Cashfree webhook (future use)
app.post('/webhook/cashfree', async (req, res) => {
  try {
    console.log('[CASHFREE WEBHOOK] Received:', req.body?.type || 'unknown event');
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('[CASHFREE WEBHOOK ERROR]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

app.listen(CONFIG.WEBHOOK_PORT, '0.0.0.0', () =>
  console.log(`[SERVER] Webhook server running on port ${CONFIG.WEBHOOK_PORT}`)
);

// ========================================
// 12-HOUR EXPIRY CHECKER
// ========================================

const EXPIRY_HOURS = 12;
const EXPIRY_CHECK_INTERVAL = 10 * 60 * 1000; // check every 10 minutes

async function checkAndExpireTransactions(discordClient) {
  if (!pool) return;
  try {
    // Expire if:
    //   (a) pending for > 12 hours (normal expiry — admin saw it but took no action), OR
    //   (b) pending for > 1 hour AND admin_msg_id IS NULL (admin panel was never delivered)
    const [expired] = await pool.query(`
      SELECT id, user_id, amount, paid_amount, upi_txn, admin_msg_id
      FROM transactions
      WHERE status = 'pending'
        AND (
          created_at <= NOW() - INTERVAL ${EXPIRY_HOURS} HOUR
          OR (admin_msg_id IS NULL AND created_at <= NOW() - INTERVAL 1 HOUR)
        )
    `);

    for (const txn of expired) {
      try {
        // Mark as expired in DB
        await pool.query("UPDATE transactions SET status = 'expired' WHERE id = ?", [txn.id]);

        // DM the user — notify them to resubmit
        const noPanelDelivered = !txn.admin_msg_id;
        try {
          const user = await discordClient.users.fetch(txn.user_id);
          await user.send({
            embeds: [new EmbedBuilder()
              .setTitle('⏰ Payment Request Expired')
              .setDescription(
                noPanelDelivered
                  ? `Your payment submission (Ref **#${txn.id}**) for a ₹${txn.amount} gift card could **not be delivered to the admin panel** and has been automatically cancelled.\n\n` +
                    `**Your pending status has been cleared** — you can submit again right now.\n\n` +
                    `We apologize for the inconvenience! Please try resubmitting in the store channel.`
                  : `Your payment submission (Ref **#${txn.id}**) for a ₹${txn.amount} gift card has **expired** after ${EXPIRY_HOURS} hours without admin action.\n\n` +
                    `**What to do next:**\n` +
                    `• If you already paid, please resubmit your transaction details in the store channel.\n` +
                    `• If you have not paid yet, simply make a new purchase when ready.\n\n` +
                    `We apologize for the inconvenience!`
              )
              .addFields(
                { name: '🆔 Reference', value: `#${txn.id}`, inline: true },
                { name: '🎁 Gift Card', value: `₹${txn.amount}`, inline: true },
                { name: '📱 UPI Txn ID', value: txn.upi_txn ? `\`${txn.upi_txn}\`` : '—', inline: true }
              )
              .setColor(0xFF8C00)
              .setTimestamp()
              .setFooter({ text: 'You can resubmit at any time from the store channel.' })]
          });
        } catch (_) {}

        // Update the admin panel message — remove buttons, mark as expired
        try {
          const adminCh = await discordClient.channels.fetch(CONFIG.STATUS_CHANNEL_ID);
          if (txn.admin_msg_id) {
            const adminMsg = await adminCh.messages.fetch(txn.admin_msg_id).catch(() => null);
            if (adminMsg) {
              const expiredEmbed = EmbedBuilder.from(adminMsg.embeds[0])
                .setColor(0x888888)
                .setTitle('⏰ Payment Request Expired (No Action Taken)')
                .setFooter({ text: `Auto-expired after ${EXPIRY_HOURS}h — ${new Date().toLocaleString('en-IN')}` });
              await adminMsg.edit({ embeds: [expiredEmbed], components: [] });
            }
          }
        } catch (_) {}

        await logAction('EXPIRED', txn.user_id, `Txn #${txn.id}, ₹${txn.amount}, UPI: ${txn.upi_txn}`);
        console.log(`[EXPIRY] Transaction #${txn.id} expired after ${EXPIRY_HOURS}h`);
      } catch (err) {
        console.error(`[EXPIRY] Error handling txn #${txn.id}:`, err.message);
      }
    }

    if (expired.length > 0) {
      await postOrUpdateDashboard(discordClient, true).catch(() => {});
    }
  } catch (err) {
    console.error('[EXPIRY CHECKER]', err.message);
  }
}

function startExpiryChecker(discordClient) {
  console.log(`[EXPIRY] Checker started — auto-expire pending transactions after ${EXPIRY_HOURS}h`);
  // Run immediately on startup, then on interval
  checkAndExpireTransactions(discordClient);
  setInterval(() => checkAndExpireTransactions(discordClient), EXPIRY_CHECK_INTERVAL);
}

// ========================================
// BOT LOGIN + SHUTDOWN
// ========================================

client.login(CONFIG.BOT_TOKEN).catch(err => {
  console.error('[LOGIN ERROR]', err.message);
  process.exit(1);
});

async function shutdown() {
  console.log('[BOT] Shutting down...');
  await postOrUpdateDashboard(client, false).catch(() => {});
  client.destroy();
  if (pool) await pool.end().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', err => console.error('[UNHANDLED REJECTION]', err));
process.on('uncaughtException', err => console.error('[UNCAUGHT EXCEPTION]', err));
