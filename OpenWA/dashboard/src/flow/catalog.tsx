/* ============================================================================
   Flow Builder — node catalog.

   One entry per block the seller can drop on the canvas: display label,
   Lucide icon (zero-emoji rule), accent (hex — rendered as `${accent}1a`
   chip background exactly like the Dashboard KPI cards so it adapts on dark
   surfaces), and the default config a fresh node starts with.

   Accents follow MASTER §2 semantics — triggers = brand teal, messaging
   actions = info cyan, delay = warning, tag = success, handoff = neutral ink.
   ========================================================================== */
import type { LucideIcon } from 'lucide-react';
import {
  Hash, MessageCircle, Megaphone, MessageSquareText, Image as ImageIcon,
  Timer, HelpCircle, Tag, Headphones,
} from 'lucide-react';
import type { NodeCategory, NodeConfig, NodeKind } from './types';

export interface CatalogEntry {
  kind: NodeKind;
  category: NodeCategory;
  icon: LucideIcon;
  accent: string;
  /** i18n key + default label (the page calls t(labelKey, label)). */
  labelKey: string;
  label: string;
  hintKey: string;
  hint: string;
  defaults: () => NodeConfig;
}

export const CATALOG: CatalogEntry[] = [
  {
    kind: 'keyword', category: 'trigger', icon: Hash, accent: '#0F766E',
    labelKey: 'flow.block.keyword', label: 'Keyword match',
    hintKey: 'flow.block.keywordHint', hint: 'Starts when the message contains a word',
    defaults: () => ({ kind: 'keyword', keywords: '', matchMode: 'contains' }),
  },
  {
    kind: 'any_message', category: 'trigger', icon: MessageCircle, accent: '#0F766E',
    labelKey: 'flow.block.anyMessage', label: 'Any message',
    hintKey: 'flow.block.anyMessageHint', hint: 'Starts on every new conversation',
    defaults: () => ({ kind: 'any_message' }),
  },
  {
    kind: 'ad_reference', category: 'trigger', icon: Megaphone, accent: '#0F766E',
    labelKey: 'flow.block.adReference', label: 'Ad reference',
    hintKey: 'flow.block.adReferenceHint', hint: 'Starts when a FB/IG ad lead writes',
    defaults: () => ({ kind: 'ad_reference', adName: '' }),
  },
  {
    kind: 'send_text', category: 'action', icon: MessageSquareText, accent: '#0E7490',
    labelKey: 'flow.block.sendText', label: 'Send text',
    hintKey: 'flow.block.sendTextHint', hint: 'Reply with a message',
    defaults: () => ({ kind: 'send_text', text: '', humanTyping: true }),
  },
  {
    kind: 'send_media', category: 'action', icon: ImageIcon, accent: '#0E7490',
    labelKey: 'flow.block.sendMedia', label: 'Send media',
    hintKey: 'flow.block.sendMediaHint', hint: 'Send a product photo or file',
    defaults: () => ({ kind: 'send_media', url: '', caption: '' }),
  },
  {
    kind: 'delay', category: 'action', icon: Timer, accent: '#B54708',
    labelKey: 'flow.block.delay', label: 'Delay',
    hintKey: 'flow.block.delayHint', hint: 'Wait before the next step',
    defaults: () => ({ kind: 'delay', seconds: 5 }),
  },
  {
    kind: 'ask_question', category: 'action', icon: HelpCircle, accent: '#0E7490',
    labelKey: 'flow.block.askQuestion', label: 'Ask a question',
    hintKey: 'flow.block.askQuestionHint', hint: 'Collect an answer into a field',
    defaults: () => ({ kind: 'ask_question', question: '', saveAs: '' }),
  },
  {
    kind: 'tag_user', category: 'action', icon: Tag, accent: '#15803D',
    labelKey: 'flow.block.tagUser', label: 'Tag customer',
    hintKey: 'flow.block.tagUserHint', hint: 'Label the contact (VIP, lead…)',
    defaults: () => ({ kind: 'tag_user', tag: '' }),
  },
  {
    kind: 'handoff_human', category: 'action', icon: Headphones, accent: '#5B6770',
    labelKey: 'flow.block.handoff', label: 'Human handoff',
    hintKey: 'flow.block.handoffHint', hint: 'Pause the bot for an agent',
    defaults: () => ({ kind: 'handoff_human', note: '' }),
  },
];

export const catalogByKind = (kind: NodeKind): CatalogEntry => {
  const entry = CATALOG.find(c => c.kind === kind);
  if (!entry) throw new Error(`Unknown node kind: ${kind}`);
  return entry;
};

/** One-line summary shown inside the node card (falls back to the hint). */
export function nodeSummary(config: NodeConfig): string {
  switch (config.kind) {
    case 'keyword':       return config.keywords.trim() || '—';
    case 'any_message':   return '∗';
    case 'ad_reference':  return config.adName.trim() || '—';
    case 'send_text':     return config.text.trim() || '—';
    case 'send_media':    return config.caption.trim() || config.url.trim() || '—';
    case 'delay':         return `${config.seconds}s`;
    case 'ask_question':  return config.question.trim() || '—';
    case 'tag_user':      return config.tag.trim() || '—';
    case 'handoff_human': return config.note.trim() || '—';
  }
}
