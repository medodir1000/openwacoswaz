/* ============================================================================
   Flow Builder — state machine.

   A single pure reducer (no React imports) so heavy canvas interactions stay
   predictable: pointer-drag dispatches are rAF-throttled by the page, and
   every transition here is O(nodes+edges) worst case. Keeping it pure also
   makes undo/redo or a brain-side serializer a drop-in later.
   ========================================================================== */
import type { BotEdge, BotNode, FlowGraph, NodeKind, Selection } from './types';
import { categoryOf } from './types';
import { catalogByKind } from './catalog';

export interface FlowState {
  nodes: BotNode[];
  edges: BotEdge[];
  selected: Selection;
  /** Out-port the user clicked — next in-port click completes the edge. */
  linkFrom: string | null;
  /** Canvas pan offset (px). */
  view: { ox: number; oy: number };
  dirty: boolean;
}

export const initialFlowState: FlowState = {
  nodes: [],
  edges: [],
  selected: null,
  linkFrom: null,
  view: { ox: 0, oy: 0 },
  dirty: false,
};

export type FlowAction =
  | { type: 'LOAD'; graph: FlowGraph }
  | { type: 'ADD_NODE'; kind: NodeKind; x: number; y: number }
  | { type: 'MOVE_NODE'; id: string; x: number; y: number }
  | { type: 'PAN'; ox: number; oy: number }
  | { type: 'SELECT'; selection: Selection }
  | { type: 'START_LINK'; from: string }
  | { type: 'COMPLETE_LINK'; to: string }
  | { type: 'CANCEL_LINK' }
  | { type: 'UPDATE_CONFIG'; id: string; config: BotNode['config'] }
  | { type: 'DELETE_SELECTED' }
  | { type: 'MARK_SAVED' }
  | { type: 'CLEAR' };

const uid = (): string =>
  (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? crypto.randomUUID()
    : `n_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export function flowReducer(state: FlowState, action: FlowAction): FlowState {
  switch (action.type) {
    case 'LOAD':
      return {
        ...initialFlowState,
        nodes: action.graph.nodes,
        edges: action.graph.edges,
      };

    case 'ADD_NODE': {
      const node: BotNode = {
        id: uid(),
        x: action.x,
        y: action.y,
        config: catalogByKind(action.kind).defaults(),
      };
      return {
        ...state,
        nodes: [...state.nodes, node],
        selected: { type: 'node', id: node.id },
        linkFrom: null,
        dirty: true,
      };
    }

    case 'MOVE_NODE':
      return {
        ...state,
        nodes: state.nodes.map(n =>
          n.id === action.id ? { ...n, x: action.x, y: action.y } : n,
        ),
        dirty: true,
      };

    case 'PAN':
      return { ...state, view: { ox: action.ox, oy: action.oy } };

    case 'SELECT':
      return { ...state, selected: action.selection, linkFrom: null };

    case 'START_LINK':
      // Clicking the same out-port again toggles the pending link off.
      return {
        ...state,
        linkFrom: state.linkFrom === action.from ? null : action.from,
        selected: { type: 'node', id: action.from },
      };

    case 'COMPLETE_LINK': {
      const from = state.linkFrom;
      if (!from || from === action.to) return { ...state, linkFrom: null };
      const target = state.nodes.find(n => n.id === action.to);
      // Triggers are entry points — they cannot receive an incoming edge.
      if (!target || categoryOf(target.config.kind) === 'trigger') {
        return { ...state, linkFrom: null };
      }
      const duplicate = state.edges.some(e => e.from === from && e.to === action.to);
      if (duplicate) return { ...state, linkFrom: null };
      const edge: BotEdge = { id: uid(), from, to: action.to };
      return {
        ...state,
        edges: [...state.edges, edge],
        linkFrom: null,
        selected: { type: 'edge', id: edge.id },
        dirty: true,
      };
    }

    case 'CANCEL_LINK':
      return state.linkFrom === null ? state : { ...state, linkFrom: null };

    case 'UPDATE_CONFIG':
      return {
        ...state,
        nodes: state.nodes.map(n =>
          n.id === action.id ? { ...n, config: action.config } : n,
        ),
        dirty: true,
      };

    case 'DELETE_SELECTED': {
      const sel = state.selected;
      if (!sel) return state;
      if (sel.type === 'edge') {
        return {
          ...state,
          edges: state.edges.filter(e => e.id !== sel.id),
          selected: null,
          dirty: true,
        };
      }
      return {
        ...state,
        nodes: state.nodes.filter(n => n.id !== sel.id),
        // Deleting a node drops every edge touching it (no dangling wires).
        edges: state.edges.filter(e => e.from !== sel.id && e.to !== sel.id),
        selected: null,
        linkFrom: state.linkFrom === sel.id ? null : state.linkFrom,
        dirty: true,
      };
    }

    case 'MARK_SAVED':
      return { ...state, dirty: false };

    case 'CLEAR':
      return { ...initialFlowState, dirty: true };

    default:
      return state;
  }
}
