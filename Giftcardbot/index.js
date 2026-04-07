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
  REST,
  Routes,
  SlashCommandBuilder,
  ActivityType
} = require('discord.js');
const mysql = require('mysql2/promise');
const express = require('express');
const crypto = require('crypto');
const Razorpay = require('razorpay');

// ========================================
// CONFIGURATION
// ========================================

const CONFIG = {
  BOT_TOKEN: process.env.DISCORD_BOT_TOKEN || 'YOUR_BOT_TOKEN',
  DB: {
    host: '104.234.180.242',
    user: 'u82822_PZ9oYvFPp2',
    password: process.env.DB_PASSWORD || 'CHANGE_THIS_PASSWORD',
    database: 's82822_vipshop',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 30000
  },
  CHANNEL_ID: '1490955092541575180',      // Store channel (store embed only)
  STATUS_CHANNEL_ID: '1490971944290488363', // Admin channel (dashboard + DB reports + approval notifications)
  QR_IMAGE: 'https://r2.fivemanage.com/Ys9r66xkAMyCtiby4q1Oj/QRZ.png',
  UPI_ID: 'davidbarma19@okicici',
  PAYPAL: 'jarmantyson@gmail.com',
  RAZORPAY: {
    key_id: process.env.RAZORPAY_KEY_ID || 'YOUR_KEY',
    key_secret: process.env.RAZORPAY_KEY_SECRET || 'YOUR_SECRET'
  },
  ADMIN_ROLE: 'Admin',
  WEBHOOK_PORT: process.env.PORT || 3001,
  TEBEX_URL: 'https://projectirace.tebex.com',
  DB_RETRY_DELAY: 5000,
  DB_MAX_RETRIES: 10,
  DEFAULT_MAX_STOCK: 10,
  LOW_STOCK_THRESHOLD: 3,
  PACKAGES: [100, 250, 500]
};

// ========================================
// SLASH COMMAND DEFINITIONS
// ========================================

