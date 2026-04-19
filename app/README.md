# BuyServ — Pinterest Affiliate Poster

A self-hosted app that automates posting affiliate products to your business Pinterest accounts. Multi-account, multi-user, scheduled, rate-limited, compliant with Pinterest + FTC rules by default.

---

## What it does

### Core
- **Multi-account Pinterest** — connect as many business accounts as needed, switch in UI.
- **Paste a product URL → auto-filled draft** (Open Graph scraper).
- **Bulk import** — CSV or paste up to 50 URLs at once.
- **Amazon Associates integration** — search Amazon products via PA-API, pick with checkboxes, import as pre-tagged affiliate drafts.
- **Image sources** — URL, file upload (base64 to Pinterest, no hosting needed), or AI generation (OpenAI `gpt-image-1`).
- **Video pins** — upload up to 50MB MP4/MOV; app auto-registers with Pinterest media API, polls, attaches cover.
- **Schedule posts** for later, or **queue** to post ASAP.
- **Rate-limited background worker** — respects per-account `daily_pin_limit` and `min_seconds_between_pins`.
- **Analytics** — per-pin impressions/saves/pin-clicks/outbound-clicks + 30-day account totals; auto-refreshed every 12h.
- **Auto-disclosure** — appends `#affiliate #ad` to descriptions (FTC + Pinterest requirement).

### Team & security
- **Multi-user with roles**: `admin` / `editor` / `viewer`.
  - **admin**: everything — user management, connect Pinterest accounts, configure Amazon, all write ops.
  - **editor**: post / schedule / edit / delete products; no account or user management.
  - **viewer**: read-only.
- **AES-256-GCM encryption** of OAuth tokens + Amazon credentials at rest.
- **CSRF** tokens on all state-changing `/api/*` routes.
- **Login rate-limit**: 5 bad attempts per IP → 15-min lockout.
- **scrypt password hashing**, httpOnly/SameSite/Secure cookies, security headers.

---

## Setup (local, 5–10 min)

### 1. Pinterest app

1. <https://developers.pinterest.com/apps/> → create app.
2. Redirect URI: `http://localhost:3000/auth/callback` (or your public URL).
3. Scopes: `user_accounts:read`, `pins:read`, `pins:write`, `boards:read`, `boards:write`.

### 2. Configure

```bash
cd app
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"  # -> SESSION_SECRET
```

Fill `.env`:

```env
PINTEREST_CLIENT_ID=...
PINTEREST_CLIENT_SECRET=...
REDIRECT_URI=http://localhost:3000/auth/callback
SESSION_SECRET=<paste the random hex>
OPENAI_API_KEY=sk-...          # optional; enables AI images
PORT=3000
NODE_ENV=development
DOMAIN=localhost               # used by docker-compose only
```

### 3. Run

```bash
npm install
npm start
```

Open <http://localhost:3000>:

1. **Create admin account** (username + 10+ char password).
2. **Connect your first Pinterest account** (top right).
3. **(Optional) Add Amazon keys** (admin-only "Settings" in the Amazon card).
4. **Add team members** from the Team page (admin-only).
5. **Add products** — paste URL, upload image, or search Amazon.

---

## Hosting on your own domain (HTTPS, production)

