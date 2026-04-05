# IndexNow API Credentials Setup

IndexNow does not have a sign-up flow. You generate the key yourself and prove ownership by hosting a verification file on your domain.

---

## Step 1 — Generate a key

The key must be a lowercase hex string between 8 and 128 characters. Use one of these methods:

**Option A — Terminal (recommended):**
```bash
openssl rand -hex 16
# Example output: dae83f2c776a45ffa42825f4f1f523dc
```

**Option B — Node.js:**
```js
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
```

**Option C — Online:**
Visit https://www.uuidgenerator.net/ and remove the hyphens from the result.

---

## Step 2 — Create the verification file in TradeAero-Refactor

The file must be hosted at `https://trade.aero/{key}.txt` and contain **only the key string** (no newline, no spaces).

1. In the `tradeaero-refactor` repo, create `public/{your-key}.txt`
2. File contents = the key string only, e.g.:
   ```
   dae83f2c776a45ffa42825f4f1f523dc
   ```
3. Delete the old key file if rotating (e.g. `public/dae83f2c776a45ffa42825f4f1f523dc.txt`)
4. Commit and push to `main` — Vercel will deploy it automatically
5. Verify it is accessible: `curl https://trade.aero/{your-key}.txt`
   - Expected response: just the key string with HTTP 200

---

## Step 3 — Update the GitHub Actions secret

1. Go to **GitHub → TradeAero-Indexing → Settings → Secrets and variables → Actions**
2. Click the pencil icon next to `INDEXNOW_API_KEY`
3. Paste the new key and save

---

## Step 4 — Verify with a dry run

1. Go to **GitHub → TradeAero-Indexing → Actions → Index New Listings → Run workflow**
2. Set `dry_run` = `true`, click **Run workflow**
3. In the logs, confirm line 21 shows URLs starting with `https://api.indexnow.org`
4. No `401` or `403` response codes = key is valid

---

## Current credentials

| Secret | Location |
|---|---|
| `INDEXNOW_API_KEY` | GitHub Actions secret on TradeAero-Indexing |
| Verification file | `public/dae83f2c776a45ffa42825f4f1f523dc.txt` in TradeAero-Refactor |
| Live URL | `https://trade.aero/dae83f2c776a45ffa42825f4f1f523dc.txt` |

---

## Notes

- IndexNow covers **Bing, Yandex, Seznam, Naver** with a single submission — no separate keys needed per engine
- Google is handled separately via sitemap ping (`/api/admin/trigger-indexing`) and does not use the IndexNow key
- The key never expires unless you delete the verification file from the domain
- Rotating the key requires updating both the public file in TradeAero-Refactor **and** the GitHub secret — doing only one will cause `401` errors
