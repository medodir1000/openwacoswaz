import { useEffect, useState } from 'react';
import { MessageSquare, RefreshCw, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';

type ConvRow = {
  id: string;
  customer_jid: string;
  customer_phone: string | null;
  country_code: string | null;
  language_code: string | null;
  status: 'active' | 'order_placed' | 'abandoned' | 'blocked';
  started_at: string;
  last_message_at: string;
  products: { name: string } | null;
};

type Message = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at: string;
};

export default function AdminConversationsPage() {
  const [rows, setRows] = useState<ConvRow[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [busy, setBusy] = useState(false);

  async function loadList() {
    setBusy(true);
    const { data, error } = await supabase
      .from('customer_conversations')
      .select('id, customer_jid, customer_phone, country_code, language_code, status, started_at, last_message_at, products(name)')
      .order('last_message_at', { ascending: false })
      .limit(100);
    setBusy(false);
    if (error) { console.error(error); setRows([]); return; }
    setRows((data ?? []) as unknown as ConvRow[]);
  }

  async function loadMessages(convId: string) {
    setSelectedId(convId);
    setMessages(null);
    const { data, error } = await supabase
      .from('messages')
      .select('id, role, content, created_at')
      .eq('conversation_id', convId)
      .order('created_at', { ascending: true })
      .limit(500);
    if (error) { console.error(error); setMessages([]); return; }
    setMessages((data ?? []) as Message[]);
  }

  useEffect(() => {
    loadList();
    const id = setInterval(loadList, 30_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="p-10 max-w-7xl space-y-6">
      <div className="flex items-start justify-between gap-6 flex-wrap">
        <div>
          <p className="text-[10px] uppercase tracking-[0.3em] font-bold text-zinc-500">Live</p>
          <h1 className="text-4xl font-black tracking-tighter mt-1">Conversations</h1>
          <p className="text-zinc-500 text-sm mt-1">Every customer chat in one place — pick a row to read the full back-and-forth.</p>
        </div>
        <button type="button" onClick={loadList} disabled={busy} className="inline-flex items-center gap-2 bg-white border border-zinc-200 rounded-xl px-4 py-2 text-sm font-bold hover:border-electric-blue hover:text-electric-blue disabled:opacity-50">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        {/* Conversation list */}
        <div className="lg:col-span-2 space-y-2">
          {!rows && <p className="text-zinc-500 text-sm">Loading…</p>}
          {rows && rows.length === 0 && (
            <div className="glass-card rounded-2xl p-8 text-center">
              <MessageSquare className="w-10 h-10 text-zinc-400 mx-auto mb-3" />
              <p className="text-zinc-600 text-sm">No conversations yet. They arrive automatically when customers message your paired WhatsApp number.</p>
            </div>
          )}
          {(rows || []).map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => loadMessages(c.id)}
              className={
                'w-full text-left glass-card rounded-xl p-4 transition-colors hover:border-electric-blue/50 ' +
                (selectedId === c.id ? 'ring-2 ring-electric-blue' : '')
              }
            >
              <div className="flex items-start justify-between gap-2 mb-1">
                <p className="font-bold text-zinc-900 text-sm truncate">{c.customer_phone || c.customer_jid}</p>
                <span className={
                  'text-[10px] uppercase tracking-widest font-bold px-2 py-0.5 rounded-full shrink-0 ' +
                  (c.status === 'order_placed' ? 'bg-green-100 text-green-700' :
                   c.status === 'active'       ? 'bg-blue-100 text-blue-700' :
                   c.status === 'abandoned'    ? 'bg-amber-100 text-amber-700' :
                                                 'bg-red-100 text-red-700')
                }>{c.status.replace('_', ' ')}</span>
              </div>
              <p className="text-xs text-zinc-600 truncate">{c.products?.name || '— no product detected yet —'}</p>
              <p className="text-[10px] text-zinc-500 mt-1">
                {c.country_code} · {c.language_code} · last msg {new Date(c.last_message_at).toLocaleString()}
              </p>
            </button>
          ))}
        </div>

        {/* Message detail */}
        <div className="lg:col-span-3">
          {!selectedId && (
            <div className="glass-card rounded-2xl p-12 text-center">
              <MessageSquare className="w-10 h-10 text-zinc-400 mx-auto mb-3" />
              <p className="text-zinc-600 text-sm">Pick a conversation on the left to view the message history.</p>
            </div>
          )}
          {selectedId && (
            <div className="glass-card rounded-2xl p-5 max-h-[70vh] overflow-y-auto space-y-3">
              {!messages && <p className="text-zinc-500 text-sm">Loading messages…</p>}
              {messages && messages.length === 0 && <p className="text-zinc-500 text-sm">No messages saved for this conversation yet.</p>}
              {(messages || []).map((m) => (
                <div key={m.id} className={'flex ' + (m.role === 'assistant' ? 'justify-start' : 'justify-end')}>
                  <div className={
                    'max-w-[80%] rounded-2xl px-4 py-2.5 ' +
                    (m.role === 'assistant'
                      ? 'bg-electric-blue/10 text-zinc-900'
                      : m.role === 'system'
                        ? 'bg-zinc-100 text-zinc-700 text-xs italic'
                        : 'bg-zinc-900 text-white')
                  }>
                    <p className="text-sm whitespace-pre-wrap leading-relaxed">{m.content}</p>
                    <p className="text-[10px] opacity-60 mt-1">{new Date(m.created_at).toLocaleString()}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