const commands = [
  new SlashCommandBuilder()
    .setName('addcard')
    .setDescription('Add a gift card to inventory (Admin only)')
    .addIntegerOption(opt =>
      opt.setName('amount').setDescription('Gift card amount').setRequired(true)
        .addChoices({ name: '₹100', value: 100 }, { name: '₹250', value: 250 }, { name: '₹500', value: 500 })
    )
    .addStringOption(opt => opt.setName('code').setDescription('Gift card code').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('stock')
    .setDescription('Check gift card stock with limits (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('setstock')
    .setDescription('Set max stock limit for a package (Admin only)')
    .addIntegerOption(opt =>
      opt.setName('amount').setDescription('Package amount').setRequired(true)
        .addChoices({ name: '₹100', value: 100 }, { name: '₹250', value: 250 }, { name: '₹500', value: 500 })
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
    // Gift cards table
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

    // Transactions table
    await conn.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        amount INT NOT NULL,
        payment_id VARCHAR(255) DEFAULT NULL,
        upi_txn VARCHAR(255) DEFAULT NULL,
        sender VARCHAR(255) DEFAULT NULL,
        gateway_txn VARCHAR(255) DEFAULT NULL,
        status ENUM('pending','approved','rejected','captured') DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Action logs
    await conn.query(`
      CREATE TABLE IF NOT EXISTS action_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        action VARCHAR(255) NOT NULL,
        user_id VARCHAR(255) DEFAULT NULL,
        details TEXT DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Bot config (stores message IDs, settings)
    await conn.query(`
      CREATE TABLE IF NOT EXISTS bot_config (
        key_name VARCHAR(100) PRIMARY KEY,
        value TEXT DEFAULT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // Stock config — tracks max_stock, sold_count, and low_stock_threshold per package
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

    // Stock history log — keeps full record of every stock event
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

    // DB sync log — records every auto/manual sync with full stats snapshot
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

    // Seed stock_config with default limit of 10 for each package if not already set
    for (const amount of CONFIG.PACKAGES) {
      await conn.query(`
        INSERT INTO stock_config (amount, max_stock, sold_count, low_stock_threshold)
        VALUES (?, ?, 0, ?)
        ON DUPLICATE KEY UPDATE amount = amount
      `, [amount, CONFIG.DEFAULT_MAX_STOCK, CONFIG.LOW_STOCK_THRESHOLD]);
    }

    dbConnected = true;
    console.log('[DB] All tables initialized. Stock limits set to 10 per package.');
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

// ========================================
// AUTO DATABASE SYNC — records snapshot to db_sync_log
// ========================================

async function runAutoDbSync(syncType = 'scheduled', triggeredBy = 'system') {
  const conn = await pool.getConnection();
  try {
    // Re-run CREATE TABLE IF NOT EXISTS to ensure all tables exist (safe idempotent)
    const tables = [
      'gift_cards', 'transactions', 'action_logs',
      'bot_config', 'stock_config', 'stock_history', 'db_sync_log'
    ];

    // Gather a full stats snapshot
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
    console.log(`[DB SYNC] ${syncType} sync complete — ${total_gift_cards} cards, ${total_transactions} txns`);

    return { total_gift_cards, available_cards, total_transactions, pending_transactions, total_stock_events };
  } catch (err) {
    console.error('[DB SYNC ERROR]', err.message);
    return null;
  } finally {
    conn.release();
  }
}

// Get last N sync records
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

    const embed = new EmbedBuilder()
      .setTitle(`${icons[syncType] || '🔄'} Database Sync — ${syncType.charAt(0).toUpperCase() + syncType.slice(1)}`)
      .setDescription(`Auto SQL sync completed. All tables verified and records snapshot saved to \`db_sync_log\`.`)
      .addFields(
        { name: '🎁 Gift Cards', value: `Total: **${stats.total_gift_cards}** | Available: **${stats.available_cards}**`, inline: true },
        { name: '💳 Transactions', value: `Total: **${stats.total_transactions}** | Pending: **${stats.pending_transactions}**`, inline: true },
        { name: '📊 Stock Events', value: `**${stats.total_stock_events}** recorded`, inline: true },
        { name: '🗄️ Tables Verified', value: '`gift_cards` `transactions` `action_logs`\n`bot_config` `stock_config` `stock_history` `db_sync_log`', inline: false },
        { name: '📋 Recent Sync History', value: historyText, inline: false }
      )
      .setColor(0x00BFFF)
      .setTimestamp()
      .setFooter({ text: `DB Sync • ${CONFIG.DB.database} @ ${CONFIG.DB.host}` });

    // Check if there's an existing DB report message to update
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
    console.log('[DB REPORT] Posted to status channel.');
  } catch (err) {
    console.error('[DB REPORT ERROR]', err.message);
  }
}

// ========================================
// STOCK HELPERS
// ========================================

// Get stock status for a given amount
async function getStockStatus(amount) {
  const [[cfg]] = await pool.query('SELECT * FROM stock_config WHERE amount = ?', [amount]);
  if (!cfg) return null;
  const [[{ available }]] = await pool.query(
    'SELECT COUNT(*) as available FROM gift_cards WHERE amount = ? AND is_used = 0', [amount]
  );
  // Remaining = min(available card codes, slots left under limit)
  const slotsLeft = cfg.max_stock - cfg.sold_count;
  const remaining = Math.max(0, Math.min(available, slotsLeft));
  return {
    amount,
    max_stock: cfg.max_stock,
    sold_count: cfg.sold_count,
    available_codes: available,
    remaining,          // effective purchasable stock
    is_sold_out: remaining <= 0,
    is_low_stock: remaining > 0 && remaining <= cfg.low_stock_threshold,
    pct: Math.round((cfg.sold_count / cfg.max_stock) * 100)
  };
}

// Get stock for all packages at once
async function getAllStockStatus() {
  const results = {};
  for (const amt of CONFIG.PACKAGES) {
    results[amt] = await getStockStatus(amt);
  }
  return results;
}

// Record a sale in stock_config + stock_history
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

// Record a restock event
async function recordRestock(amount, newMax, performedBy, notes = '') {
  const [[prev]] = await pool.query('SELECT sold_count, max_stock FROM stock_config WHERE amount = ?', [amount]);
  await pool.query(`
    INSERT INTO stock_history (amount, event_type, quantity_change, sold_count_after, max_stock_after, performed_by, notes)
    VALUES (?, 'restock', ?, ?, ?, ?, ?)
  `, [amount, newMax - prev.max_stock, prev.sold_count, newMax, performedBy, notes || 'Stock limit updated']);
}

// Record manual card addition
async function recordManualAdd(amount, performedBy) {
  const [[cfg]] = await pool.query('SELECT sold_count, max_stock FROM stock_config WHERE amount = ?', [amount]);
  await pool.query(`
    INSERT INTO stock_history (amount, event_type, quantity_change, sold_count_after, max_stock_after, performed_by, notes)
    VALUES (?, 'manual_add', 1, ?, ?, ?, 'Admin added card manually')
  `, [amount, cfg.sold_count, cfg.max_stock, performedBy]);
}

// Build a visual stock bar (e.g. ████░░░░ 4/10)
function stockBar(sold, max) {
  const filled = Math.round((sold / max) * 10);
  const empty = 10 - filled;
  return '█'.repeat(filled) + '░'.repeat(empty) + ` ${sold}/${max} sold`;
}

// ========================================
// RAZORPAY INSTANCE
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
// DELIVER GIFT CARD (with stock tracking)
// ========================================

async function deliverGiftCard(client, userId, amount, paymentId) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Check stock limit first
    const [[cfg]] = await conn.query('SELECT * FROM stock_config WHERE amount = ? FOR UPDATE', [amount]);
    if (cfg && cfg.sold_count >= cfg.max_stock) {
      await conn.rollback();
      console.log(`[STOCK] Sold out: ₹${amount} (${cfg.sold_count}/${cfg.max_stock})`);
      const guild = client.guilds.cache.first();
      if (guild) {
        const user = await client.users.fetch(userId).catch(() => null);
        if (user) await createTicket(guild, user, `₹${amount} package is sold out (${cfg.sold_count}/${cfg.max_stock} sold)`, { amount, paymentId });
      }
      await logAction('STOCK_LIMIT_HIT', userId, `₹${amount}: ${cfg.sold_count}/${cfg.max_stock}`);
      return false;
    }

    // Get an available card code
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

    // Mark card as used
    await conn.query(
      'UPDATE gift_cards SET is_used = 1, used_by = ?, assigned_at = NOW(), expiry = ? WHERE id = ?',
      [userId, expiry, card.id]
    );

    // Record sale in stock_config + stock_history
    await recordSale(conn, amount, userId);

    await conn.commit();

    const expiryStr = expiry.toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' });

    // Send DM to user
    try {
      const user = await client.users.fetch(userId);
      await user.send({
        embeds: [
          new EmbedBuilder()
            .setTitle('✅ Payment Successful — Gift Card Delivered!')
            .setDescription('Thank you for your purchase! Your gift card details are below.')
            .addFields(
              { name: '🎁 Gift Card Code', value: `\`\`\`${card.code}\`\`\``, inline: false },
              { name: '💰 Amount', value: `₹${amount}`, inline: true },
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

  const adminRole = guild.roles.cache.find(r => r.name === CONFIG.ADMIN_ROLE);
  const permOverwrites = [
    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
  ];
  if (adminRole) permOverwrites.push({ id: adminRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });

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
// STORE EMBED (with live stock display)
// ========================================

async function buildStoreEmbed() {
  const stockAll = await getAllStockStatus();

  const stockLines = CONFIG.PACKAGES.map(amt => {
    const s = stockAll[amt];
    if (!s) return `₹${amt} — Unknown`;
    if (s.is_sold_out) return `₹${amt} — 🔴 **SOLD OUT**`;
    if (s.is_low_stock) return `₹${amt} — 🟡 **${s.remaining} remaining** ⚠️ Low Stock`;
    return `₹${amt} — 🟢 **${s.remaining} available**`;
  }).join('\n');

  return new EmbedBuilder()
    .setTitle('🎁 Gift Card Store')
    .setDescription(
      '**Welcome to the Gift Card Store!**\n\n' +
      'Purchase gift cards instantly using UPI, PayPal, or Razorpay.\n\n' +
      '**How it works:**\n' +
      '1️⃣ Select a gift card amount from the dropdown below\n' +
      '2️⃣ Choose your preferred payment method\n' +
      '3️⃣ Complete payment and receive your gift card via DM\n\n' +
      '🔒 Secure | ⚡ Instant | 🎁 Auto-Delivery'
    )
    .addFields({ name: '📦 Current Stock', value: stockLines, inline: false })
    .setColor(0x5865F2)
    .setThumbnail(CONFIG.QR_IMAGE)
    .setTimestamp()
    .setFooter({ text: 'Gift Card Store | Limited Stock' });
}

async function buildStoreRow() {
  const stockAll = await getAllStockStatus();

  const options = CONFIG.PACKAGES.map(amt => {
    const s = stockAll[amt];
    const soldOut = s ? s.is_sold_out : false;
    const remaining = s ? s.remaining : 0;
    const emojis = { 100: '💰', 250: '💎', 500: '👑' };
    return {
      label: soldOut ? `₹${amt} Gift Card — SOLD OUT` : `₹${amt} Gift Card (${remaining} left)`,
      description: soldOut ? 'Currently out of stock' : `Purchase a ₹${amt} gift card`,
      value: amt.toString(),
      emoji: emojis[amt],
      default: false
    };
  });

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('select_amount')
      .setPlaceholder('🛒 Select Gift Card Amount to Purchase')
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
      const bar = stockBar(s.sold_count, s.max_stock);
      const status = s.is_sold_out ? '🔴 SOLD OUT' : s.is_low_stock ? '🟡 LOW' : '🟢 OK';
      return `**₹${amt}** ${status}\n\`${bar}\`\n${s.remaining} remaining / ${s.max_stock} limit`;
    }).join('\n\n');

    const [[{ total }]] = await pool.query('SELECT COUNT(*) as total FROM transactions WHERE status IN ("approved","captured")');
    const [[{ pending }]] = await pool.query('SELECT COUNT(*) as pending FROM transactions WHERE status = "pending"');
    const [[{ today }]] = await pool.query('SELECT COUNT(*) as today FROM transactions WHERE DATE(created_at) = CURDATE()');

    // Last 3 stock history events
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
        console.log('[BOT] Dashboard updated.');
        return;
      } catch (_) {}
    }
    const msg = await channel.send({ embeds: [embed] });
    await setConfig('dashboard_message_id', msg.id);
    console.log('[BOT] Dashboard posted.');
  } catch (err) {
    console.error('[DASHBOARD ERROR]', err.message);
  }
}

async function postOrUpdateStore(client) {
  try {
    const channel = await client.channels.fetch(CONFIG.CHANNEL_ID).catch(() => null);
    if (!channel) { console.warn('[STORE] Channel not found or no access.'); return; }
    const savedMsgId = await getConfig('store_message_id');
    const embed = await buildStoreEmbed();
    const row = await buildStoreRow();
    if (savedMsgId) {
      try {
        const msg = await channel.messages.fetch(savedMsgId);
        await msg.edit({ embeds: [embed], components: [row] });
        console.log('[BOT] Store embed refreshed.');
        return;
      } catch (_) {}
    }
    const msg = await channel.send({ embeds: [embed], components: [row] });
    await setConfig('store_message_id', msg.id);
    console.log('[BOT] Store embed posted.');
  } catch (err) {
    console.error('[STORE ERROR]', err.message);
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
    activities: [{ name: '🎁 Gift Card Store | Limited Stock', type: ActivityType.Watching }],
    status: 'online'
  });

  try { await createPool(); await initDatabase(); dbConnected = true; }
  catch (err) { console.error('[DB INIT ERROR]', err.message); await reconnectDB(); }

  try {
    const rest = new REST({ version: '10' }).setToken(CONFIG.BOT_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('[BOT] Slash commands registered.');
  } catch (err) { console.error('[COMMANDS ERROR]', err.message); }

  // Run startup DB sync and post to status channel
  const startupStats = await runAutoDbSync('startup', 'system');
  if (startupStats) await postDbReport(client, startupStats, 'startup');

  await postOrUpdateDashboard(client, true);
  await postOrUpdateStore(client);

  // Refresh dashboard + store every 5 minutes
  setInterval(async () => {
    await postOrUpdateDashboard(client, true);
    await postOrUpdateStore(client);
  }, 5 * 60 * 1000);

  // Auto DB sync every 30 minutes — logs snapshot + updates DB report
  setInterval(async () => {
    const stats = await runAutoDbSync('scheduled', 'system');
    if (stats) await postDbReport(client, stats, 'scheduled');
  }, 30 * 60 * 1000);
});

client.on('shardReconnecting', () => { console.log('[BOT] Reconnecting...'); });
client.on('shardResume', async () => {
  console.log('[BOT] Reconnected!');
  client.user?.setPresence({ activities: [{ name: '🎁 Gift Card Store | Limited Stock', type: ActivityType.Watching }], status: 'online' });
  try { await pool.query('SELECT 1'); dbConnected = true; } catch (_) { await reconnectDB(); }
  // Log reconnect sync
  const reconnectStats = await runAutoDbSync('reconnect', 'system');
  if (reconnectStats) await postDbReport(client, reconnectStats, 'reconnect');
  await postOrUpdateDashboard(client, true);
  await postOrUpdateStore(client);
});

// ========================================
// INTERACTION HANDLER
// ========================================

client.on('interactionCreate', async (interaction) => {
  try {

    // ---- /dashboard ----
    if (interaction.isChatInputCommand() && interaction.commandName === 'dashboard') {
      await interaction.deferReply({ ephemeral: true });
      await interaction.editReply({ embeds: [await buildDashboardEmbed(client.user.tag, true)] });
      return;
    }

    // ---- /dbstatus ----
    if (interaction.isChatInputCommand() && interaction.commandName === 'dbstatus') {
      await interaction.deferReply({ ephemeral: true });
      const logs = await getRecentSyncLogs(10);
      const lines = logs.length > 0
        ? logs.map((r, i) => {
            const ts = new Date(r.synced_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
            return `\`${i + 1}\` **${r.sync_type}** at \`${ts}\`\n` +
              `Cards: **${r.available_cards}**/${r.total_gift_cards} available | Txns: **${r.total_transactions}** | Pending: **${r.pending_transactions}** | Stock events: **${r.total_stock_events}**`;
          }).join('\n\n')
        : 'No sync records found.';
      const embed = new EmbedBuilder()
        .setTitle('🗄️ Database Status & Sync History')
        .setDescription(`Last **${logs.length}** sync records from \`db_sync_log\`:\n\n${lines}`)
        .setColor(0x00BFFF)
        .setTimestamp()
        .setFooter({ text: `Database: ${CONFIG.DB.database} @ ${CONFIG.DB.host}` });
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ---- /dbsync ----
    if (interaction.isChatInputCommand() && interaction.commandName === 'dbsync') {
      await interaction.deferReply({ ephemeral: true });
      const adminTag = interaction.user.tag;
      const stats = await runAutoDbSync('manual', adminTag);
      if (!stats) {
        await interaction.editReply('❌ DB sync failed. Check console for errors.');
        return;
      }
      await postDbReport(client, stats, 'manual');
      const embed = new EmbedBuilder()
        .setTitle('🛠️ Manual DB Sync Complete')
        .setDescription('All tables verified. Snapshot recorded to `db_sync_log`. Status channel updated.')
        .addFields(
          { name: '🎁 Gift Cards', value: `${stats.available_cards} available / ${stats.total_gift_cards} total`, inline: true },
          { name: '💳 Transactions', value: `${stats.total_transactions} total | ${stats.pending_transactions} pending`, inline: true },
          { name: '📊 Stock Events', value: `${stats.total_stock_events} recorded`, inline: true }
        )
        .setColor(0x00FF7F)
        .setTimestamp()
        .setFooter({ text: `Triggered by ${adminTag}` });
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ---- /store ----
    if (interaction.isChatInputCommand() && interaction.commandName === 'store') {
      const embed = await buildStoreEmbed();
      const row = await buildStoreRow();
      const msg = await interaction.channel.send({ embeds: [embed], components: [row] });
      await setConfig('store_message_id', msg.id);
      await interaction.reply({ content: '✅ Store embed posted!', ephemeral: true });
      return;
    }

    // ---- /addcard ----
    if (interaction.isChatInputCommand() && interaction.commandName === 'addcard') {
      const amount = interaction.options.getInteger('amount');
      const code = interaction.options.getString('code').trim();
      try {
        await pool.query('INSERT INTO gift_cards (amount, code) VALUES (?, ?)', [amount, code]);
        const [[{ available }]] = await pool.query(
          'SELECT COUNT(*) as available FROM gift_cards WHERE amount = ? AND is_used = 0', [amount]
        );
        const [[cfg]] = await pool.query('SELECT * FROM stock_config WHERE amount = ?', [amount]);
        await recordManualAdd(amount, interaction.user.id);

        await interaction.reply({
          embeds: [
            new EmbedBuilder().setTitle('✅ Gift Card Added')
              .addFields(
                { name: '💰 Amount', value: `₹${amount}`, inline: true },
                { name: '🎁 Code', value: `\`${code}\``, inline: true },
                { name: '📦 Available Codes', value: `${available}`, inline: true },
                { name: '📊 Stock Limit Progress', value: `\`${stockBar(cfg.sold_count, cfg.max_stock)}\``, inline: false }
              )
              .setColor(0x00FF00).setTimestamp()
          ],
          ephemeral: true
        });
        await logAction('CARD_ADDED', interaction.user.id, `₹${amount}: ${code}`);
        await postOrUpdateDashboard(client, true);
        await postOrUpdateStore(client);
      } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return interaction.reply({
          embeds: [new EmbedBuilder().setTitle('❌ Duplicate Code').setDescription('This code already exists.').setColor(0xFF0000)],
          ephemeral: true
        });
        throw err;
      }
      return;
    }

    // ---- /stock ----
    if (interaction.isChatInputCommand() && interaction.commandName === 'stock') {
      const embed = new EmbedBuilder().setTitle('📦 Gift Card Stock Report').setColor(0x5865F2).setTimestamp();
      let totalAvail = 0;
      let totalSold = 0;

      for (const amt of CONFIG.PACKAGES) {
        const s = await getStockStatus(amt);
        const status = s.is_sold_out ? '🔴 SOLD OUT' : s.is_low_stock ? `🟡 LOW STOCK (${s.remaining} left)` : `🟢 ${s.remaining} available`;
        embed.addFields({
          name: `₹${amt} Package`,
          value:
            `${status}\n` +
            `\`${stockBar(s.sold_count, s.max_stock)}\`\n` +
            `Limit: **${s.max_stock}** | Sold: **${s.sold_count}** | Codes in DB: **${s.available_codes}**`,
          inline: false
        });
        totalAvail += s.remaining;
        totalSold += s.sold_count;
      }

      embed.setFooter({ text: `Total available: ${totalAvail} | Total sold: ${totalSold}` });
      await interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }

    // ---- /setstock ----
    if (interaction.isChatInputCommand() && interaction.commandName === 'setstock') {
      const amount = interaction.options.getInteger('amount');
      const newLimit = interaction.options.getInteger('limit');
      const [[prev]] = await pool.query('SELECT * FROM stock_config WHERE amount = ?', [amount]);

      await pool.query('UPDATE stock_config SET max_stock = ?, updated_at = NOW() WHERE amount = ?', [newLimit, amount]);
      await recordRestock(amount, newLimit, interaction.user.id, `Limit changed from ${prev.max_stock} to ${newLimit}`);

      await interaction.reply({
        embeds: [
          new EmbedBuilder().setTitle('⚙️ Stock Limit Updated')
            .addFields(
              { name: '💰 Package', value: `₹${amount}`, inline: true },
              { name: '📉 Old Limit', value: `${prev.max_stock}`, inline: true },
              { name: '📈 New Limit', value: `${newLimit}`, inline: true },
              { name: '📊 Current Progress', value: `\`${stockBar(prev.sold_count, newLimit)}\`\n${prev.sold_count} sold, ${Math.max(0, newLimit - prev.sold_count)} remaining`, inline: false }
            )
            .setColor(0x5865F2).setTimestamp()
        ],
        ephemeral: true
      });
      await logAction('STOCK_LIMIT_CHANGED', interaction.user.id, `₹${amount}: ${prev.max_stock} → ${newLimit}`);
      await postOrUpdateDashboard(client, true);
      await postOrUpdateStore(client);
      return;
    }

    // ---- /restockall ----
    if (interaction.isChatInputCommand() && interaction.commandName === 'restockall') {
      for (const amt of CONFIG.PACKAGES) {
        const [[prev]] = await pool.query('SELECT * FROM stock_config WHERE amount = ?', [amt]);
        await pool.query('UPDATE stock_config SET sold_count = 0, last_restocked = NOW() WHERE amount = ?', [amt]);
        await pool.query(`
          INSERT INTO stock_history (amount, event_type, quantity_change, sold_count_after, max_stock_after, performed_by, notes)
          VALUES (?, 'restock', ?, 0, ?, ?, 'Full restock — sold count reset to 0')
        `, [amt, prev.sold_count, prev.max_stock, interaction.user.id]);
      }

      const embed = new EmbedBuilder().setTitle('📥 All Packages Restocked!')
        .setDescription('Sold counts have been reset to 0 for all packages. Stock limits remain unchanged.')
        .setColor(0x00FF00).setTimestamp();

      for (const amt of CONFIG.PACKAGES) {
        const [[cfg]] = await pool.query('SELECT * FROM stock_config WHERE amount = ?', [amt]);
        embed.addFields({
          name: `₹${amt}`,
          value: `\`${stockBar(0, cfg.max_stock)}\` — ${cfg.max_stock} available`,
          inline: true
        });
      }

      await interaction.reply({ embeds: [embed], ephemeral: true });
      await logAction('RESTOCK_ALL', interaction.user.id, 'All packages restocked');
      await postOrUpdateDashboard(client, true);
      await postOrUpdateStore(client);
      return;
    }

    // ---- /transactions ----
    if (interaction.isChatInputCommand() && interaction.commandName === 'transactions') {
      const limit = interaction.options.getInteger('limit') || 10;
      const [rows] = await pool.query('SELECT * FROM transactions ORDER BY created_at DESC LIMIT ?', [limit]);
      const embed = new EmbedBuilder().setTitle('📊 Recent Transactions').setColor(0x5865F2).setTimestamp()
        .setFooter({ text: `Showing last ${limit} transactions` });
      if (rows.length === 0) {
        embed.setDescription('No transactions yet.');
      } else {
        const icons = { pending: '⏳', approved: '✅', rejected: '❌', captured: '💳' };
        rows.forEach(r => embed.addFields({
          name: `${icons[r.status] || '?'} #${r.id} · ₹${r.amount} · ${r.status.toUpperCase()}`,
          value: `<@${r.user_id}> · UPI: \`${r.upi_txn || 'N/A'}\` · ${new Date(r.created_at).toLocaleString('en-IN')}`,
          inline: false
        }));
      }
      await interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }

    // ---- DROPDOWN: Amount Selection ----
    if (interaction.isStringSelectMenu() && interaction.customId === 'select_amount') {
      const amount = parseInt(interaction.values[0]);

      // Check stock limit before proceeding
      const s = await getStockStatus(amount);
      if (s && s.is_sold_out) {
        return interaction.reply({
          embeds: [
            new EmbedBuilder().setTitle('🔴 Package Sold Out')
              .setDescription(`The **₹${amount}** gift card package is currently **sold out** (${s.sold_count}/${s.max_stock} sold).\n\nPlease check back later or contact support.`)
              .setColor(0xFF0000)
          ],
          ephemeral: true
        });
      }

      if (await hasPendingPayment(interaction.user.id)) {
        return interaction.reply({
          embeds: [new EmbedBuilder().setTitle('⚠️ Pending Payment').setDescription(
            'You already have a payment waiting for review. Please wait before making a new purchase.'
          ).setColor(0xFF0000)],
          ephemeral: true
        });
      }

      const lowStockWarning = s && s.is_low_stock ? `\n\n⚠️ **Only ${s.remaining} left at this price!**` : '';

      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('💳 Payment Details')
            .setDescription(`You selected a **₹${amount}** gift card.${lowStockWarning}\n\nChoose your payment method below.`)
            .addFields(
              { name: '📱 UPI ID', value: `\`${CONFIG.UPI_ID}\``, inline: true },
              { name: '📧 PayPal', value: `\`${CONFIG.PAYPAL}\``, inline: true },
              { name: '\u200b', value: '\u200b', inline: true },
              { name: '📸 Scan QR to Pay via UPI', value: 'Scan the QR code below.', inline: false }
            )
            .setImage(CONFIG.QR_IMAGE)
            .setColor(s && s.is_low_stock ? 0xFFA500 : 0x00BFFF)
            .setTimestamp().setFooter({ text: `₹${amount} Gift Card | ${s ? s.remaining : '?'} remaining` })
        ],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`razorpay_${amount}`).setLabel('Pay via Razorpay').setEmoji('💳').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`manual_${amount}`).setLabel('Submit Manual Payment').setEmoji('📝').setStyle(ButtonStyle.Secondary)
          )
        ],
        ephemeral: true
      });

      await logAction('AMOUNT_SELECTED', interaction.user.id, `₹${amount}`);
    }

    // ---- BUTTON: Razorpay ----
    if (interaction.isButton() && interaction.customId.startsWith('razorpay_')) {
      const amount = parseInt(interaction.customId.split('_')[1]);
      await interaction.deferReply({ ephemeral: true });
      try {
        const paymentLink = await razorpay.paymentLink.create({
          amount: amount * 100, currency: 'INR', description: `Gift Card ₹${amount}`,
          notes: { discord_user_id: interaction.user.id, amount: amount.toString() },
          callback_url: `https://${process.env.REPLIT_DEV_DOMAIN || 'localhost'}/webhook/success`,
          callback_method: 'get'
        });
        await interaction.editReply({
          embeds: [new EmbedBuilder().setTitle('💳 Razorpay — Secure Payment')
            .setDescription(`Click the button below to pay **₹${amount}** securely.\n\nYour gift card is **automatically delivered** after payment confirmation.`)
            .setColor(0x528FF0).setTimestamp().setFooter({ text: 'Instant delivery after payment' })],
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel(`Pay ₹${amount} Now`).setEmoji('🔗').setStyle(ButtonStyle.Link).setURL(paymentLink.short_url)
          )]
        });
        await logAction('RAZORPAY_LINK', interaction.user.id, `₹${amount}: ${paymentLink.short_url}`);
      } catch (err) {
        console.error('[RAZORPAY ERROR]', err.message);
        await interaction.editReply({
          embeds: [new EmbedBuilder().setTitle('⚠️ Razorpay Not Available')
            .setDescription('Razorpay is not configured yet. Please use **Submit Manual Payment** instead.').setColor(0xFFA500)]
        });
      }
    }

    // ---- BUTTON: Manual → Modal ----
    if (interaction.isButton() && interaction.customId.startsWith('manual_')) {
      const amount = interaction.customId.split('_')[1];
      const modal = new ModalBuilder().setCustomId(`manual_modal_${amount}`).setTitle(`Manual Payment — ₹${amount}`);
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('upi_txn').setLabel('UPI Transaction ID *')
            .setPlaceholder('e.g. 123456789012').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('sender_name').setLabel('Sender Name *')
            .setPlaceholder('Name shown in your payment app').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('gateway_txn').setLabel('Gateway Transaction ID (optional)')
            .setPlaceholder('PayPal / other gateway ID or leave blank').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100)
        )
      );
      await interaction.showModal(modal);
    }

    // ---- MODAL: Manual Submit ----
    if (interaction.isModalSubmit() && interaction.customId.startsWith('manual_modal_')) {
      const amount = parseInt(interaction.customId.split('_')[2]);
      const upiTxn = interaction.fields.getTextInputValue('upi_txn').trim();
      const sender = interaction.fields.getTextInputValue('sender_name').trim();
      const gatewayTxn = interaction.fields.getTextInputValue('gateway_txn').trim() || 'N/A';

      if (await isDuplicateTxn(upiTxn)) return interaction.reply({
        embeds: [new EmbedBuilder().setTitle('❌ Duplicate Transaction').setDescription('This UPI Transaction ID was already submitted.').setColor(0xFF0000)],
        ephemeral: true
      });

      if (await hasPendingPayment(interaction.user.id)) return interaction.reply({
        embeds: [new EmbedBuilder().setTitle('⚠️ Pending Payment').setDescription('You already have a payment under review.').setColor(0xFF0000)],
        ephemeral: true
      });

      const [result] = await pool.query(
        'INSERT INTO transactions (user_id, amount, upi_txn, sender, gateway_txn, status) VALUES (?, ?, ?, ?, ?, ?)',
        [interaction.user.id, amount, upiTxn, sender, gatewayTxn, 'pending']
      );
      const txnId = result.insertId;

      await interaction.reply({
        embeds: [new EmbedBuilder().setTitle('✅ Payment Submitted')
          .setDescription('Your payment has been submitted for admin review. You will receive a DM once approved.')
          .addFields({ name: '🆔 Reference', value: `#${txnId}`, inline: true }, { name: '💰 Amount', value: `₹${amount}`, inline: true })
          .setColor(0x00FF00).setTimestamp()],
        ephemeral: true
      });

      try {
        const ch = await client.channels.fetch(CONFIG.STATUS_CHANNEL_ID);
        await ch.send({
          embeds: [new EmbedBuilder().setTitle('📋 Manual Payment — Review Required')
            .addFields(
              { name: '👤 User', value: `<@${interaction.user.id}> (${interaction.user.tag})`, inline: false },
              { name: '💰 Amount', value: `₹${amount}`, inline: true },
              { name: '🆔 Ref', value: `#${txnId}`, inline: true },
              { name: '\u200b', value: '\u200b', inline: true },
              { name: '📝 UPI Txn ID', value: `\`${upiTxn}\``, inline: true },
              { name: '👤 Sender', value: sender, inline: true },
              { name: '🔗 Gateway', value: gatewayTxn, inline: true }
            )
            .setColor(0xFFA500).setTimestamp().setFooter({ text: `Transaction #${txnId}` })],
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`approve_${txnId}_${interaction.user.id}_${amount}`).setLabel('Approve').setEmoji('✅').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`reject_${txnId}_${interaction.user.id}`).setLabel('Reject').setEmoji('❌').setStyle(ButtonStyle.Danger)
          )]
        });
      } catch (err) { console.error('[ADMIN NOTIFY]', err.message); }

      await logAction('MANUAL_SUBMITTED', interaction.user.id, `UPI: ${upiTxn}, ₹${amount}`);
      await postOrUpdateDashboard(client, true);
    }

    // ---- BUTTON: Approve ----
    if (interaction.isButton() && interaction.customId.startsWith('approve_')) {
      const parts = interaction.customId.split('_');
      const [, txnId, userId, amountStr] = parts;
      const amount = parseInt(amountStr);

      const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
                      interaction.member.roles.cache.some(r => r.name === CONFIG.ADMIN_ROLE);
      if (!isAdmin) return interaction.reply({
        embeds: [new EmbedBuilder().setTitle('❌ Access Denied').setDescription('Admins only.').setColor(0xFF0000)],
        ephemeral: true
      });

      await interaction.deferReply({ ephemeral: true });
      await pool.query('UPDATE transactions SET status = "approved" WHERE id = ?', [txnId]);
      const delivered = await deliverGiftCard(client, userId, amount, `manual-${txnId}`);

      await interaction.editReply({
        embeds: [new EmbedBuilder()
          .setTitle(delivered ? '✅ Approved & Delivered' : '⚠️ Approved — Out of Stock')
          .setDescription(delivered
            ? `Gift card delivered to <@${userId}> via DM.`
            : `No ₹${amount} cards available. A support ticket was created for <@${userId}>.`)
          .setColor(delivered ? 0x00FF00 : 0xFFA500)]
      });

      try {
        const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
          .setColor(0x00FF00).setTitle('✅ Payment Approved')
          .setFooter({ text: `Approved by ${interaction.user.tag} • ${new Date().toLocaleString('en-IN')}` });
        await interaction.message.edit({ embeds: [updatedEmbed], components: [] });
      } catch (_) {}

      await logAction('APPROVED', interaction.user.id, `Txn #${txnId}, User: ${userId}, ₹${amount}`);
      await postOrUpdateDashboard(client, true);
      await postOrUpdateStore(client);
    }

    // ---- BUTTON: Reject ----
    if (interaction.isButton() && interaction.customId.startsWith('reject_')) {
      const [, txnId, userId] = interaction.customId.split('_');

      const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
                      interaction.member.roles.cache.some(r => r.name === CONFIG.ADMIN_ROLE);
      if (!isAdmin) return interaction.reply({
        embeds: [new EmbedBuilder().setTitle('❌ Access Denied').setDescription('Admins only.').setColor(0xFF0000)],
        ephemeral: true
      });

      await pool.query('UPDATE transactions SET status = "rejected" WHERE id = ?', [txnId]);
      try {
        const user = await client.users.fetch(userId);
        await user.send({ embeds: [new EmbedBuilder().setTitle('❌ Payment Rejected')
          .setDescription(`Your payment (Ref #${txnId}) was rejected.\nContact support if this is an error.`)
          .setColor(0xFF0000).setTimestamp()] });
      } catch (_) {}

      try {
        const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
          .setColor(0xFF0000).setTitle('❌ Payment Rejected')
          .setFooter({ text: `Rejected by ${interaction.user.tag} • ${new Date().toLocaleString('en-IN')}` });
        await interaction.message.edit({ embeds: [updatedEmbed], components: [] });
      } catch (_) {}

      await interaction.reply({
        embeds: [new EmbedBuilder().setTitle('❌ Payment Rejected').setDescription(`Transaction #${txnId} rejected. User notified.`).setColor(0xFF0000)],
        ephemeral: true
      });
      await logAction('REJECTED', interaction.user.id, `Txn #${txnId}, User: ${userId}`);
      await postOrUpdateDashboard(client, true);
    }

  } catch (err) {
    console.error('[INTERACTION ERROR]', err);
    const replyFn = interaction.deferred || interaction.replied ? interaction.editReply.bind(interaction) : interaction.reply.bind(interaction);
    await replyFn({
      embeds: [new EmbedBuilder().setTitle('❌ Error').setDescription('An unexpected error occurred. Please try again.').setColor(0xFF0000)],
      ephemeral: true
    }).catch(() => {});
  }
});

