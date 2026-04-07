# 🎁 Irace Gift Card Store Bot

A Discord bot for selling gift cards via UPI payments. Users browse the store, pay via UPI, submit their transaction ID, and admins approve or reject payments — with gift card codes auto-delivered via Discord DM.

---

## 📋 Table of Contents

- [Features](#features)
- [Requirements](#requirements)
- [Bot Structure & Workflow](#bot-structure--workflow)
- [Project Structure](#project-structure)
- [Installation (Local / Replit)](#installation-local--replit)
- [Configuration (.env)](#configuration-env)
- [Slash Commands](#slash-commands)
- [How It Works](#how-it-works)
- [Webhook Endpoints](#webhook-endpoints)
- [Database Tables](#database-tables)
- [Host on AWS Linux VPS](#host-on-aws-linux-vps)
- [Host on Pterodactyl](#host-on-pterodactyl)
- [Troubleshooting](#troubleshooting)

---

## ✨ Features

- **Live Store Embed** — Posts a gift card store panel in your Discord channel with real-time stock levels and discount offers
- **UPI Payment Flow** — Users select a card, see the QR code and UPI ID, then submit their transaction details via a Discord modal
- **Admin Approval System** — Approve or reject payments with one click; XML transaction logs sent to a status channel
- **Auto Gift Card Delivery** — On approval, the bot automatically DMs the user their gift card code
- **Dynamic Discount Offers** — Set/update percentage-off offers per denomination via `/addcard` — changes are persisted in the DB and survive restarts
- **Stock Management** — Track available codes, sold count, and max limits per denomination
- **Admin Access by Role ID & User ID** — Control who can approve/reject by Discord role ID or specific user ID
- **Auto Dashboard Cleanup** — On every startup and reconnect, old dashboard and store panels are deleted and fresh ones are posted
- **MySQL Auto-Reconnect** — Keepalive pings and automatic reconnection logic
- **Ticket System** — Auto-creates a private support ticket channel if a card cannot be delivered
- **Dashboard** — Live bot status dashboard with stock, transactions, and DB health
- **DB Sync Logs** — Periodic database health checks with reports posted to Discord
- **Pterodactyl / VPS Ready** — All config via `.env` file, portable across environments
- **Auto-install on start** — `npm install` runs automatically before the bot starts

---

## 🔧 Requirements

- **Node.js** v18 or higher (v20 recommended)
- **npm** v8 or higher
- **MySQL** database (remote or local, v5.7+)
- A **Discord Bot** token from the [Discord Developer Portal](https://discord.com/developers/applications)
- Your bot must have these permissions in your server:
  - `Send Messages`
  - `Embed Links`
  - `Manage Messages`
  - `Read Message History`
  - `Use Application Commands`
  - `Manage Channels` (for ticket creation)

---

## 🏗️ Bot Structure & Workflow

### Architecture Overview

```
Discord Users / Admins
        │
        ▼
  Discord Gateway (discord.js)
        │
        ├── interactionCreate events
        │       ├── Slash commands (/addcard, /stock, /setstock, ...)
        │       ├── Select menu (amount selection)
        │       ├── Buttons (approve, reject, submit payment)
        │       └── Modals (payment detail form)
        │
        ├── Bot Ready (clientReady)
        │       ├── Set avatar + presence
        │       ├── Connect MySQL pool
        │       ├── Init tables + seed stock
        │       ├── Load saved offers from DB
        │       ├── Register slash commands
        │       ├── DB sync report → status channel
        │       ├── Cleanup + post fresh dashboard
        │       └── Cleanup + post fresh store embed
        │
        └── Auto-timers
                ├── Every 5 min  → refresh dashboard + store
                └── Every 30 min → DB sync report

Express HTTP Server (port 3001)
        ├── GET  /           → status JSON
        ├── GET  /health     → health check
        ├── GET  /webhook/success → payment success page
        ├── POST /webhook/razorpay  → Razorpay webhook (future)
        └── POST /webhook/cashfree → Cashfree webhook (future)

MySQL Database
        ├── gift_cards       → card codes + usage
        ├── transactions     → payment records
        ├── action_logs      → admin audit trail
        ├── bot_config       → saved message IDs, custom offers
        ├── stock_config     → max stock + sold counts
        ├── stock_history    → stock event history
        └── db_sync_log      → DB sync records
```

### Startup Sequence (what happens when bot starts)

1. `npm install` — dependencies installed automatically
2. `dotenv` loads environment variables from `.env`
3. Express server starts on port `3001`
4. Bot logs into Discord gateway
5. Bot sets activity status and profile picture
6. MySQL pool created, all tables initialized, stock seeded
7. Custom offers loaded from `bot_config` DB table
8. Slash commands registered globally with Discord
9. Startup DB sync runs → report posted to status channel
10. Old dashboard message deleted → fresh one posted
11. Old store embed deleted → fresh one posted
12. 5-minute refresh timer started
13. 30-minute DB sync timer started

### Shutdown Sequence

When the process receives `SIGTERM` or `SIGINT`:
1. Dashboard updated to "🔴 Bot Offline"
2. Discord client destroyed
3. MySQL pool closed

---

## 📁 Project Structure

```
GiftcardBotV2/
├── index.js            # Main bot code — all logic in one file (~1700+ lines)
│                         Contains: config, DB layer, helpers, slash commands,
│                         interaction handlers, store/dashboard builders, Express server
├── .env                # Environment variables (credentials, IDs, ports)
├── package.json        # Project metadata and npm dependencies
├── package-lock.json   # Locked dependency versions
├── start.sh            # Shell script: npm install → node index.js
└── README.md           # This file

Giftcardbot/            # Legacy v1 (unused — kept for reference)
```

### Key Sections in `index.js`

| Line Range | Section |
|---|---|
| 1–23 | Imports (discord.js, mysql2, express, razorpay, dotenv) |
| 27–80 | `CONFIG` object (reads from env vars) |
| 82–88 | Price helpers (`getPayPrice`, `getOfferLabel`) |
| 92–183 | Slash command definitions |
| 186–330 | Database layer (pool, reconnect, table init) |
| 332–382 | Bot config helpers (`getConfig`, `setConfig`, `saveOfferToDB`, `loadOffersFromDB`) |
| 384–435 | Auto DB sync |
| 437–480 | DB report poster |
| 482–544 | Stock helpers |
| 590–720 | Gift card delivery + ticket system |
| 740–800 | Store embed builder |
| 802–900 | Dashboard embed builder |
| 893–1000 | Post/update dashboard, cleanup helpers |
| 1005–1060 | Discord client setup, ready event, reconnect event |
| 1063–1610 | Interaction handler (all slash commands + buttons + modals) |
| 1612–1700 | Express routes + server |
| 1700–1757 | Bot login + graceful shutdown |

---

## 📦 Installation (Local / Replit)

### 1. Clone the repository

```bash
git clone https://github.com/your-username/your-repo.git
cd your-repo/GiftcardBotV2
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure `.env`

Copy or create the `.env` file:

```bash
cp .env.example .env   # if example exists
# OR create it manually
nano .env
```

Fill in your values (see [Configuration](#configuration-env) below).

### 4. Run the bot

```bash
node index.js
# OR
bash start.sh       # auto-installs deps first
# OR
npm start
```

---

## ⚙️ Configuration (.env)

All configuration is done via environment variables in `GiftcardBotV2/.env`:

```env
# Discord
BOT_TOKEN=your_discord_bot_token_here

# MySQL Database
DB_HOST=your_db_host
DB_USER=your_db_user
DB_PASSWORD=your_db_password
DB_NAME=your_db_name

# Discord Channel IDs
CHANNEL_ID=your_store_channel_id
STATUS_CHANNEL_ID=your_status_channel_id

# Admin Access (comma-separated Discord Role IDs)
ADMIN_ROLE_IDS=1475465692479361085,1471528112880746559

# Special Users with full access (comma-separated Discord User IDs)
SUPER_USER_IDS=879396413010743337,1054207830292447324,661812193242906675

# Store
UPI_ID=your-upi@bank
QR_IMAGE=https://link-to-your-qr-image.png
STORE_LOGO=https://link-to-your-logo.png
TEBEX_URL=https://yourstore.tebex.io

# Server
WEBHOOK_PORT=3001

# Payment Gateways (optional — future use)
RAZORPAY_KEY_ID=your_razorpay_key_id
RAZORPAY_KEY_SECRET=your_razorpay_key_secret
CASHFREE_APP_ID=your_cashfree_app_id
CASHFREE_SECRET_KEY=your_cashfree_secret_key
```

### Configuration Reference

| Variable | Required | Description |
|---|---|---|
| `BOT_TOKEN` | ✅ | Discord bot token from the Developer Portal |
| `DB_HOST` | ✅ | MySQL server IP or hostname |
| `DB_USER` | ✅ | MySQL username |
| `DB_PASSWORD` | ✅ | MySQL password |
| `DB_NAME` | ✅ | MySQL database name |
| `CHANNEL_ID` | ✅ | Discord channel ID where the store embed is posted |
| `STATUS_CHANNEL_ID` | ✅ | Discord channel ID for admin logs and dashboard |
| `ADMIN_ROLE_IDS` | ✅ | Comma-separated role IDs that can approve/reject payments |
| `SUPER_USER_IDS` | ✅ | Comma-separated user IDs with full admin access |
| `UPI_ID` | ✅ | Your UPI payment ID shown to users |
| `QR_IMAGE` | ✅ | Public URL to your UPI QR code image |
| `STORE_LOGO` | ✅ | Public URL to your store logo/thumbnail |
| `TEBEX_URL` | ✅ | Gift card redemption URL sent to users |
| `WEBHOOK_PORT` | ❌ | Port for the Express server (default: `3001`) |
| `RAZORPAY_KEY_ID` | ❌ | Razorpay key (future use) |
| `RAZORPAY_KEY_SECRET` | ❌ | Razorpay secret (future use) |

---

## 🤖 Slash Commands

All commands require the **Admin Role** (by role ID) or being a **Super User** (by user ID), or having the `Administrator` Discord permission.

| Command | Options | Description |
|---|---|---|
| `/addcard` | `amount` *(required)*, `code` *(required)*, `offer_pct` *(optional)*, `offer_price` *(optional)* | Add a gift card code to inventory and optionally set/update the denomination's discount offer |
| `/stock` | — | View current stock levels, sold counts, and limits for all denominations |
| `/setstock` | `amount` *(required)*, `limit` *(required)* | Update the maximum stock limit for a denomination |
| `/restockall` | — | Reset sold counts for all denominations to 0 |
| `/transactions` | `limit` *(optional, default 10)* | View recent transactions |
| `/store` | — | Manually post a fresh store embed in the current channel |
| `/dashboard` | — | View the live bot status dashboard |
| `/dbstatus` | — | View database health and sync history |
| `/dbsync` | — | Manually trigger a database sync and health check |

### `/addcard` — Offer Options Explained

The `/addcard` command accepts two optional offer parameters that update the **denomination's discount for all future purchases**. Changes are saved to the database and survive restarts.

| Option | Type | Description |
|---|---|---|
| `offer_pct` | Integer (0–99) | Discount percentage. Set to `0` to **remove** the offer entirely |
| `offer_price` | Integer | Exact amount users pay. If set without `offer_pct`, the percentage is auto-calculated |

**Examples:**

```
/addcard amount:₹1000 code:ABCD-EFGH
  → Adds card with no offer change (keeps current offer)

/addcard amount:₹1000 code:ABCD-EFGH offer_pct:15
  → Adds card + sets ₹1000 offer to 15% off (pay ₹850)

/addcard amount:₹1000 code:ABCD-EFGH offer_pct:10 offer_price:880
  → Adds card + sets ₹1000 offer to 10% off (pay ₹880, custom price)

/addcard amount:₹1000 code:ABCD-EFGH offer_price:900
  → Adds card + sets ₹1000 offer to 10% off (pay ₹900, pct auto-calculated)

/addcard amount:₹1000 code:ABCD-EFGH offer_pct:0
  → Adds card + REMOVES offer from ₹1000 (sold at face value)
```

---

## 🛒 How It Works

### Customer Flow

1. User sees the **store embed** in the designated channel with live stock and offers
2. User selects a gift card denomination from the dropdown menu
3. Bot shows payment instructions with the **UPI QR code** and UPI ID (ephemeral)
4. User pays, then clicks **"I've Paid — Submit Details"**
5. User fills in the modal: UPI Transaction ID, Sender Name, Payment App, optional Reference ID
6. Bot records the pending transaction and notifies admins in the status channel

### Admin Flow

1. Admin sees the payment notification in the status channel with **Approve** and **Reject** buttons
2. On **Approve**: bot marks transaction approved, finds an unused code in the DB, DMs it to the user
3. On **Reject**: bot marks transaction rejected, DMs the user a rejection notice
4. An XML transaction log is sent to the status channel for every event (submitted / approved / rejected)

### Out-of-Stock Handling

If a user pays but no codes are available (or the stock limit is reached):
- Bot creates a private **support ticket channel** for that user
- User is instructed to contact support

---

## 🌐 Webhook Endpoints

The Express server runs on port `3001` (configurable via `WEBHOOK_PORT`):

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Bot status JSON (online, DB connected, uptime) |
| `GET` | `/health` | Health check JSON `{ ok: true }` |
| `GET` | `/webhook/success` | Payment success HTML page |
| `POST` | `/webhook/razorpay` | Razorpay webhook (future) |
| `POST` | `/webhook/cashfree` | Cashfree webhook placeholder (future) |

---

## 🗄️ Database Tables

All tables are auto-created on startup — no manual SQL needed.

| Table | Description |
|---|---|
| `gift_cards` | All gift card codes with usage status, assigned user, and expiry |
| `transactions` | Payment records with UPI details, status, and timestamps |
| `action_logs` | Admin action audit trail |
| `bot_config` | Key-value store: saved message IDs, custom offers per denomination |
| `stock_config` | Max stock limits and sold counts per denomination |
| `stock_history` | Log of every stock event (sale, restock, limit change, manual add) |
| `db_sync_log` | Records of every DB health sync |

---

## ☁️ Host on AWS Linux VPS

This section covers hosting the bot 24/7 on an Ubuntu/Debian AWS EC2 instance using `pm2` as a process manager.

### Step 1 — Launch an EC2 Instance

1. Log in to the [AWS Console](https://aws.amazon.com/console/)
2. Go to **EC2 → Instances → Launch Instance**
3. Choose **Ubuntu 22.04 LTS** (free tier eligible: `t2.micro` or `t3.micro`)
4. Create or select a **Key Pair** (`.pem` file) — download and save it
5. In **Security Groups**, allow inbound:
   - **SSH** — port `22` (your IP or `0.0.0.0/0` for testing)
   - **Custom TCP** — port `3001` (for the webhook server, if needed externally)
6. Click **Launch Instance**

### Step 2 — Connect to Your VPS

On your local machine:

```bash
# Set correct permissions on your key file
chmod 400 ~/Downloads/your-key.pem

# Connect via SSH (replace with your EC2 public IP)
ssh -i ~/Downloads/your-key.pem ubuntu@YOUR_EC2_PUBLIC_IP
```

### Step 3 — Update the System

```bash
sudo apt update && sudo apt upgrade -y
```

### Step 4 — Install Node.js v20

```bash
# Install Node.js 20.x via NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Verify installation
node -v     # should show v20.x.x
npm -v      # should show 10.x.x
```

### Step 5 — Install Git

```bash
sudo apt install -y git
```

### Step 6 — Clone the Repository

```bash
# Clone your repo (use your actual GitHub repo URL)
git clone https://github.com/your-username/your-repo.git
cd your-repo/GiftcardBotV2
```

### Step 7 — Install Dependencies

```bash
npm install
```

### Step 8 — Create the .env File

```bash
nano .env
```

Paste your configuration (see [Configuration (.env)](#configuration-env)):

```env
BOT_TOKEN=your_discord_bot_token
DB_HOST=your_db_host
DB_USER=your_db_user
DB_PASSWORD=your_db_password
DB_NAME=your_db_name
CHANNEL_ID=your_store_channel_id
STATUS_CHANNEL_ID=your_status_channel_id
ADMIN_ROLE_IDS=1475465692479361085,1471528112880746559
SUPER_USER_IDS=879396413010743337,1054207830292447324,661812193242906675
UPI_ID=your-upi@bank
QR_IMAGE=https://your-qr-image-url.png
STORE_LOGO=https://your-logo-url.png
TEBEX_URL=https://yourstore.tebex.io
WEBHOOK_PORT=3001
```

Save and exit: press `Ctrl+X`, then `Y`, then `Enter`.

### Step 9 — Test the Bot Manually

```bash
node index.js
```

You should see:
```
[SERVER] Webhook server running on port 3001
[BOT] Logged in as YourBot#1234
[DB] All tables initialized.
[BOT] Slash commands registered.
[DASHBOARD CLEANUP] Fresh dashboard panel posted.
[STORE CLEANUP] Fresh store panel posted.
```

Press `Ctrl+C` to stop. If it works, proceed to the next step.

### Step 10 — Install PM2 (Process Manager)

PM2 keeps the bot running 24/7, auto-restarts it on crash, and starts it on server reboot.

```bash
sudo npm install -g pm2
```

### Step 11 — Start the Bot with PM2

```bash
# Start the bot
pm2 start index.js --name giftcard-bot

# Save PM2 process list so it survives reboots
pm2 save

# Set PM2 to auto-start on server reboot
pm2 startup
# → PM2 will print a command — COPY and RUN it (it looks like):
# sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u ubuntu --hp /home/ubuntu
```

Copy and run the exact command PM2 prints.

### Step 12 — Useful PM2 Commands

```bash
# View running processes
pm2 list

# View bot logs (live)
pm2 logs giftcard-bot

# View last 100 lines of logs
pm2 logs giftcard-bot --lines 100

# Restart the bot
pm2 restart giftcard-bot

# Stop the bot
pm2 stop giftcard-bot

# Delete the process
pm2 delete giftcard-bot

# Monitor CPU/RAM usage
pm2 monit
```

### Step 13 — Updating the Bot

When you push new changes to GitHub:

```bash
cd ~/your-repo/GiftcardBotV2

# Pull latest changes
git pull

# Install any new dependencies
npm install

# Restart the bot
pm2 restart giftcard-bot
```

### Step 14 — View Logs Persistently

```bash
# Install PM2 log rotation (optional but recommended)
pm2 install pm2-logrotate

# Logs are stored at:
~/.pm2/logs/giftcard-bot-out.log    # stdout
~/.pm2/logs/giftcard-bot-error.log  # stderr
```

### Security Tips for AWS

```bash
# Set up a basic firewall (UFW)
sudo ufw allow 22
sudo ufw allow 3001
sudo ufw enable
sudo ufw status

# Restrict .env file permissions
chmod 600 .env
```

---

## 🦕 Host on Pterodactyl

Pterodactyl is a game-server-style panel that runs processes in Docker containers.

### Requirements
- A Pterodactyl panel with a **Node.js egg** installed
- Access to create a new server on your panel

### Setup Steps

1. Create a new server using a **Node.js egg** (Node.js 20.x recommended)
2. Set the **startup command** to:
   ```
   npm install && node index.js
   ```
3. Upload all files from `GiftcardBotV2/` to the server's root directory
4. Either upload the `.env` file, or set each variable in the **Startup Variables** / **Environment Variables** section of the egg
5. Start the server — PM2 is not needed as Pterodactyl manages the process

---

## 🛠️ Troubleshooting

| Problem | Solution |
|---|---|
| `[LOGIN ERROR] An invalid token was provided` | Check `BOT_TOKEN` in `.env` is correct and has no extra spaces |
| DB connection fails / timeout | Verify `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` in `.env`. Ensure the DB server allows connections from your IP |
| Store embed not posting | Confirm the bot has access to `CHANNEL_ID` with `Send Messages` + `Embed Links` permissions |
| Slash commands not showing | Wait 1–2 minutes for Discord to sync global commands. Commands are re-registered every startup |
| Admins can't use commands | Check `ADMIN_ROLE_IDS` are the correct role IDs (right-click role → Copy ID). Also check `SUPER_USER_IDS` |
| Gift card not delivered | Verify codes exist via `/stock` or `/addcard`. Check the user hasn't blocked DMs |
| Port `3001` already in use | Change `WEBHOOK_PORT` in `.env` |
| Dashboard not updating after restart | This is fixed — the bot now deletes and reposts a fresh dashboard on every startup |
| Offer not saving across restarts | Offers set via `/addcard offer_pct` are saved to the `bot_config` DB table and loaded on every startup |
| Avatar update fails | Discord rate-limits avatar changes (max 2 per hour). Wait and restart |
| `pm2` bot not starting on reboot | Re-run `pm2 startup` and execute the printed command, then `pm2 save` |
