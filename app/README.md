# BuyServ — Pinterest Affiliate Poster

A self-hosted app that automates posting affiliate products to your business Pinterest accounts. Multi-account, scheduled, rate-limited, and compliant with Pinterest + FTC rules by default.

---

## What it does

- **Multi-account**: connect as many Pinterest business accounts as you want, switch between them.
- **Paste a product URL → auto-filled draft** (Open Graph scraper: title, image, description).
- **Bulk URL import** and **CSV bulk import** (hundreds of products at once).
- **Upload images from disk** or generate them with **AI** (OpenAI `gpt-image-1`).
- **Video pins**: upload up to 50MB MP4/MOV, auto-register with Pinterest media API, poll for ready, attach cover image.
- **Analytics**: per-pin impressions / saves / pin clicks / outbound clicks, plus 30-day account totals. Auto-refreshed every 12 hours.
- **Schedule posts** for later, or **queue** to post ASAP.
- **Rate-limited background worker**: respects `daily_pin_limit` and `min_seconds_between_pins` per account so Pinterest doesn't flag you as spam.
- **Auto-disclosure**: appends `#affiliate #ad` to descriptions (FTC + Pinterest requirement) unless you turn it off.
- **Encrypted token storage**: Pinterest OAuth tokens encrypted at rest with AES-256-GCM.
- **Admin password gate + CSRF + login lockout**.

---

## Security model (read this)

This app stores tokens that can post to your Pinterest. Treat it like production software.

| Concern | What we do |
|---|---|
| Someone visits my instance URL | Admin password gate (first-run setup). 5 failed attempts = 15-min IP lockout. |
| DB file leaks | Pinterest tokens + refresh tokens are AES-256-GCM encrypted with a key derived from `SESSION_SECRET`. |
| Cross-site request forgery | All state-changing `/api/*` endpoints require an `x-csrf-token` header bound to your session. |
| Cookie theft | `httpOnly`, `SameSite=Lax`, `Secure` in production. |
| Brute-force | scrypt password hashing (N=16384). |

**Deployment checklist:**
- Put it behind HTTPS (Caddy/Cloudflare/nginx). Set `NODE_ENV=production`.
- Use a long random `SESSION_SECRET` (32+ bytes). Back it up somewhere safe — lose it and encrypted tokens are unrecoverable.
- Don't expose it to the open internet without auth. The admin password is your only wall.
- Regularly rotate Pinterest app credentials if compromised.

---

## Things I deliberately did NOT build, and why

You asked for a few things I'm not doing — please read this so we're aligned.

### ❌ Connecting a bank account

**Not building this.** Your Pinterest affiliate workflow has zero reason to touch your bank:
- Affiliate networks (Amazon Associates, ShareASale, Impact, CJ, Rakuten, etc.) pay you directly via ACH/PayPal. That doesn't need a third app in between.
- Storing bank credentials creates massive regulatory liability (PCI, GLBA). If someone compromises this app, they can post spammy pins (annoying, recoverable) — we should NOT also hand them your bank.
- If you ever need payment flows (e.g., paid Pinterest ads), use Plaid/Stripe OAuth as a separate, purpose-built integration. Don't bolt it onto a pinning app.

**Result: more secure by design.** Attackers can't drain what isn't connected.

### ❌ Auto-creating affiliate accounts with vendors

**Not building this.** Virtually every affiliate program — Amazon Associates, ShareASale, Impact, CJ, each brand's direct program — explicitly requires human applications, reviews your promotional methods, and bans bot-created accounts. Automating signup would:
1. Violate their ToS.
2. Get your accounts terminated and commissions clawed back.
3. Potentially be legal fraud.

**What I built instead:** tools that make you wildly more productive *after* you're approved — paste any product URL, generate pins with AI, schedule across accounts, bulk CSV.

Recommended flow: apply manually to 3–5 programs → use this app to crank output once approved.

### ❌ Midjourney integration

**Midjourney has no official API.** The unofficial APIs scrape Discord and violate Midjourney's ToS — using one here would risk your MJ account. I built a pluggable image-generation interface with **OpenAI `gpt-image-1`** as the provider (it's fast, reliable, and has an actual API). If Midjourney ships an official API, swap it in as a new provider in `src/aiImage.js`.

---

## Setup (5–10 min)

### 1. Pinterest app

1. <https://developers.pinterest.com/apps/> → create app.
2. Redirect URI: `http://localhost:3000/auth/callback` (or your public URL).
3. Scopes: `user_accounts:read`, `pins:read`, `pins:write`, `boards:read`, `boards:write`.

### 2. Configure

```bash
cd app
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"  # copy this into SESSION_SECRET
```

Fill `.env`:

```
PINTEREST_CLIENT_ID=...
PINTEREST_CLIENT_SECRET=...
REDIRECT_URI=http://localhost:3000/auth/callback
SESSION_SECRET=<paste the random hex>
OPENAI_API_KEY=sk-...   # optional; enables AI images
PORT=3000
NODE_ENV=development
```

### 3. Run

```bash
npm install
npm start
```

Open <http://localhost:3000>:

1. **Create admin password** (min 10 chars).
2. **Connect your first Pinterest account** (top right).
3. **Tune settings** for that account (daily limit, throttle, auto-disclose).
4. **Add products** — paste URL, upload image, or type by hand. Save as draft, queue now, or schedule.

Repeat step 2 for additional accounts.

---

## Using it day-to-day

**Fastest workflow (after affiliate approvals):**
1. Pick an account + board.
2. Drop a batch of product URLs into the bulk-URL box → "Fetch all as drafts".
3. Edit each draft, swap the URL for your affiliate link (Amazon SiteStripe, ShareASale deep link, etc.).
4. Click **Queue all drafts**. The scheduler posts them one by one, respecting your rate limit.

**Compliance-safe defaults:**
- Daily pin limit: 25 (Pinterest's recommended upper bound for automated posting).
- Throttle: 120s between pins.
- Auto-disclose: on (appends `#affiliate #ad`).
- Raise/lower per account as you build trust.

**Follow Pinterest's affiliate rules:**
- Link directly to the destination — no URL shorteners/cloakers.
- Don't re-post the same pin URL over and over.
- Use genuine descriptions, not keyword stuffing.

---

## Project layout

```
app/
  src/
    server.js       Express routes
    pinterest.js    Pinterest API v5 client
    auth.js         Admin auth + sessions + CSRF + account token store
    crypto.js       AES-256-GCM encryption at rest
    db.js           SQLite schema + migrations
    scheduler.js    Background worker (rate-limited posting)
    scraper.js      OG/Twitter meta extractor
    aiImage.js      OpenAI gpt-image-1 provider
    compliance.js   FTC disclosure + validation
  public/
    index.html / login.js      Setup + login
    dashboard.html / dashboard.js   Main UI
    styles.css
    sample.csv
  data/buyserv.db   SQLite (gitignored)
  .env.example
```

## Roadmap / open questions

- **Video pins**: Pinterest v5 supports them via a 2-step upload flow; add if needed.
- **Per-affiliate-network product feed pulls** (Amazon PA-API, ShareASale feed API, etc.) once you have accounts approved.
- **Team access**: currently single-admin. Add per-user roles if you bring on a VA.
- **Analytics pull-back**: fetch Pinterest impressions/saves per pin.
