# Deploying Closwiz to Railway

Closwiz is a **monorepo**, so Railway needs **three services** — all from this same
GitHub repo, each with its own **Root Directory**. That's exactly the
"Set root directory" error you hit: Railway scanned the repo root (no app there).

| Service      | Root Directory     | Builder            | Public domain? |
|--------------|--------------------|--------------------|----------------|
| **Gateway**  | `OpenWA`           | Dockerfile         | no (private)   |
| **Brain**    | `api`              | Procfile (Python)  | no (private)   |
| **Dashboard**| `OpenWA/dashboard` | Dockerfile (nginx) | **yes**        |

Only the **Dashboard** is public (your sellers visit it). The brain ↔ gateway talk over
Railway's **private network** (`*.railway.internal`).

> 💡 Costs: 3 always-on services + a volume + Chromium RAM → expect a **paid** Railway plan.

---

## 0 · Before you start
- Apply the Supabase migrations (see `README.md` / `supabase/apply_billing_full.sql`).
- Have ready: **OpenRouter** key, **Supabase** `service_role` + `anon` keys, and a
  **gateway API key you invent** (a long random string — used as `API_MASTER_KEY`).

## 1 · Gateway (OpenWA) → port 2785
1. **New service → Deploy from GitHub repo → this repo.** Open the service → **Settings →
   Root Directory = `OpenWA`**. Railway detects the Dockerfile (it installs Chromium).
2. **Variables:**
   ```
   API_PORT=2785
   API_MASTER_KEY=<invent a long random key>
   NODE_ENV=production
   PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
   PUPPETEER_HEADLESS=true
   PUPPETEER_ARGS=--no-sandbox,--disable-setuid-sandbox,--disable-dev-shm-usage,--disable-gpu
   DATABASE_TYPE=sqlite
   SESSION_DATA_PATH=/data/sessions
   STORAGE_LOCAL_PATH=/data/media
   ```
3. **Settings → Networking →** set the **private target port to `2785`**. Do **not** add a
   public domain.
4. **Volume (critical):** add a Volume mounted at **`/data`**. This keeps the WhatsApp
   session + sqlite across redeploys — without it you re-scan the QR every deploy.
5. **Deploy.** Copy its private domain from Settings → Networking:
   `<gateway>.railway.internal`.

⚠️ Chromium is RAM-hungry. If the gateway OOMs/crashes on boot, raise the service memory.

## 2 · Brain (Flask) → port 5001
1. New service → same repo → **Root Directory = `api`**. Railpack detects Python +
   the `Procfile` (`web: python brain.py`).
2. **Variables:**
   ```
   PORT=5001
   HOST=::                                  # IPv6 — required for Railway private networking
   OPENROUTER_API_KEY=<your key>
   OPENROUTER_MODEL=openai/gpt-4o-mini
   SUPABASE_URL=https://<ref>.supabase.co
   SUPABASE_SERVICE_KEY=<service_role JWT>
   SUPABASE_ANON_KEY=<publishable key>
   OPENWA_API_URL=http://<gateway>.railway.internal:2785
   OPENWA_API_KEY=<the SAME API_MASTER_KEY from the gateway>
   PUBLIC_BASE_URL=http://${{RAILWAY_PRIVATE_DOMAIN}}:5001
   # OPENWA_SESSION_ID=<leave empty for now — you fill it in step 4>
   ```
   - `PUBLIC_BASE_URL` is how the gateway POSTs inbound messages back to the brain.
   - If the gateway rejects the `.railway.internal` host when registering the webhook,
     instead give the **brain** a public domain and set `PUBLIC_BASE_URL` to that
     `https://…up.railway.app`.
3. **Deploy.** Copy its private domain: `<brain>.railway.internal`.

## 3 · Dashboard (nginx) → public
1. New service → same repo → **Root Directory = `OpenWA/dashboard`**. Dockerfile (nginx).
2. **Variables:**
   ```
   GATEWAY_URL=http://<gateway>.railway.internal:2785
   BRAIN_URL=http://<brain>.railway.internal:5001
   ```
   (`PORT` is provided by Railway; nginx listens on it automatically.)
3. **Settings → Networking → Generate Domain.** This URL is what your sellers open.
4. **Deploy.**

## 4 · Pair WhatsApp in the cloud
1. ⚠️ **Stop your local gateway first.** You cannot run two gateways on the **same**
   WhatsApp number — they fight and keep disconnecting.
2. Open the dashboard's public URL → log in → **Sessions → New** → scan the QR.
3. When the session shows **ready**, copy its **UUID** → set it as the brain's
   **`OPENWA_SESSION_ID`** variable → **redeploy the brain** (it registers its webhook
   on that session at boot).
4. Send a WhatsApp test message → the bot should reply. 🎉

---

## How the repo is wired for this
- `api/Procfile` → `web: python brain.py`; the brain reads `PORT`/`HOST` from env and its
  webhook callback honours `PUBLIC_BASE_URL` / `RAILWAY_PRIVATE_DOMAIN`.
- `OpenWA/Dockerfile` → installs Chromium; data under `/app/data` (mount the volume there
  via `SESSION_DATA_PATH`/`STORAGE_LOCAL_PATH=/data/...`).
- `OpenWA/dashboard/Dockerfile` + `nginx.conf.template` → nginx proxies `/api` + `/socket.io`
  → `GATEWAY_URL` and `/funnel` → `BRAIN_URL`, listening on `$PORT`.

## Troubleshooting
- **"Set root directory"** → you didn't set a Root Directory (step 1/2/3).
- **Dashboard loads but products/billing fail** → `BRAIN_URL` wrong, or `/funnel` not
  reaching the brain.
- **Bot connects but never replies** → `OPENWA_SESSION_ID` stale, or the gateway can't
  reach the brain's `PUBLIC_BASE_URL` (check the brain logs for the registered webhook).
- **Gateway keeps disconnecting** → another device/gateway is on the same number, or the
  volume isn't mounted (session lost on redeploy).

> Secrets live **only** in Railway Variables — never in the repo. Local `.env` files keep
> working for local dev; Railway uses its own Variables.
