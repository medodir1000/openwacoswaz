/* ============================================================================
   Flow Builder — graph data model (design-system/pages: Automation module).

   STRICT typing strategy: every node carries a `config` that is a
   DISCRIMINATED UNION on `kind`. TypeScript then forces the inspector, the
   reducer and any future brain serializer to handle each kind explicitly —
   adding a new block without its config shape is a compile error, not a
   runtime surprise.
   ========================================================================== */

export type TriggerType = 'keyword' | 'any_message' | 'ad_reference';
export type ActionType =
  | 'send_text'
  | 'send_media'
  | 'delay'
  | 'ask_question'
  | 'tag_user'
  | 'handoff_human';
export type NodeKind = TriggerType | ActionType;
export type NodeCategory = 'trigger' | 'action';

/** Per-kind settings — the discriminant is `kind`. */
export type NodeConfig =
  | { kind: 'keyword'; keywords: string; matchMode: 'contains' | 'exact' }
  | { kind: 'any_message' }
  | { kind: 'ad_reference'; adName: string }
  | { kind: 'send_text'; text: string; humanTyping: boolean }
  | { kind: 'send_media'; url: string; caption: string }
  | { kind: 'delay'; seconds: number }
  | { kind: 'ask_question'; question: string; saveAs: string }
  | { kind: 'tag_user'; tag: string }
  | { kind: 'handoff_human'; note: string };

export interface BotNode {
  id: string;
  /** Canvas position (px, canvas-space — pan offset applied at render). */
  x: number;
  y: number;
  config: NodeConfig;
}

export interface BotEdge {
  id: string;
  /** Source node id (out-port). */
  from: string;
  /** Target node id (in-port). */
  to: string;
}

export interface FlowGraph {
  version: 1;
  nodes: BotNode[];
  edges: BotEdge[];
}

export type Selection = { type: 'node' | 'edge'; id: string } | null;

/* Node cards are FIXED SIZE so edge anchors are deterministic (no measuring,
   no layout thrash while dragging). Ports sit at the vertical center. */
export const NODE_W = 224;
export const NODE_H = 64;
export const PORT_Y = NODE_H / 2;

export const kindOf = (n: BotNode): NodeKind => n.config.kind;

export const categoryOf = (kind: NodeKind): NodeCategory =>
  kind === 'keyword' || kind === 'any_message' || kind === 'ad_reference'
    ? 'trigger'
    : 'action';