This ships with a Docker Compose setup that runs the app behind [Caddy](https://caddyserver.com/), which handles TLS termination + Let's Encrypt certs automatically.

### Prereqs
- A server (any VPS — DigitalOcean $5 droplet is fine) with Docker + Docker Compose.
- A domain name. Point an A record at the server's public IP.

### Steps

```bash
# On your server
git clone https://github.com/mrsjamimeredith/BuyServ.git
cd BuyServ/app

# Configure env — set DOMAIN + REDIRECT_URI to your public HTTPS URL.
cp .env.example .env
# Edit .env:
#   DOMAIN=buyserv.yourdomain.com
#   REDIRECT_URI=https://buyserv.yourdomain.com/auth/callback
#   NODE_ENV=production
#   SESSION_SECRET=<long random>
# (And PINTEREST_CLIENT_ID / SECRET from your Pinterest app.)

# Update your Pinterest app's redirect URI in the developer dashboard
# to exactly match REDIRECT_URI above.

docker compose up -d --build
```

Caddy requests a Let's Encrypt cert on first HTTPS request. DNS must already be pointed at the server. Open `https://DOMAIN/` — create your admin, connect Pinterest, go.

Data is persisted in the `buyserv-data` Docker volume. Back it up (it holds your encrypted tokens).

---

## Security model

| Concern | What we do |
|---|---|
| Someone visits my instance URL | Admin password gate + user accounts w/ roles. 5 bad logins = 15-min IP lockout. |
| DB leak | Pinterest tokens, refresh tokens, Amazon keys are AES-256-GCM encrypted w/ scrypt-derived key from `SESSION_SECRET`. |
| CSRF | `x-csrf-token` header required on every state-changing request, bound to session cookie via HMAC. |
| Cookie theft | `httpOnly`, `SameSite=Lax`, `Secure` in production. |
| Brute-force | scrypt hashes (N=16384). |
| Behind reverse proxy | `trust proxy` enabled in production so login lockouts work on real client IP. |

**Operational checklist:**
- Long random `SESSION_SECRET`; back it up — losing it makes encrypted tokens unrecoverable.
- Run behind HTTPS (Docker Compose setup does this automatically).
- Regularly rotate Pinterest app credentials if compromised.
- Give your VA an **editor** account, not admin.

---

## Things deliberately NOT built

### ❌ Bank account connection
Affiliate networks pay you directly; this app has no legitimate reason to touch your bank. Storing bank credentials = massive liability for zero upside.

### ❌ Auto-creating affiliate accounts
Every affiliate program (Amazon Associates, ShareASale, Impact, CJ, Rakuten) requires human applications + reviews. Automation violates their ToS and gets accounts banned with commissions clawed back.

### ❌ Midjourney integration
MJ has no official API. Unofficial Discord scrapers violate MJ ToS. I used OpenAI `gpt-image-1` instead, behind a pluggable provider interface in `src/aiImage.js` — when MJ ships an official API it's one file to add.

---

## Amazon Associates: important note

Amazon grants **PA-API keys only after you've made 3 qualifying sales within 180 days** of joining. New Associates often don't have API access yet.

If you don't have keys yet:
- Use Pinterest SiteStripe + this app's URL scraper: paste any Amazon product URL, it auto-fills the draft, then swap the link for your SiteStripe affiliate URL.

Once you have PA-API keys:
- Admins → Amazon card → Settings → paste Access Key, Secret Key, Associate Tag, marketplace → Save.
- Use the search box to bulk-find products; checked products import as drafts with your `?tag=` already appended.

---

## Development

```bash
cd app
npm install
npm run dev    # auto-restart on file changes
npm test       # run the test suite
```

Tests cover: compliance helpers, encryption roundtrip, Open Graph scraper, password hashing. CI runs them on every push/PR (`.github/workflows/ci.yml`).

## Project layout

```
app/
  src/
    server.js       Express routes
    pinterest.js    Pinterest v5 client (pins, media, analytics)
    amazon.js       Amazon PA-API v5 client (SigV4 signed)
    auth.js         Users + sessions + CSRF + Pinterest token store
    crypto.js       AES-256-GCM at-rest encryption
    db.js           SQLite schema + migrations
    scheduler.js    Background worker (rate-limited posting + analytics)
    scraper.js      Open Graph / Twitter meta extractor
    aiImage.js      Pluggable AI image provider (OpenAI)
    compliance.js   FTC disclosure + validation
  public/
    index.html + login.js       Setup & login
    dashboard.html + dashboard.js   Main UI
    users.html + users.js       Admin-only user management
    styles.css
    sample.csv
  test/             node:test suite
  Dockerfile, docker-compose.yml, Caddyfile   production hosting
  data/buyserv.db   SQLite (gitignored; persisted to Docker volume in prod)
  .env.example
```
