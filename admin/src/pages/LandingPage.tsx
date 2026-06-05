import { Link } from 'react-router-dom';
import { ArrowRight, MessageCircle, Globe2, FileSpreadsheet, ShieldCheck } from 'lucide-react';

const FEATURES = [
  { icon: MessageCircle, title: 'Native WhatsApp', body: 'Pair your own WhatsApp number in one click. Customers chat where they already are.' },
  { icon: Globe2,        title: 'Per-country language', body: 'Bot detects the customer\'s country from their number and replies in the right language with the right currency.' },
  { icon: FileSpreadsheet, title: 'Orders straight to Sheets', body: 'Every confirmed order POSTs to your Google Apps Script webhook. You own the data.' },
  { icon: ShieldCheck,   title: 'Anti-ban guardrails', body: 'Quiet hours, daily caps, per-user rate limits, 3-stage human typing — out of the box.' },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-zinc-50">
      <header className="border-b border-zinc-200">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <img src="/codhelix_logo.png" alt="codhelix" className="w-8 h-8" />
            <p className="font-black tracking-tighter text-xl">cod<span className="text-electric-blue">helix</span></p>
          </div>
          <nav className="flex items-center gap-3 text-sm">
            <Link to="/login" className="text-zinc-600 hover:text-electric-blue font-bold">Log in</Link>
            <Link to="/signup" className="bg-electric-blue !text-white font-bold px-4 py-2 rounded-xl hover:bg-blue-600 inline-flex items-center gap-1.5">
              Start free <ArrowRight className="w-4 h-4" />
            </Link>
          </nav>
        </div>
      </header>

      <section className="max-w-6xl mx-auto px-6 py-24 text-center">
        <h1 className="text-5xl md:text-7xl font-black tracking-tighter mb-6 leading-[1.05]">
          Turn WhatsApp messages into <span className="text-electric-blue">confirmed orders</span> on autopilot.
        </h1>
        <p className="text-xl text-zinc-600 max-w-2xl mx-auto mb-10">
          Drop in your products, link a Google Sheet, pair WhatsApp. The bot replies to every lead in their own language and pushes finished orders to your sheet.
        </p>
        <div className="flex items-center justify-center gap-3">
          <Link to="/signup" className="bg-electric-blue !text-white font-bold px-6 py-3 rounded-xl hover:bg-blue-600 inline-flex items-center gap-2 shadow-[0_8px_24px_rgba(59,130,246,0.35)]">
            Start free — no card required <ArrowRight className="w-4 h-4" />
          </Link>
          <Link to="/login" className="bg-white border border-zinc-300 text-zinc-700 font-bold px-6 py-3 rounded-xl hover:border-electric-blue hover:text-electric-blue">
            I already have an account
          </Link>
        </div>
      </section>

      <section className="max-w-6xl mx-auto px-6 pb-24">
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {FEATURES.map(({ icon: Icon, title, body }) => (
            <div key={title} className="glass-card rounded-2xl p-5">
              <Icon className="w-7 h-7 text-electric-blue mb-3" />
              <h3 className="font-black text-lg tracking-tight mb-1">{title}</h3>
              <p className="text-sm text-zinc-600 leading-relaxed">{body}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="border-t border-zinc-200 py-6">
        <div className="max-w-6xl mx-auto px-6 flex items-center justify-between text-xs text-zinc-500">
          <p>© {new Date().getFullYear()} codhelix</p>
          <p>WhatsApp commerce, on autopilot</p>
        </div>
      </footer>
    </div>
  );
}
