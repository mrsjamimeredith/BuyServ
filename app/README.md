# BuyServ — Pinterest Affiliate Poster

An extremely easy-to-use app that posts your affiliate products to your business Pinterest pages. Paste in a product, pick a board, hit post. Or upload a CSV and bulk-post hundreds.

## What it does

- **Connect Pinterest** via OAuth (one click, lives in a browser cookie).
- **Pick or create a board** from the dropdown.
- **Add a product** — title, image URL, affiliate link, short description.
- **Post now** or save as draft.
- **Bulk CSV upload** — columns: `title`, `image_url`, `affiliate_url`, `description` (optional), `board` or `board_id` (optional).
- **"Post all drafts"** button — queues every saved draft to Pinterest in one go.
- Automatic **token refresh** and **retry-on-failure** visible in the product list.

## Setup (5 minutes)

### 1. Create a Pinterest app

1. Go to <https://developers.pinterest.com/apps/> and create a new app.
2. Under **Redirect URIs**, add: `http://localhost:3000/auth/callback` (or whatever host/port you'll run on).
3. Request these scopes: `user_accounts:read`, `pins:read`, `pins:write`, `boards:read`, `boards:write`.
4. Copy the **App ID** and **App secret**.

### 2. Configure the app

```bash
cd app
cp .env.example .env
```

Edit `.env`:

```
PINTEREST_CLIENT_ID=...
PINTEREST_CLIENT_SECRET=...
REDIRECT_URI=http://localhost:3000/auth/callback
SESSION_SECRET=any_random_string
PORT=3000
```

### 3. Install & run

```bash
npm install
npm start
```

Open <http://localhost:3000>, click **Connect Pinterest**, approve, and you're on the dashboard.

## Using it

**Single product**

1. Pick (or create) a board.
2. Fill in the product form.
3. Click **Save & post now** to publish immediately, or **Save as draft** to review first.

**Bulk**

1. Prepare a CSV (see `public/sample.csv` or click "Download sample" on the dashboard).
2. Upload it — rows import as drafts.
3. Click **Post all drafts**.

Failed posts are marked in red with the error message and can be retried individually.

## Notes & limits

- Pinterest hosts the image from the URL you provide — use a publicly reachable image link (your product image, CDN, etc.).
- Title is capped at 100 chars, description at 500 (Pinterest limits, enforced for you).
- Pinterest API rate-limits by app; heavy bulk posts may pause.
- Tokens are stored in a local SQLite file at `app/data/buyserv.db`. Don't commit it.

## Project layout

```
app/
  src/
    server.js       Express server, routes, CSV import
    pinterest.js    Pinterest v5 API client
    auth.js         Cookie session + token refresh
    db.js           SQLite schema & connection
  public/
    index.html      Landing / connect page
    dashboard.html  Main UI
    dashboard.js    Browser logic
    styles.css      Styling
    sample.csv      Example bulk-import file
  data/             SQLite DB lives here (gitignored)
  .env.example
  package.json
```

## Hosting somewhere other than localhost

Just set `REDIRECT_URI` to your public HTTPS callback URL and add the same value in your Pinterest app settings. Put Node behind nginx/caddy/etc. as you would any Express app.
