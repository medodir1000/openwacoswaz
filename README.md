# leadecombot

Multi-tenant WhatsApp SaaS for e-commerce sellers. Each seller pairs their own
WhatsApp number, uploads a product catalog with per-country language + price,
and the bot:

1. Detects the **product** from the customer's first message (LLM).
2. Detects the customer's **country** from their WhatsApp phone-number prefix.
3. Replies in the **language configured for that product × country**.
4. Walks the customer through ordering (name → phone → address → quantity → confirm).
5. Pushes the confirmed order to the seller's own **Google Sheets webhook**.

Built on the same proven stack as MediaHubAccess: Baileys (WhatsApp Web) +
Flask Python brain + OpenRouter LLM + Supabase (with RLS-based tenant
isolation) + Vite/React admin UI.

## Layout

```
leadecombot/
├── api/           Backend — Python Flask brain + Node Baileys bridge
├── admin/         Frontend — Vite + React + Tailwind seller dashboard
└── supabase/      DB migrations
```

## Local dev

```bash
# 1. Supabase schema
cd supabase && supabase login && supabase link --project-ref avvmyajtpnteljdttibn
supabase db push

# 2. Backend
cd ../api && python -m venv venv && ./venv/Scripts/pip install -r requirements.txt
npm install
cp .env.example .env  # then paste OPENROUTER_API_KEY + SUPABASE_SERVICE_KEY
npm run brain   # Python brain on :5001 (auto-respawn supervisor)
npm run dev     # Baileys bridge on :3002 (in another terminal)

# 3. Admin
cd ../admin && npm install && npm run dev   # Vite on :5181
```

## Ports

- **5001** — Python Flask brain
- **3002** — Node Express + Baileys bridge
- **5181** — Vite admin dev server

(All offset from MediaHubAccess defaults so both projects can run on the same machine.)

## Implementation status

See `/c/Users/lenovo/.claude/plans/sawb-li-landing-page-declarative-flame.md` for the full plan.

| Phase | Status |
|---|---|
| 0. Bootstrap | 🟡 in progress |
| 1. Supabase schema | ⏳ |
| 2. Brain core | ⏳ |
| 3. Bridge multi-account | ⏳ |
| 4. Admin UI | ⏳ |
| 5. End-to-end smoke test | ⏳ |
