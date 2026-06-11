/* ============================================================================
   Flow Builder — visual bot automation workspace (design-system/MASTER.md).

   Bento 3-pane: Palette (triggers/actions) · Canvas (drag nodes, click-port →
   click-target to wire bezier edges) · Inspector (per-kind config form).

   Performance contract for the canvas:
   • Pointer drags never dispatch more than once per animation frame (the
     pending point lives in a ref; a single rAF flushes it), so the main
     thread stays free even while dragging fast.
   • Node cards are React.memo with primitive-ish props — only the dragged
     node (and the SVG edge layer) re-renders per frame.
   • Node cards are FIXED SIZE (types.NODE_W/H) so edge anchors are pure
     arithmetic — zero DOM measurement during drag.

   Persistence: localStorage draft per seller (no brain endpoint yet — the
   eyebrow badge says so honestly). Shape = FlowGraph v1, serializer-ready.
   ========================================================================== */
import { memo, useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Save, Trash2, Crosshair, MousePointerClick, AlertTriangle, Workflow,
  CircleDot, X,
} from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { useToast } from '../components/Toast';
import { CATALOG, catalogByKind, nodeSummary, type CatalogEntry } from '../flow/catalog';
import { flowReducer, initialFlowState } from '../flow/flowReducer';
import type { BotEdge, BotNode, FlowGraph, NodeConfig, Selection } from '../flow/types';
import { NODE_W, NODE_H, PORT_Y, categoryOf } from '../flow/types';

const STORAGE_PREFIX = 'closwiz_flow_draft_';

const storageKey = (): string =>
  STORAGE_PREFIX + (sessionStorage.getItem('leadecombot_seller_id') || 'anon');

