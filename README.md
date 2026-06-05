# Closwiz

**Closwiz** is a multi-tenant **WhatsApp commerce** SaaS. Each seller links their own
WhatsApp number, adds a product/service catalogue, and an AI agent chats with their
customers in real time — detecting the product, replying in the customer's own language,
collecting the order/booking details, and pushing confirmed orders to the seller's
Google Sheet (or Shopify). Sellers self-serve a **free trial**, then subscribe to a paid
plan (manual mobile-money / bank activation by an admin).

> **Stack:** Flask AI brain · OpenWA (NestJS) WhatsApp gateway · React + Vite + Tailwind
> dashboard · Supabase (Postgres + Auth + RLS + Storage) · OpenRouter LLMs.

---

## Architecture

```
   WhatsApp  ⇄  OpenWA Gateway (NestJS)        :2785   Chromium / WhatsApp-Web automation
                      │  ▲
       message.received│  │ send-text / send-image
                      ▼  │
              Brain — Flask (Python)            :5001   api/brain.py
              · 2-agent LLM pipeline (AI cascade)
              · business logic + tenant boundary
              · billing / free-trial gate
                      │  ▲
                 REST │  │ service_role (bypasses RLS)
                      ▼  │
              Supabase  (Postgres · Auth · RLS · Storage)
                      ▲
        /funnel + /api │ (Vite dev proxy)
                      │
              Dashboard — React + Vite          :2886   OpenWA/dashboard  (seller + admin UI)

   Landing page (static, FR/EN/AR)              :2887   closwiz-landing/
```

- The **gateway** drives WhatsApp Web and POSTs every inbound message to the brain's
  webhook (`/openwa/webhook`); the brain calls back to send replies and images.
- The **brain** owns all business logic and Supabase access. It runs a two-agent LLM
  pipeline — a cheap parser on routine turns + a premium communicator only on the
  closing/hot turn ("AI cascade", ~4–5× cheaper) — and is the multi-tenant boundary
  (every request is scoped by seller id via an `X-Seller-Id` header).
- The **dashboard** is what sellers and admins use; in dev it proxies `/api` → gateway
  and `/funnel` → brain.

## Repository layout

```
.
├── api/                 Flask brain (brain.py) + Python deps — the AI + business core
├── OpenWA/              WhatsApp gateway (NestJS), vendored from rmyndharis/OpenWA
│   └── dashboard/       Seller + admin dashboard (React + Vite + Tailwind v4)
├── closwiz-landing/     Marketing landing page (static, trilingual) + serve.py
├── admin/               Separate ops/admin back-office (React) — orders / agents
├── landing/             Earlier landing prototype (kept for reference)
└── supabase/            SQL migrations (000N_*.sql) + apply_billing_full.sql bundle
```

## Prerequisites

- **Node.js ≥ 20** and **Python ≥ 3.11**
- A **Supabase** project (free tier is fine)
- An **OpenRouter** API key (the operator's account pays for all tenants' AI usage)
- Chrome / Chromium (the gateway drives a headless browser)

## Setup & run

### 1 — Database (Supabase)

Apply the SQL migrations to your project, either with the Supabase CLI:

```bash
cd supabase
supabase link --project-ref <your-project-ref>
supabase db push
```

…or paste them into **Supabase → SQL Editor → Run** in order (`0001_…` → `0014_…`).
The billing layer (organizations + subscriptions + manual-payment) is bundled in
**`supabase/apply_billing_full.sql`** for a one-shot paste.

### 2 — Brain (Flask) → `:5001`

```bash
cd api
python -m venv venv
./venv/Scripts/pip install -r requirements.txt        # Windows
# source venv/bin/activate && pip install -r requirements.txt   # macOS / Linux
cp .env.example .env                                  # then fill the values (table below)
./venv/Scripts/python.exe brain.py                    # or: python brain.py
```

### 3 — WhatsApp gateway + dashboard → `:2785` + `:2886`

```bash
cd OpenWA
npm install                 # postinstall also installs dashboard/ dependencies
cp .env.example .env        # set the gateway port + storage (see OpenWA/.env.example)
npm run dev                 # runs the gateway (:2785) AND the dashboard (:2886) together
```

Open **http://localhost:2886**, sign up / log in, then **Sessions → New** to pair a
WhatsApp number by scanning the QR. Copy that session's UUID into the brain's
`OPENWA_SESSION_ID` and restart the brain so it registers its inbound webhook.

> Run pieces individually with `npm run start:dev` (gateway only) or
> `cd dashboard && npm run dev` (dashboard only).

### 4 — Landing page (optional) → `:2887`

```bash
cd closwiz-landing && python serve.py
```

## Environment variables (`api/.env`)

| Key | Purpose |
|---|---|
| `OPENROUTER_API_KEY` | OpenRouter key — pays for all AI usage |
| `OPENROUTER_MODEL` | Default model, e.g. `openai/gpt-4o-mini` |
| `SUPABASE_URL` | `https://<ref>.supabase.co` |
| `SUPABASE_SERVICE_KEY` | `service_role` JWT — **backend only**, bypasses RLS |
| `SUPABASE_ANON_KEY` | Publishable key — used by the frontend |
| `OPENWA_API_URL` | Gateway base URL (`http://localhost:2785`) |
| `OPENWA_API_KEY` | Gateway API key (sent as `X-API-Key`) |
| `OPENWA_SESSION_ID` | UUID of the live gateway session the bot listens on |

> ⚠️ **Never commit real `.env` files** — they are gitignored; only the `.env.example`
> templates (placeholders) are tracked. The same applies to `OpenWA/data/` (WhatsApp
> session credentials + sqlite), `api/data/` (payment references / settings), and all
> `*.log` files.

## Key features

- **AI cascade** — cheap parser on routine turns, premium model only when it matters.
- **Multilingual** — replies mirror the customer (French / Arabic / Darija / English),
  per product × country.
- **Free trial → paid plan** — self-serve trial; when it ends the seller is gated from
  connecting sessions and adding products/services until they choose a plan. The request
  goes `pending`, and an **admin activates it** after confirming a manual payment
  (Orange Money / bank transfer).
- **Photos on demand** — a customer asking for *"tsawr / صور / photos"* receives the
  product's saved images.
- **Per-number routing**, **Google Sheets** order export, **Shopify** integration, and
  **dynamic verticals** (e-commerce, restaurant, salon, car-rental, …).

## Security

Secrets live only in local `.env` files and the `*/data/` directories — all gitignored.
If you fork or redeploy, generate fresh keys, and never paste a `service_role` JWT into
frontend code or a public repository.

---

*Built with [Claude Code](https://claude.com/claude-code).*
