# Page Override — Main Dashboard

> Extends `../MASTER.md`. Only **layout-specific** rules live here. Anything not
> stated falls back to MASTER. Never contradict MASTER.

**File:** `src/pages/Dashboard.tsx` · **CSS:** Tailwind v4 utilities (`.tw` island) + `Dashboard.css` (SVG-chart classes only).

## Purpose
The operator's cockpit — answer "is my automation healthy + converting?" in one glance,
then act. Live status, KPI-led, trust-forward (engine pattern: *Real-Time / Operations*).

## Bento layout (12-col grid, `--bento-gap:16px`)
```
┌──────────────────────────────────────────────────────────────┐
│ PageHeader: title · subtitle · [● Connected] status badge      │
├──────────────────────────────────────────────────────────────┤
│ Quick Actions row: [+ Create bot] [Conversations] [Connect #]  │
├──────────────────────────────────────────────────────────────┤
│ Plan / trial tile ........................... col-span-12      │
├───────────┬───────────┬───────────┬──────────────────────────┤
│ Messages  │ Conv. rate│ Active    │ Conversions  (KPI ×4)     │
│ col-3     │ col-3     │ bots col-3│ col-3                     │
├───────────────────────────────────┬──────────────────────────┤
│ Conversations area chart  col-8   │ Channels donut   col-4    │
├───────────────────────────────────┼──────────────────────────┤
│ Recent WhatsApp chats     col-8   │ Bot performance  col-4    │
├───────────────────────────────────┴──────────────────────────┤
│ Sessions table ............................. col-span-12      │
└──────────────────────────────────────────────────────────────┘
```
Responsive: `xl` = full 12-col; `md` KPIs → 2-up, big tiles → col-12; `<md` everything stacks to 1 col. Tables scroll-x.

## Tile spec (Soft UI)
- Every tile: `bg-white border border-ink-200 rounded-card shadow-soft p-5`.
- Interactive tile (KPI, quick action) adds: `transition duration-200 hover:shadow-soft-lg hover:-translate-y-px cursor-pointer`.
- Section head inside a tile: eyebrow `text-h3 font-display` + `text-sm text-ink-500` subtitle.

## Data binding (do NOT change the data layer)
| Tile | Source field |
|---|---|
| Total messages | `messages_sent + messages_received` (fallback `messages_today`) |
| Booking conversion rate | `resolution_rate` (orders placed ÷ conversations) → `%` |
| Active bots | `useSessionStatsQuery().ready` |
| Conversions | `conversions_total` + 7-day trend |
| Conversations chart | `series[]` (14-day) → `AreaChart` |
| Channels donut | `channels{}` → `Donut` |
| Recent WhatsApp chats | `/funnel/orders` (last 6) → `activityLine()` |
| Bot performance | `messages_sent/received`, `response_rate` |
| Sessions | `useSessionsQuery()` |

## Color rules (this page)
- KPI accents are **teal-led**, no purple: conversations `--brand-600`, contacts `--brand-500`, conv-rate `--info-600`, conversions `--warning-600`.
- WhatsApp channel keeps `--signal-green #25D366`; connected status dot uses it.
- Status badges: success/warning/danger tints from MASTER (reuse `.status-pill`).

## Interaction
- KPI tile hover-raise 200ms; quick actions `cursor-pointer` + focus ring.
- Charts keep AA fallbacks (legend text, dashed 2nd series). `prefers-reduced-motion` already global.
- No emojis — Lucide only (`MessageSquare`, `Target`, `Zap`, `Smartphone`, `Plus`, `MessagesSquare`, `Send`, `Inbox`).

## Out of scope (keep as-is)
`AreaChart`, `Donut`, `Sparkline`, `ProgressBar` SVG components + their `Dashboard.css` classes; the two `useEffect` polling fetches; `useOrganization` plan logic.
