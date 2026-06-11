# Page Override — Automation Flow Builder (`/automation`)

> Extends `../MASTER.md`. Layout/interaction rules specific to the visual bot
> builder. Never contradict MASTER.

**Files:** `src/pages/FlowBuilder.tsx` · `src/flow/{types,catalog,flowReducer}` ·
Tailwind v4 utilities only (`.tw` island — zero new CSS files).

## Purpose
Let a seller design the bot's behaviour visually: pick a **trigger**, chain
**actions**, configure each block — without touching the data layer.

## Bento workspace (12-col, `gap-4`)
```
┌ PageHeader: title · [● Unsaved draft] badge · [Clear] [Save flow] ────────────┐
├───────────┬──────────────────────────────────────────────┬───────────────────┤
│ Palette   │ Canvas (pan + drag, dot-grid, inset shadow)  │ Inspector         │
│ col-2/3   │ col-7/6 — SVG bezier edges + node cards       │ col-3             │
└───────────┴──────────────────────────────────────────────┴───────────────────┘
```
`<lg` everything stacks to col-12 (palette → canvas → inspector).

## Graph model (strict TS — `src/flow/types.ts`)
- `BotNode { id, x, y, config: NodeConfig }` — `NodeConfig` is a **discriminated
  union** on `kind` (compile-time exhaustiveness in inspector + reducer).
- `BotEdge { id, from, to }` · `TriggerType` = keyword | any_message | ad_reference ·
  `ActionType` = send_text | send_media | delay | ask_question | tag_user | handoff_human.
- Node cards are **fixed 224×64** → edge anchors are arithmetic (no DOM measuring).

## State & performance contract
- Single pure reducer (`flowReducer.ts`) — every canvas mutation is one action.
- Pointer drags are **rAF-throttled**: pending point in a ref, ≤1 dispatch/frame.
- `NodeCard` is `React.memo`; derived sets (`nodeById`, `orphanIds`, `triggerCount`)
  are `useMemo`. Handlers are `useCallback` over a `stateRef` so they stay stable.
- Persistence: `localStorage` draft per seller (`closwiz_flow_draft_<sellerId>`),
  `FlowGraph v1` — serializer-ready for a future brain endpoint.

## Interactions (this page)
- **Add**: click a palette block → lands near canvas center (cascade offset).
- **Wire**: click a node's **out-port** (arms it, brand-filled) → click a target
  in-port/card. Esc or re-click cancels. Triggers have **no in-port**.
- **Select**: card or edge click; **Delete/Backspace** removes (guarded while
  typing in inspector fields). Edge selected → thicker `brand-700`.
- **Pan**: drag empty canvas; `Crosshair` button resets. Background dot-grid
  moves with the pan offset (`backgroundPosition`).
- **Validation**: no trigger → warning chip; action with no incoming edge →
  amber `AlertTriangle` dot on the card.

## Style rules (this page)
- Canvas: `bg-sunken` + `shadow-[inset_0_2px_6px_rgba(12,20,24,0.05)]` (Soft-UI
  recess) + 22px dot grid at `ink-500/22%`.
- Node card: `bg-surface border-ink-200 rounded-[12px] shadow-soft`, selected →
  `border-brand-600 ring-brand-600/25 shadow-soft-lg`; hover-raise 200ms.
- Edges: `brand-500` 1.75px bezier, chevron marker; selected `brand-700` 2.5px.
- Block accents (chip = `${accent}1a` bg, exact Dashboard KPI technique):
  triggers `#0F766E` · messaging `#0E7490` · delay `#B54708` · tag `#15803D` ·
  handoff `#5B6770`. Lucide only, `cursor-pointer` + focus rings everywhere.

## Out of scope (v1)
Zoom, undo/redo, multi-select, brain-side execution of flows (the draft is
stored locally and clearly labeled "Draft · this device").
