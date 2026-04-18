# Chronicle — Self-Hosting Guide

## Overview

Chronicle is designed so that no central server is required. Every installed app
runs its own embedded relay. This guide covers running a shared family relay on a
VPS so that family members can sync without being online simultaneously.

---

## Running the embedded relay standalone

The relay lives in `relay/server.js`. It requires Node.js 18+.

```bash
cd relay
npm install
PORT=4869 DB_PATH=./chronicle.db node server.js
```

Environment variables:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4869` | WebSocket port |
| `HOST` | `127.0.0.1` | Bind address (`0.0.0.0` for public) |
| `DB_PATH` | `./chronicle-relay.db` | SQLite database path |
| `ALLOWLIST_PATH` | `./allowlist.json` | JSON file of allowed pubkeys |

---

## Deploying on a VPS (recommended setup)

A $5/month VPS (e.g. DigitalOcean, Hetzner, Vultr) is sufficient for a family relay.

### 1. Install Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 2. Copy relay files

```bash
scp -r relay/ user@your-vps:/opt/chronicle-relay/
ssh user@your-vps "cd /opt/chronicle-relay && npm install"
```

### 3. Run with PM2 (process manager)

```bash
npm install -g pm2
pm2 start /opt/chronicle-relay/server.js --name chronicle-relay \
  --env production \
  -- --port 4869
pm2 startup
pm2 save
```

### 4. Expose via nginx + TLS (required for wss://)

Chronicle connections use `wss://` (WebSocket Secure). You need a TLS certificate.
[Let's Encrypt](https://letsencrypt.org) provides free certificates.

```nginx
server {
    listen 443 ssl;
    server_name relay.yourfamily.example;

    ssl_certificate     /etc/letsencrypt/live/relay.yourfamily.example/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/relay.yourfamily.example/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:4869;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

### 5. Update Chronicle settings

In Chronicle → Settings → Broadcasting, set your shared relay URL to:
`wss://relay.yourfamily.example`

---

## Allowlist management

By default the relay accepts connections from any pubkey. To restrict to family only:

```bash
# allowlist.json
["npub1alice...", "npub1bob...", "npub1carol..."]
```

Set `ALLOWLIST_PATH` to point at this file. Chronicle automatically adds your pubkey
to the local relay's allowlist when you create or import an identity.

---

## Backup

The relay database is a single SQLite file. Back it up regularly:

```bash
# Simple cron backup
0 3 * * * cp /opt/chronicle-relay/chronicle.db /backup/chronicle-relay-$(date +%Y%m%d).db
```