function loadDraft(): FlowGraph | null {
  try {
    const raw = localStorage.getItem(storageKey());
    if (!raw) return null;
    const parsed = JSON.parse(raw) as FlowGraph;
    if (parsed?.version !== 1 || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/* Shared field styling — MASTER §8 input contract. */
const inputCls =
  'w-full rounded-[10px] border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-900 ' +
  'placeholder:text-ink-400 outline-none transition duration-150 ' +
  'focus-visible:border-brand-600 focus-visible:ring-2 focus-visible:ring-brand-600/30';
const fieldLabelCls =
  'mb-1 block text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-500';

/* ── Edge path geometry (pure) ───────────────────────────────────────────── */
function edgePath(from: BotNode, to: BotNode): string {
  const x1 = from.x + NODE_W, y1 = from.y + PORT_Y;
  const x2 = to.x, y2 = to.y + PORT_Y;
  const c = Math.max(48, Math.abs(x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + c} ${y1}, ${x2 - c} ${y2}, ${x2} ${y2}`;
}

/* ── Node card (memo — only the dragged/selected card re-renders) ────────── */
interface NodeCardProps {
  node: BotNode;
  selected: boolean;
  linkArmed: boolean;       // an out-port is pending somewhere on the canvas
  isLinkSource: boolean;    // this node IS the pending source
  orphan: boolean;          // action node with no incoming edge
  label: string;
  onPointerDown: (e: React.PointerEvent, id: string) => void;
  onStartLink: (id: string) => void;
  onCompleteLink: (id: string) => void;
}

const NodeCard = memo(function NodeCard({
  node, selected, linkArmed, isLinkSource, orphan, label,
  onPointerDown, onStartLink, onCompleteLink,
}: NodeCardProps) {
  const entry = catalogByKind(node.config.kind);
  const Icon = entry.icon;
  const isTrigger = categoryOf(node.config.kind) === 'trigger';
  const canReceive = linkArmed && !isTrigger && !isLinkSource;

  return (
    <div
      data-node-id={node.id}
      onPointerDown={e => onPointerDown(e, node.id)}
      className={
        'absolute select-none touch-none cursor-grab active:cursor-grabbing rounded-[12px] border bg-surface ' +
        'transition-[box-shadow,border-color] duration-200 ' +
        (selected
          ? 'border-brand-600 shadow-soft-lg ring-2 ring-brand-600/25'
          : 'border-ink-200 shadow-soft hover:shadow-soft-lg') +
        (canReceive ? ' ring-2 ring-brand-400/50' : '')
      }
      style={{ left: node.x, top: node.y, width: NODE_W, height: NODE_H }}
      role="group"
      aria-label={label}
    >
      <div className="flex h-full items-center gap-2.5 px-3">
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]"
          style={{ background: `${entry.accent}1a`, color: entry.accent }}
          aria-hidden="true"
        >
          <Icon size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-semibold text-ink-900">{label}</span>
            {orphan && (
              <span title="Not connected" aria-label="Not connected">
                <AlertTriangle size={12} className="shrink-0 text-warning" />
              </span>
            )}
          </div>
          <div className="truncate text-xs text-ink-500">{nodeSummary(node.config)}</div>
        </div>
      </div>

      {/* In-port — triggers are entry points, they have none. */}
      {!isTrigger && (
        <button
          type="button"
          aria-label="Connect into this block"
          onClick={() => onCompleteLink(node.id)}
          className={
            'absolute -left-2 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full border-2 bg-surface cursor-pointer ' +
            'transition duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600/40 ' +
            (canReceive
              ? 'border-brand-500 scale-125 bg-brand-100'
              : 'border-ink-300 hover:border-brand-500')
          }
        />
      )}
      {/* Out-port — click to arm a connection. */}
      <button
        type="button"
        aria-label="Start a connection from this block"
        aria-pressed={isLinkSource}
        onClick={() => onStartLink(node.id)}
        className={
          'absolute -right-2 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full border-2 cursor-pointer ' +
          'transition duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600/40 ' +
          (isLinkSource
            ? 'border-brand-600 bg-brand-600 scale-125'
            : 'border-ink-300 bg-surface hover:border-brand-500')
        }
      />
    </div>
  );
});

/* ── Inspector field set per node kind (discriminated union switch) ──────── */
function InspectorFields({
  config, onChange, t,
}: {
  config: NodeConfig;
  onChange: (next: NodeConfig) => void;
  t: (k: string, d: string) => string;
}) {
  switch (config.kind) {
    case 'keyword':
      return (
        <>
          <div>
            <label className={fieldLabelCls}>{t('flow.cfg.keywords', 'Keywords (comma-separated)')}</label>
            <input className={inputCls} value={config.keywords} placeholder="promo, ihair, prix"
                   onChange={e => onChange({ ...config, keywords: e.target.value })} />
          </div>
          <div>
            <label className={fieldLabelCls}>{t('flow.cfg.matchMode', 'Match mode')}</label>
            <select className={inputCls + ' cursor-pointer'} value={config.matchMode}
                    onChange={e => onChange({ ...config, matchMode: e.target.value as 'contains' | 'exact' })}>
              <option value="contains">{t('flow.cfg.contains', 'Contains')}</option>
              <option value="exact">{t('flow.cfg.exact', 'Exact match')}</option>
            </select>
          </div>
        </>
      );
    case 'any_message':
      return <p className="text-sm text-ink-500">{t('flow.cfg.anyMessage', 'Fires for every first message in a new conversation. No settings.')}</p>;
    case 'ad_reference':
      return (
        <div>
          <label className={fieldLabelCls}>{t('flow.cfg.adName', 'Ad / product name')}</label>
          <input className={inputCls} value={config.adName} placeholder="IHAIR serum"
                 onChange={e => onChange({ ...config, adName: e.target.value })} />
        </div>
      );
    case 'send_text':
      return (
        <>
          <div>
            <label className={fieldLabelCls}>{t('flow.cfg.message', 'Message')}</label>
            <textarea className={inputCls + ' min-h-[96px] resize-y'} value={config.text}
                      placeholder={t('flow.cfg.messagePh', 'Bonjour 👋 — comment puis-je aider ?')}
                      onChange={e => onChange({ ...config, text: e.target.value })} />
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-700">
            <input type="checkbox" checked={config.humanTyping}
                   onChange={e => onChange({ ...config, humanTyping: e.target.checked })} />
            {t('flow.cfg.humanTyping', 'Human-like typing delay')}
          </label>
        </>
      );
    case 'send_media':
      return (
        <>
          <div>
            <label className={fieldLabelCls}>{t('flow.cfg.mediaUrl', 'Image / file URL')}</label>
            <input className={inputCls} value={config.url} placeholder="https://…"
                   onChange={e => onChange({ ...config, url: e.target.value })} />
          </div>
          <div>
            <label className={fieldLabelCls}>{t('flow.cfg.caption', 'Caption (optional)')}</label>
            <input className={inputCls} value={config.caption}
                   onChange={e => onChange({ ...config, caption: e.target.value })} />
          </div>
        </>
      );
    case 'delay':
      return (
        <div>
          <label className={fieldLabelCls}>{t('flow.cfg.delay', 'Wait (seconds)')}</label>
          <input className={inputCls} type="number" min={1} max={3600} value={config.seconds}
                 onChange={e => onChange({ ...config, seconds: Math.max(1, Math.min(3600, Math.round(Number(e.target.value) || 1))) })} />
        </div>
      );
    case 'ask_question':
      return (
        <>
          <div>
            <label className={fieldLabelCls}>{t('flow.cfg.question', 'Question')}</label>
            <textarea className={inputCls + ' min-h-[72px] resize-y'} value={config.question}
                      onChange={e => onChange({ ...config, question: e.target.value })} />
          </div>
          <div>
            <label className={fieldLabelCls}>{t('flow.cfg.saveAs', 'Save answer as')}</label>
            <input className={inputCls} value={config.saveAs} placeholder="city / quantity / name"
                   onChange={e => onChange({ ...config, saveAs: e.target.value })} />
          </div>
        </>
      );
    case 'tag_user':
      return (
        <div>
          <label className={fieldLabelCls}>{t('flow.cfg.tag', 'Tag')}</label>
          <input className={inputCls} value={config.tag} placeholder="VIP"
                 onChange={e => onChange({ ...config, tag: e.target.value })} />
        </div>
      );
    case 'handoff_human':
      return (
        <div>
          <label className={fieldLabelCls}>{t('flow.cfg.note', 'Note for the agent')}</label>
          <textarea className={inputCls + ' min-h-[72px] resize-y'} value={config.note}
                    onChange={e => onChange({ ...config, note: e.target.value })} />
        </div>
      );
  }
}

/* ── Page ────────────────────────────────────────────────────────────────── */
export default function FlowBuilder() {
  const { t } = useTranslation();
  const toast = useToast();
  const [state, dispatch] = useReducer(flowReducer, initialFlowState);
  const canvasRef = useRef<HTMLDivElement>(null);

  /* rAF-throttled drag: pointermove stores the point in a ref; one rAF per
     frame flushes it into a single dispatch. */
  const dragRef = useRef<{ mode: 'node' | 'pan'; id?: string; sx: number; sy: number; bx: number; by: number } | null>(null);
  const pendingRef = useRef<{ x: number; y: number } | null>(null);
  const rafRef = useRef(0);

  const flushDrag = useCallback(() => {
    rafRef.current = 0;
    const d = dragRef.current, p = pendingRef.current;
    if (!d || !p) return;
    const dx = p.x - d.sx, dy = p.y - d.sy;
    if (d.mode === 'node' && d.id) {
      dispatch({ type: 'MOVE_NODE', id: d.id, x: Math.round(d.bx + dx), y: Math.round(d.by + dy) });
    } else {
      dispatch({ type: 'PAN', ox: d.bx + dx, oy: d.by + dy });
    }
  }, []);

  const onCanvasPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    pendingRef.current = { x: e.clientX, y: e.clientY };
    if (!rafRef.current) rafRef.current = requestAnimationFrame(flushDrag);
  }, [flushDrag]);

  const endDrag = useCallback(() => { dragRef.current = null; pendingRef.current = null; }, []);
  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  const onNodePointerDown = useCallback((e: React.PointerEvent, id: string) => {
    // Port buttons handle their own clicks — don't start a drag from them.
    if ((e.target as HTMLElement).closest('button')) return;
    const node = stateRef.current.nodes.find(n => n.id === id);
    if (!node) return;
    dispatch({ type: 'SELECT', selection: { type: 'node', id } });
    dragRef.current = { mode: 'node', id, sx: e.clientX, sy: e.clientY, bx: node.x, by: node.y };
    canvasRef.current?.setPointerCapture(e.pointerId);
  }, []);

  const onCanvasPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.target !== e.currentTarget) return; // only true background starts a pan
    dispatch({ type: 'SELECT', selection: null });
    dragRef.current = { mode: 'pan', sx: e.clientX, sy: e.clientY, bx: stateRef.current.view.ox, by: stateRef.current.view.oy };
    canvasRef.current?.setPointerCapture(e.pointerId);
  }, []);

  /* state in a ref so the pointer handlers above stay referentially stable. */
  const stateRef = useRef(state);
  stateRef.current = state;

  /* Load the seller's draft once. */
  useEffect(() => {
    const draft = loadDraft();
    if (draft) dispatch({ type: 'LOAD', graph: draft });
  }, []);

  /* Keyboard: Delete removes the selection, Escape cancels a pending link —
     but never while the user is typing in the inspector. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select';
      if (e.key === 'Escape') dispatch({ type: 'CANCEL_LINK' });
      if (!typing && (e.key === 'Delete' || e.key === 'Backspace')) dispatch({ type: 'DELETE_SELECTED' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const addNode = useCallback((entry: CatalogEntry) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    const n = stateRef.current.nodes.length;
    const x = Math.round((rect ? rect.width / 2 : 360) - stateRef.current.view.ox - NODE_W / 2 + (n % 4) * 28);
    const y = Math.round(96 - stateRef.current.view.oy + (n % 6) * 40);
    dispatch({ type: 'ADD_NODE', kind: entry.kind, x, y });
  }, []);

  const saveDraft = useCallback(() => {
    const graph: FlowGraph = { version: 1, nodes: stateRef.current.nodes, edges: stateRef.current.edges };
    try {
      localStorage.setItem(storageKey(), JSON.stringify(graph));
      dispatch({ type: 'MARK_SAVED' });
      toast.success(t('flow.toast.savedTitle', 'Flow saved'), t('flow.toast.savedDesc', 'Draft stored on this device.'));
    } catch {
      toast.error(t('flow.toast.saveFailTitle', 'Save failed'), t('flow.toast.saveFailDesc', 'Local storage is unavailable.'));
    }
  }, [t, toast]);

  /* Derived views (memo — recomputed only when the graph changes). */
  const nodeById = useMemo(() => new Map(state.nodes.map(n => [n.id, n])), [state.nodes]);
  const triggerCount = useMemo(
    () => state.nodes.filter(n => categoryOf(n.config.kind) === 'trigger').length,
    [state.nodes],
  );
  const orphanIds = useMemo(() => {
    const hasIncoming = new Set(state.edges.map(e => e.to));
    return new Set(
      state.nodes
        .filter(n => categoryOf(n.config.kind) !== 'trigger' && !hasIncoming.has(n.id))
        .map(n => n.id),
    );
  }, [state.nodes, state.edges]);

  const selectedNode: BotNode | null =
    state.selected?.type === 'node' ? nodeById.get(state.selected.id) ?? null : null;
  const selectedEdge: BotEdge | null =
    state.selected?.type === 'edge' ? state.edges.find(e => e.id === state.selected!.id) ?? null : null;

  const onSelectEdge = useCallback((sel: Selection) => dispatch({ type: 'SELECT', selection: sel }), []);
  const onStartLink = useCallback((id: string) => dispatch({ type: 'START_LINK', from: id }), []);
  const onCompleteLink = useCallback((id: string) => {
    if (stateRef.current.linkFrom) dispatch({ type: 'COMPLETE_LINK', to: id });
  }, []);
  const onConfigChange = useCallback((id: string, config: NodeConfig) => {
    dispatch({ type: 'UPDATE_CONFIG', id, config });
  }, []);

  const triggers = useMemo(() => CATALOG.filter(c => c.category === 'trigger'), []);
  const actions = useMemo(() => CATALOG.filter(c => c.category === 'action'), []);

  return (
    <div className="tw flex h-full min-h-0 flex-col font-sans text-ink-700">
      <PageHeader
        title={t('flow.title', 'Automation')}
        subtitle={t('flow.subtitle', 'Design how the bot reacts — triggers, replies, delays, handoffs.')}
        badge={
          <span className="tw inline-flex items-center gap-1.5 rounded-pill border border-ink-200 bg-surface px-2.5 py-1 text-[11px] font-semibold text-ink-500">
            <CircleDot size={11} className={state.dirty ? 'text-warning' : 'text-success'} />
            {state.dirty ? t('flow.draftDirty', 'Unsaved draft') : t('flow.draftSaved', 'Draft · this device')}
          </span>
        }
        actions={
          <div className="tw flex items-center gap-2">
            <button
              type="button"
              onClick={() => dispatch({ type: 'CLEAR' })}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-[10px] border border-ink-200 bg-surface px-3 py-2 text-sm font-semibold text-ink-600 transition duration-150 hover:bg-ink-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600/40"
            >
              <Trash2 size={15} /> {t('flow.clear', 'Clear')}
            </button>
            <button
              type="button"
              onClick={saveDraft}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-[10px] bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white transition duration-150 hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600/40"
            >
              <Save size={15} /> {t('flow.save', 'Save flow')}
            </button>
          </div>
        }
      />

      {/* Workspace bento: palette · canvas · inspector */}
      <div className="grid min-h-[560px] flex-1 grid-cols-12 gap-4">
        {/* ── Palette ── */}
        <aside className="col-span-12 rounded-card border border-ink-200 bg-surface p-4 shadow-soft lg:col-span-3 xl:col-span-2">
          <h2 className="font-display text-sm font-bold text-ink-900">{t('flow.palette.title', 'Blocks')}</h2>
          <p className="mb-3 text-xs text-ink-500">{t('flow.palette.hint', 'Click a block to add it to the canvas.')}</p>

          <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-500">
            {t('flow.palette.triggers', 'Triggers')}
          </div>
          <div className="mb-4 flex flex-col gap-1.5">
            {triggers.map(entry => <PaletteItem key={entry.kind} entry={entry} onAdd={addNode} t={t} />)}
          </div>

          <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-500">
            {t('flow.palette.actions', 'Actions')}
          </div>
          <div className="flex flex-col gap-1.5">
            {actions.map(entry => <PaletteItem key={entry.kind} entry={entry} onAdd={addNode} t={t} />)}
          </div>
        </aside>

        {/* ── Canvas ── */}
        <section className="relative col-span-12 min-h-[480px] overflow-hidden rounded-card border border-ink-200 bg-sunken shadow-[inset_0_2px_6px_rgba(12,20,24,0.05)] lg:col-span-6 xl:col-span-7">
          {/* status chips */}
          <div className="pointer-events-none absolute left-3 top-3 z-20 flex flex-wrap items-center gap-2">
            {triggerCount === 0 && state.nodes.length > 0 && (
              <span className="inline-flex items-center gap-1.5 rounded-pill bg-warning-tint px-2.5 py-1 text-[11px] font-semibold text-warning">
                <AlertTriangle size={12} /> {t('flow.noTrigger', 'Add a trigger so the flow can start')}
              </span>
            )}
            {state.linkFrom && (
              <span className="inline-flex items-center gap-1.5 rounded-pill bg-brand-100 px-2.5 py-1 text-[11px] font-semibold text-brand-800">
                <MousePointerClick size={12} /> {t('flow.linkArmed', 'Click a target block — Esc cancels')}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => dispatch({ type: 'PAN', ox: 0, oy: 0 })}
            aria-label={t('flow.centerView', 'Center view')}
            title={t('flow.centerView', 'Center view')}
            className="absolute right-3 top-3 z-20 inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-[10px] border border-ink-200 bg-surface text-ink-600 shadow-soft transition duration-150 hover:text-brand-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600/40"
          >
            <Crosshair size={15} />
          </button>

          <div
            ref={canvasRef}
            onPointerDown={onCanvasPointerDown}
            onPointerMove={onCanvasPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            className="absolute inset-0 touch-none"
            style={{
              backgroundImage: 'radial-gradient(rgba(91,103,112,0.22) 1px, transparent 1px)',
              backgroundSize: '22px 22px',
              backgroundPosition: `${state.view.ox}px ${state.view.oy}px`,
              cursor: dragRef.current?.mode === 'pan' ? 'grabbing' : 'default',
            }}
          >
            {/* Edge layer */}
            <svg className="absolute inset-0 h-full w-full" aria-hidden="true">
              <defs>
                <marker id="flow-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </marker>
              </defs>
              <g transform={`translate(${state.view.ox},${state.view.oy})`}>
                {state.edges.map(edge => {
                  const from = nodeById.get(edge.from);
                  const to = nodeById.get(edge.to);
                  if (!from || !to) return null;
                  const isSel = state.selected?.type === 'edge' && state.selected.id === edge.id;
                  return (
                    <path
                      key={edge.id}
                      d={edgePath(from, to)}
                      fill="none"
                      stroke={isSel ? '#0B5C56' : '#13A08A'}
                      strokeWidth={isSel ? 2.5 : 1.75}
                      markerEnd="url(#flow-arrow)"
                      className="cursor-pointer transition-[stroke] duration-150"
                      style={{ pointerEvents: 'stroke' }}
                      onClick={() => onSelectEdge({ type: 'edge', id: edge.id })}
                    />
                  );
                })}
              </g>
            </svg>

            {/* Node layer (pan via transform — one cheap style write per frame) */}
            <div className="absolute inset-0" style={{ transform: `translate(${state.view.ox}px, ${state.view.oy}px)` }}>
              {state.nodes.map(node => (
                <NodeCard
                  key={node.id}
                  node={node}
                  selected={state.selected?.type === 'node' && state.selected.id === node.id}
                  linkArmed={state.linkFrom !== null}
                  isLinkSource={state.linkFrom === node.id}
                  orphan={orphanIds.has(node.id)}
                  label={t(catalogByKind(node.config.kind).labelKey, catalogByKind(node.config.kind).label)}
                  onPointerDown={onNodePointerDown}
                  onStartLink={onStartLink}
                  onCompleteLink={onCompleteLink}
                />
              ))}
            </div>

            {state.nodes.length === 0 && (
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
                <Workflow size={28} className="text-ink-300" />
                <p className="text-sm font-medium text-ink-500">{t('flow.empty.title', 'Your flow is empty')}</p>
                <p className="max-w-[260px] text-xs text-ink-400">
                  {t('flow.empty.hint', 'Add a trigger from the left panel, then chain actions by clicking the round ports.')}
                </p>
              </div>
            )}
          </div>
        </section>

        {/* ── Inspector ── */}
        <aside className="col-span-12 rounded-card border border-ink-200 bg-surface p-4 shadow-soft lg:col-span-3 xl:col-span-3">
          <h2 className="font-display text-sm font-bold text-ink-900">{t('flow.inspector.title', 'Settings')}</h2>

          {selectedNode && (
            <div className="mt-3 flex flex-col gap-3">
              <div className="flex items-center gap-2.5">
                {(() => {
                  const entry = catalogByKind(selectedNode.config.kind);
                  const Icon = entry.icon;
                  return (
                    <span className="flex h-9 w-9 items-center justify-center rounded-[10px]"
                          style={{ background: `${entry.accent}1a`, color: entry.accent }} aria-hidden="true">
                      <Icon size={17} />
                    </span>
                  );
                })()}
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-ink-900">
                    {t(catalogByKind(selectedNode.config.kind).labelKey, catalogByKind(selectedNode.config.kind).label)}
                  </div>
                  <div className="text-xs text-ink-500">
                    {t(catalogByKind(selectedNode.config.kind).hintKey, catalogByKind(selectedNode.config.kind).hint)}
                  </div>
                </div>
              </div>

              <InspectorFields
                config={selectedNode.config}
                onChange={cfg => onConfigChange(selectedNode.id, cfg)}
                t={(k, d) => t(k, d)}
              />

              <button
                type="button"
                onClick={() => dispatch({ type: 'DELETE_SELECTED' })}
                className="mt-1 inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-[10px] border border-danger/30 bg-danger-tint px-3 py-2 text-sm font-semibold text-danger transition duration-150 hover:border-danger/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40"
              >
                <Trash2 size={15} /> {t('flow.deleteBlock', 'Delete block')}
              </button>
            </div>
          )}

          {selectedEdge && !selectedNode && (
            <div className="mt-3 flex flex-col gap-3">
              <p className="text-sm text-ink-600">
                {t('flow.edgeSelected', 'Connection selected — it runs from one block to the next.')}
              </p>
              <button
                type="button"
                onClick={() => dispatch({ type: 'DELETE_SELECTED' })}
                className="inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-[10px] border border-danger/30 bg-danger-tint px-3 py-2 text-sm font-semibold text-danger transition duration-150 hover:border-danger/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40"
              >
                <X size={15} /> {t('flow.deleteEdge', 'Remove connection')}
              </button>
            </div>
          )}

          {!selectedNode && !selectedEdge && (
            <div className="mt-6 flex flex-col items-center gap-2 text-center">
              <MousePointerClick size={22} className="text-ink-300" />
              <p className="text-xs text-ink-500">
                {t('flow.inspector.empty', 'Select a block on the canvas to edit its settings.')}
              </p>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

/* ── Palette entry (button — whole row clickable) ────────────────────────── */
function PaletteItem({ entry, onAdd, t }: {
  entry: CatalogEntry;
  onAdd: (entry: CatalogEntry) => void;
  t: (k: string, d: string) => string;
}) {
  const Icon = entry.icon;
  return (
    <button
      type="button"
      onClick={() => onAdd(entry)}
      className="group flex w-full cursor-pointer items-center gap-2.5 rounded-[10px] border border-transparent px-2 py-1.5 text-left transition duration-150 hover:border-ink-200 hover:bg-ink-100/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600/40"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] transition-transform duration-150 group-hover:scale-105"
            style={{ background: `${entry.accent}1a`, color: entry.accent }} aria-hidden="true">
        <Icon size={15} />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[13px] font-semibold text-ink-900">{t(entry.labelKey, entry.label)}</span>
        <span className="block truncate text-[11px] text-ink-500">{t(entry.hintKey, entry.hint)}</span>
      </span>
    </button>
  );
}
