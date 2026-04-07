# 🎁 Irace Gift Card Store Bot

A Discord bot for managing and selling gift cards via UPI payments. Users browse the store, pay via UPI, submit their transaction ID, and admins approve or reject payments — with gift card codes auto-delivered via Discord DM.

---

## 📋 Table of Contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [Running the Bot](#running-the-bot)
- [Slash Commands](#slash-commands)
- [How It Works](#how-it-works)
- [Webhook Endpoints](#webhook-endpoints)
- [Database Tables](#database-tables)
- [Project Structure](#project-structure)

---

## ✨ Features

- **Live Store Embed** — Posts a gift card store panel in your Discord channel with real-time stock levels and discount offers
- **UPI Payment Flow** — Users select a card, see the QR code and UPI ID, then submit their transaction details via a Discord modal
- **Admin Approval System** — Approve or reject payments with one click; XML transaction logs sent to a status channel
- **Auto Gift Card Delivery** — On approval, the bot automatically DMs the user their gift card code
- **Discount Offers** — Configure percentage-off offers per denomination (e.g. 10% off ₹1000 cards)
- **Stock Management** — Track available codes, sold count, and max limits per denomination
- **MySQL Auto-Reconnect** — Keeps the DB connection alive with keepalive pings and automatic reconnection
- **Ticket System** — Auto-creates a support ticket channel if a card cannot be delivered
- **Dashboard** — Live bot status dashboard posted to your status channel
- **DB Sync Logs** — Periodic database health checks with reports sent to Discord

---

## 🔧 Requirements

- **Node.js** v18 or higher (v20 recommended)
- **npm** v8 or higher
- **MySQL** database (remote or local)
- A **Discord Bot** token from the [Discord Developer Portal](https://discord.com/developers/applications)
- Your bot must have these permissions in your server:
  - Send Messages
  - Embed Links
  - Manage Messages
  - Read Message History
  - Use Slash Commands
  - Manage Channels (for ticket creation)

---

## 📦 Installation

### 1. Clone / Download the project

```bash
git clone <your-repo-url>
cd Iracegiftccard
```

Or simply download and extract the `Iracegiftccard` folder.

### 2. Install dependencies

```bash
npm install
```

This installs all required packages:

| Package | Version | Purpose |
|---|---|---|
| `discord.js` | ^14.26.2 | Discord bot framework |
| `express` | ^4.22.1 | Webhook HTTP server |
| `mysql2` | ^3.20.0 | MySQL database driver |
| `razorpay` | ^2.9.6 | Razorpay payment gateway (future) |

> **Note:** The `crypto` module is **not** listed as a dependency — it uses Node.js's built-in `node:crypto` module. No extra install needed.

### 3. Configure credentials

Open `index.js` and update the `CONFIG` block at the top of the file:

```js
const CONFIG = {
  BOT_TOKEN: 'YOUR_DISCORD_BOT_TOKEN',
  DB: {
    host: 'YOUR_DB_HOST',
    user: 'YOUR_DB_USER',
    password: 'YOUR_DB_PASSWORD',
    database: 'YOUR_DB_NAME',
    // ... other options (leave as-is)
  },
  CHANNEL_ID: 'YOUR_STORE_CHANNEL_ID',
  STATUS_CHANNEL_ID: 'YOUR_STATUS_CHANNEL_ID',
  UPI_ID: 'your-upi@bank',
  QR_IMAGE: 'https://link-to-your-qr-image.png',
  STORE_LOGO: 'https://link-to-your-logo.png',
  // ...
};
```

See the [Configuration](#configuration) section for all available options.

### 4. Set up the Discord bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application and add a Bot
3. Copy the **Bot Token** and paste it into `CONFIG.BOT_TOKEN`
4. Under **OAuth2 → URL Generator**, select scopes: `bot`, `applications.commands`
5. Select permissions: `Send Messages`, `Embed Links`, `Manage Messages`, `Read Message History`, `Manage Channels`
6. Use the generated URL to invite the bot to your server

### 5. Run the bot

```bash
node index.js
```

Or use the start script which auto-installs dependencies first:

```bash
bash start.sh
```

Or via npm:

```bash
npm start
```

---

## ⚙️ Configuration

All configuration is in the `CONFIG` object at the top of `index.js`:

| Key | Description | Example |
|---|---|---|
| `BOT_TOKEN` | Discord bot token | `MTQ5MD...` |
| `DB.host` | MySQL server host | `104.234.180.242` |
| `DB.user` | MySQL username | `u82822_xxx` |
| `DB.password` | MySQL password | `yourpassword` |
| `DB.database` | MySQL database name | `s82822_vipshop` |
| `CHANNEL_ID` | Discord channel ID for the store embed | `149095509...` |
| `STATUS_CHANNEL_ID` | Discord channel ID for admin logs & dashboard | `149097194...` |
| `QR_IMAGE` | URL to your UPI QR code image | `https://...` |
| `STORE_LOGO` | URL to your store logo image | `https://...` |
| `UPI_ID` | Your UPI payment ID | `name@okicici` |
| `ADMIN_ROLE` | Name of the admin Discord role | `Admin` |
| `WEBHOOK_PORT` | Port for the Express webhook server | `3001` |
| `TEBEX_URL` | Redemption URL sent to users with their gift card | `https://yourstore.tebex.io` |
| `PACKAGES` | Array of gift card denominations in INR | `[100, 500, 1000, ...]` |
| `OFFERS` | Discount offers per denomination | `{ 1000: { pct: 10, price: 900 } }` |
| `DEFAULT_MAX_STOCK` | Default max stock limit per denomination | `10` |
| `LOW_STOCK_THRESHOLD` | Number at which "Low Stock" warning appears | `3` |

### Offers / Discounts

Define discounts in the `OFFERS` object:

```js
OFFERS: {
  1000:  { pct: 10, price: 900  },   // 10% off ₹1000 → pay ₹900
  2500:  { pct: 15, price: 2125 },   // 15% off ₹2500 → pay ₹2125
  5000:  { pct: 20, price: 4000 },   // 20% off ₹5000 → pay ₹4000
  10000: { pct: 30, price: 7000 }    // 30% off ₹10000 → pay ₹7000
}
```

Denominations not listed in `OFFERS` are sold at face value.

---

## ▶️ Running the Bot

### Option 1 — Direct (Node.js)

```bash
node index.js
```

### Option 2 — Auto-install script

```bash
bash start.sh
```

This runs `npm install` first, then starts the bot. Useful for first-time setup or after pulling updates.

### Option 3 — npm

```bash
npm start
```

### What happens on startup

1. Bot logs into Discord
2. Sets presence status to "Watching 🎁 Gift Card Store"
3. Connects to MySQL and initializes all tables
4. Registers all slash commands globally
5. Runs a startup DB sync and posts a report to the status channel
6. Posts/refreshes the live dashboard in the status channel
7. Cleans up any old store panels and posts a fresh one in the store channel
8. Starts the Express webhook server on port `3001`

---

## 🤖 Slash Commands

All commands require **Administrator** permission or the configured **Admin Role**.

| Command | Description |
|---|---|
| `/addcard <amount> <code>` | Add a gift card code to inventory |
| `/stock` | View current stock levels for all denominations |
| `/setstock <amount> <limit>` | Update the maximum stock limit for a denomination |
| `/restockall` | Reset sold counts for all denominations to 0 |
| `/transactions [limit]` | View recent transactions (default: last 10) |
| `/store` | Manually post a fresh store embed in the current channel |
| `/dashboard` | View the live bot status dashboard |
| `/dbstatus` | View database health and sync history |
| `/dbsync` | Manually trigger a database sync and health check |

---

## 🛒 How It Works

### Customer Flow

1. User sees the **store embed** in the designated channel
2. User selects a gift card denomination from the dropdown
3. Bot shows payment instructions with the **UPI QR code** and UPI ID
4. User pays and clicks **"I've Paid — Submit Details"**
5. User fills in the modal: UPI Transaction ID, Sender Name, Payment App, and optional Reference ID
6. Bot records the pending transaction and notifies admins in the status channel

### Admin Flow

1. Admin sees the payment notification in the status channel with **Approve** and **Reject** buttons
2. On **Approve**: the bot marks the transaction as approved, finds an unused gift card code in the DB, and DMs it to the user
3. On **Reject**: the bot marks the transaction as rejected and DMs the user a rejection notice
4. XML transaction logs are sent to the status channel for every event (submitted, approved, rejected)

### Out-of-Stock Handling

If a user pays but no codes are available (or the stock limit is reached), the bot:
- Creates a private **support ticket channel** for that user
- Notifies the user to contact support

---

## 🌐 Webhook Endpoints

The Express server runs on port `3001` and exposes:

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Bot status JSON (online, DB connected, uptime) |
| `GET` | `/health` | Health check JSON |
| `GET` | `/webhook/success` | Payment success page (redirect after Razorpay) |
| `POST` | `/webhook/razorpay` | Razorpay payment webhook (signature-verified) |
| `POST` | `/webhook/cashfree` | Cashfree webhook placeholder (future) |

---

## 🗄️ Database Tables

The bot auto-creates all required tables on startup:

| Table | Description |
|---|---|
| `gift_cards` | Stores all gift card codes with usage status |
| `transactions` | All payment transactions with status tracking |
| `action_logs` | Admin action audit log |
| `bot_config` | Key-value config store (saved message IDs, etc.) |
| `stock_config` | Max stock limits and sold counts per denomination |
| `stock_history` | History of stock events (sales, restocks, limit changes) |
| `db_sync_log` | Records of every DB sync operation |

---

## 📁 Project Structure

```
Iracegiftccard/
├── index.js          # Main bot code (all-in-one)
├── package.json      # Project metadata and dependencies
├── package-lock.json # Locked dependency versions
├── start.sh          # Auto-install + start script
└── README.md         # This file
```

---

## 📝 Notes

- The bot uses Node.js's **built-in `crypto` module** (`node:crypto`) for Razorpay webhook signature verification — no external `crypto` npm package is needed or installed
- The store embed and dashboard auto-refresh every **5 minutes**
- The database sync runs every **30 minutes**
- On every restart, old store panels are cleaned up and a fresh one is posted
- The bot stores Discord message IDs in `bot_config` to edit existing embeds instead of posting new ones

---

## 🛠️ Troubleshooting

| Problem | Solution |
|---|---|
| Bot doesn't start | Check that `BOT_TOKEN` in `CONFIG` is correct |
| DB connection fails | Verify `DB.host`, `DB.user`, `DB.password`, `DB.database` |
| Store embed not posting | Confirm the bot has access to `CHANNEL_ID` and has `Send Messages` + `Embed Links` permissions |
| Slash commands not showing | Wait 1–2 minutes after first startup for Discord to sync global commands |
| Gift card not delivered | Check that codes exist in `gift_cards` table via `/stock` or `/addcard` |
| Port already in use | Change `WEBHOOK_PORT` in `CONFIG` or set `PORT` environment variable |