// ========================================
// EXPRESS WEBHOOK SERVER
// ========================================

const app = express();
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

app.get('/', (req, res) => res.json({ status: 'online', bot: client.user?.tag || 'starting...', db: dbConnected, uptime: `${Math.floor(process.uptime())}s` }));
app.get('/health', (req, res) => res.json({ ok: true, db: dbConnected, bot: !!client.user }));
app.get('/webhook/success', (req, res) => res.send(`<!DOCTYPE html><html><head><title>Payment Successful</title>
  <style>body{background:#1a1a2e;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;margin:0}
  .box{text-align:center;padding:40px;background:#16213e;border-radius:16px;border:1px solid #00ff88}
  h1{color:#00ff88}p{color:#ccc}</style></head>
  <body><div class="box"><div style="font-size:64px">✅</div><h1>Payment Successful!</h1>
  <p>Your gift card will be delivered to your Discord DMs shortly.</p>
  <p style="color:#888;margin-top:16px">You can close this window.</p></div></body></html>`));

app.post('/webhook', async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    if (!signature) return res.status(400).json({ error: 'No signature' });
    const rawBody = req.body;
    const expected = crypto.createHmac('sha256', CONFIG.RAZORPAY.key_secret)
      .update(typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody)).digest('hex');
    if (signature !== expected) return res.status(400).json({ error: 'Invalid signature' });

    const payload = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
    console.log(`[WEBHOOK] Event: ${payload.event}`);

    if (payload.event === 'payment.captured' || payload.event === 'payment_link.paid') {
      const entity = payload.event === 'payment_link.paid'
        ? payload.payload.payment_link.entity : payload.payload.payment.entity;
      const userId = entity.notes?.discord_user_id;
      const amount = parseInt(entity.notes?.amount || Math.round(entity.amount / 100));
      const paymentId = entity.id || `rzp_${Date.now()}`;
      if (!userId) return res.status(200).json({ status: 'no user id' });

      await pool.query('INSERT INTO transactions (user_id, amount, payment_id, status) VALUES (?, ?, ?, ?)',
        [userId, amount, paymentId, 'captured']);
      await deliverGiftCard(client, userId, amount, paymentId);
      await postOrUpdateDashboard(client, true);
      await postOrUpdateStore(client);
      await logAction('RAZORPAY_CAPTURED', userId, `₹${amount}, Payment: ${paymentId}`);
    }
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('[WEBHOOK ERROR]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

app.listen(CONFIG.WEBHOOK_PORT, '0.0.0.0', () => console.log(`[SERVER] Webhook server on port ${CONFIG.WEBHOOK_PORT}`));

// ========================================
// BOT LOGIN + SHUTDOWN
// ========================================

client.login(CONFIG.BOT_TOKEN).catch(err => { console.error('[LOGIN ERROR]', err.message); process.exit(1); });

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
