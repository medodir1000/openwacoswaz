import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import './Landing.css';

/* ============================================================
   Closwiz landing — in-app entry point (public, pre-auth).
   Ported from the standalone /landing (index.html + styles.css +
   script.js). All CTAs route into the React auth flow:
     • "Get started" / "Start free" / "Choose Pack" → /signup
     • "Sign in"                                    → /login
   In-page anchors (#features, #how, …) keep smooth-scrolling.
   The vanilla script.js behaviours (sticky nav, reveal-on-scroll,
   card glow, count-up, chat typing) are re-implemented in one
   StrictMode-safe useEffect scoped to the landing root.
   ============================================================ */

// Small reusable checkmark used across the trust list + pricing cards.
function Check() {
  return (
    <svg viewBox="0 0 24 24" className="ico-check" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export default function Landing() {
  const rootRef = useRef<HTMLDivElement>(null);
  const chatBodyRef = useRef<HTMLDivElement>(null);
  const typingRef = useRef<HTMLDivElement>(null);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const timeouts: number[] = [];
    const cleanups: Array<() => void> = [];
    const later = (fn: () => void, ms: number) => { timeouts.push(window.setTimeout(fn, ms)); };

    /* ── sticky nav shadow ─────────────────────────────── */
    const nav = root.querySelector<HTMLElement>('.nav');
    const onScroll = () => { if (nav) nav.classList.toggle('is-stuck', window.scrollY > 12); };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    cleanups.push(() => window.removeEventListener('scroll', onScroll));

    /* ── reveal-on-scroll ──────────────────────────────── */
    const revealEls = Array.from(root.querySelectorAll<HTMLElement>('.reveal'));
    if (reduceMotion || !('IntersectionObserver' in window)) {
      revealEls.forEach((el) => el.classList.add('is-visible'));
    } else {
      const io = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            io.unobserve(entry.target);
          }
        });
      }, { threshold: 0.14, rootMargin: '0px 0px -8% 0px' });
      revealEls.forEach((el) => io.observe(el));
      cleanups.push(() => io.disconnect());
    }

    /* ── feature-card cursor glow ──────────────────────── */
    const cardHandlers: Array<[HTMLElement, (e: PointerEvent) => void]> = [];
    root.querySelectorAll<HTMLElement>('.card').forEach((card) => {
      const handler = (e: PointerEvent) => {
        const r = card.getBoundingClientRect();
        card.style.setProperty('--mx', `${e.clientX - r.left}px`);
        card.style.setProperty('--my', `${e.clientY - r.top}px`);
      };
      card.addEventListener('pointermove', handler);
      cardHandlers.push([card, handler]);
    });
    cleanups.push(() => cardHandlers.forEach(([c, h]) => c.removeEventListener('pointermove', h)));

    /* ── animated count-up for stats ───────────────────── */
    const animateCount = (el: HTMLElement) => {
      const target = parseFloat(el.getAttribute('data-count') || '');
      if (isNaN(target)) return;
      const prefix = el.getAttribute('data-prefix') || '';
      const suffix = el.getAttribute('data-suffix') || '';
      const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
      if (reduceMotion) { el.innerHTML = prefix + fmt(target) + suffix; return; }
      const start = performance.now();
      const dur = 1300;
      const tick = (now: number) => {
        const p = Math.min((now - start) / dur, 1);
        const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
        el.innerHTML = prefix + fmt(target * eased) + suffix;
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };
    const statNums = Array.from(root.querySelectorAll<HTMLElement>('.stat__num[data-count]'));
    if ('IntersectionObserver' in window && !reduceMotion) {
      const statIO = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) { animateCount(entry.target as HTMLElement); statIO.unobserve(entry.target); }
        });
      }, { threshold: 0.6 });
      statNums.forEach((el) => statIO.observe(el));
      cleanups.push(() => statIO.disconnect());
    }

    /* ── hero chat typing sequence ─────────────────────── */
    const chatBody = chatBodyRef.current;
    const typing = typingRef.current;
    if (chatBody && !reduceMotion) {
      const bubbles = Array.from(chatBody.querySelectorAll<HTMLElement>('.bubble'));
      const showTyping = (on: boolean) => { if (typing) typing.classList.toggle('show', on); };

      let i = 0;
      const next = () => {
        if (i >= bubbles.length) { showTyping(false); return; }
        const b = bubbles[i];
        const isOut = b.classList.contains('bubble--out');
        const thinkMs = isOut ? 900 : 380;
        if (isOut) showTyping(true);
        later(() => {
          showTyping(false);
          b.style.display = ''; // revert to CSS display → triggers bubbleIn
          chatBody.scrollTop = chatBody.scrollHeight;
          i++;
          later(next, isOut ? 520 : 680);
        }, thinkMs);
      };
      const play = () => { i = 0; bubbles.forEach((b) => { b.style.display = 'none'; }); later(next, 500); };

      if ('IntersectionObserver' in window) {
        const chatIO = new IntersectionObserver((entries) => {
          entries.forEach((entry) => { if (entry.isIntersecting) { play(); chatIO.unobserve(entry.target); } });
        }, { threshold: 0.4 });
        chatIO.observe(chatBody);
        cleanups.push(() => chatIO.disconnect());
      } else {
        play();
      }
    }

    return () => {
      timeouts.forEach((t) => window.clearTimeout(t));
      cleanups.forEach((fn) => fn());
    };
  }, []);

  const year = new Date().getFullYear();
  const closeMobile = () => setMobileOpen(false);

  return (
    <div className="kv-landing" ref={rootRef}>
      {/* ambient background glow */}
      <div className="bg-orbs" aria-hidden="true">
        <span className="orb orb--purple" />
        <span className="orb orb--orange" />
        <span className="orb orb--magenta" />
      </div>

      {/* ───────────────────────── NAV ───────────────────────── */}
      <header className="nav">
        <div className="container nav__inner">
          <a className="brand" href="#top" aria-label="Closwiz home">
            <img className="brand__mark" src="/closwiz_logo.svg" alt="" width={36} height={36} />
            <span className="brand__name">Closwiz</span>
          </a>

          <nav className="nav__links" aria-label="Primary">
            <a href="#features">Features</a>
            <a href="#how">How it works</a>
            <a href="#integrations">Integrations</a>
            <a href="#pricing">Pricing</a>
            <a href="#why">Why Closwiz</a>
          </nav>

          <div className="nav__actions">
            <Link className="btn btn--ghost" to="/login">Sign in</Link>
            <Link className="btn btn--primary" to="/signup">Get started</Link>
          </div>

          <button
            className={`nav__burger${mobileOpen ? ' is-open' : ''}`}
            aria-label="Open menu"
            aria-expanded={mobileOpen}
            onClick={() => setMobileOpen((v) => !v)}
          >
            <span /><span /><span />
          </button>
        </div>

        {/* mobile drawer */}
        <div className="nav__mobile" hidden={!mobileOpen}>
          <a href="#features" onClick={closeMobile}>Features</a>
          <a href="#how" onClick={closeMobile}>How it works</a>
          <a href="#integrations" onClick={closeMobile}>Integrations</a>
          <a href="#pricing" onClick={closeMobile}>Pricing</a>
          <a href="#why" onClick={closeMobile}>Why Closwiz</a>
          <Link className="btn btn--ghost" to="/login" onClick={closeMobile}>Sign in</Link>
          <Link className="btn btn--primary" to="/signup" onClick={closeMobile}>Get started</Link>
        </div>
      </header>

      <main id="top">
        {/* ───────────────────────── HERO ───────────────────────── */}
        <section className="hero">
          <div className="container hero__grid">
            <div className="hero__copy reveal">
              <span className="kicker">
                <span className="kicker__dot" />
                AI-Powered Client Interaction
              </span>

              <h1 className="hero__title">
                Turn WhatsApp chats into{' '}
                <span className="grad-text">paying customers</span>,
                on autopilot.
              </h1>

              <p className="hero__lead">
                Closwiz replies like a real person, qualifies every lead and closes
                the sale — then syncs the order to Shopify and Google&nbsp;Sheets.
                You wake up to confirmed orders, not unread messages.
              </p>

              <div className="hero__cta">
                <Link className="btn btn--primary btn--lg" to="/signup">
                  Start free
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
                </Link>
                <a className="btn btn--glass btn--lg" href="#how">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 5v14l11-7-11-7z" /></svg>
                  See how it works
                </a>
              </div>

              <p className="tagline-script">Real conversations. Real customers. Real growth.</p>

              <ul className="hero__trust">
                <li><Check /> No card to start</li>
                <li><Check /> Live in 2 minutes</li>
                <li><Check /> No coding</li>
              </ul>
            </div>

            {/* WhatsApp chat mockup */}
            <div className="hero__phone reveal" aria-hidden="true">
              <div className="phone">
                <div className="phone__notch" />
                <div className="phone__chat">
                  <div className="chat__top">
                    <span className="chat__avatar">C</span>
                    <div className="chat__who">
                      <strong>Customer</strong>
                      <em><span className="dot-online" /> Online</em>
                    </div>
                    <svg className="chat__wa" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M.057 24l1.687-6.163a11.867 11.867 0 0 1-1.587-5.946C.16 5.335 5.495 0 12.05 0a11.82 11.82 0 0 1 8.413 3.488 11.82 11.82 0 0 1 3.48 8.414c-.003 6.557-5.338 11.892-11.893 11.892a11.9 11.9 0 0 1-5.688-1.448L.057 24z" fill="#25D366" /><path d="M9.5 7.3c-.2-.5-.4-.5-.6-.5h-.5c-.2 0-.5.1-.7.3-.3.3-1 1-1 2.4s1 2.8 1.2 3c.1.2 2 3.1 4.9 4.3 2.4 1 2.9.8 3.4.8.5-.1 1.6-.7 1.9-1.3.2-.6.2-1.2.2-1.3-.1-.1-.3-.2-.6-.3-.3-.2-1.6-.8-1.9-.9-.3-.1-.4-.1-.6.1-.2.3-.6.9-.8 1-.1.2-.3.2-.5.1-.3-.1-1.1-.4-2.1-1.3-.8-.7-1.3-1.5-1.5-1.8-.1-.3 0-.4.1-.5l.4-.5c.1-.2.2-.3.2-.5.1-.1 0-.3 0-.4l-.7-1.9z" fill="#fff" /></svg>
                  </div>

                  <div className="chat__body" ref={chatBodyRef}>
                    <div className="bubble bubble--in" data-step="1">Hi! I need help with my order.<time className="bubble__time">10:30 AM</time></div>
                    <div className="bubble bubble--out" data-step="2">Sure! I can help you check your order status.<time className="bubble__time">10:30 AM <span className="ticks">✓✓</span></time></div>
                    <div className="bubble bubble--in" data-step="3">Thanks! 😊<time className="bubble__time">10:31 AM</time></div>
                    <div className="bubble bubble--out" data-step="4">Great news — your order <b>#ORD-45078</b> will be delivered tomorrow.<time className="bubble__time">10:31 AM <span className="ticks">✓✓</span></time></div>
                    <div className="typing" ref={typingRef}><span /><span /><span /></div>
                  </div>

                  {/* connected tools strip */}
                  <div className="connected">
                    <span className="connected__item"><span className="connected__dot" style={{ background: '#25D366' }} /> WhatsApp</span>
                    <span className="connected__item"><span className="connected__dot" style={{ background: '#95BF47' }} /> Shopify</span>
                    <span className="connected__item"><span className="connected__dot" style={{ background: '#0F9D58' }} /> Sheets</span>
                    <span className="connected__ok">Connected ✓</span>
                  </div>
                </div>
              </div>

              {/* floating order card */}
              <div className="float-card float-card--order">
                <span className="float-card__icon grad-bg">✓</span>
                <div>
                  <strong>Order confirmed</strong>
                  <small>#ORD-45078 · synced to Shopify</small>
                </div>
              </div>
              {/* floating metric card */}
              <div className="float-card float-card--metric">
                <strong className="grad-text">+42%</strong>
                <small>more sales this month</small>
              </div>
            </div>
          </div>
        </section>

        {/* ───────────────────────── STATS BAR ───────────────────────── */}
        <section className="stats reveal" aria-label="Key metrics">
          <div className="container stats__grid">
            <div className="stat">
              <span className="stat__ico">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
              </span>
              <span className="stat__num grad-text" data-count="2847" data-suffix="+">2,847+</span>
              <span className="stat__label">Conversations</span>
            </div>
            <div className="stat">
              <span className="stat__ico stat__ico--orange">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 21h18" /><path d="M5 21V7l7-4 7 4v14" /><path d="M9 9h0M9 13h0M9 17h0M15 9h0M15 13h0M15 17h0" /></svg>
              </span>
              <span className="stat__num grad-text" data-count="1250" data-suffix="+">1,250+</span>
              <span className="stat__label">Businesses</span>
            </div>
            <div className="stat">
              <span className="stat__ico stat__ico--pink">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M23 6l-9.5 9.5-5-5L1 18" /><path d="M17 6h6v6" /></svg>
              </span>
              <span className="stat__num grad-text" data-count="35" data-suffix="%+">35%+</span>
              <span className="stat__label">Sales increase</span>
            </div>
            <div className="stat">
              <span className="stat__ico stat__ico--blue">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
              </span>
              <span className="stat__num grad-text">24/7</span>
              <span className="stat__label">Always on</span>
            </div>
          </div>
        </section>

        {/* ───────────────────────── FEATURES ───────────────────────── */}
        <section className="section" id="features">
          <div className="container">
            <div className="section__head reveal">
              <span className="eyebrow">Powerful AI. Simple to use.</span>
              <h2 className="section__title">Everything you need to engage &amp; convert</h2>
              <p className="section__sub">One assistant that talks like a human, sells like your best agent, and never sleeps.</p>
            </div>

            <div className="cards">
              <article className="card reveal">
                <span className="card__icon card__icon--purple">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /><path d="M8 9h0M12 9h0M16 9h0" /></svg>
                </span>
                <h3>Human-like chat</h3>
                <p>Replies like a real person. Builds trust and keeps your customers happy from the first message.</p>
              </article>

              <article className="card reveal">
                <span className="card__icon card__icon--orange">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2 3 14h9l-1 8 10-12h-9z" /></svg>
                </span>
                <h3>Smart automation</h3>
                <p>Automate FAQs, replies and follow-ups to save time and focus on what actually grows your business.</p>
              </article>

              <article className="card reveal">
                <span className="card__icon card__icon--pink">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1.4" fill="currentColor" /></svg>
                </span>
                <h3>Capture &amp; qualify</h3>
                <p>Collect the right info, qualify your leads, and send them exactly where it matters most.</p>
              </article>

              <article className="card reveal">
                <span className="card__icon card__icon--green">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M23 6l-9.5 9.5-5-5L1 18" /><path d="M17 6h6v6" /></svg>
                </span>
                <h3>Increase sales</h3>
                <p>Recommend products, answer objections, and turn everyday conversations into real sales.</p>
              </article>

              <article className="card reveal">
                <span className="card__icon card__icon--blue">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
                </span>
                <h3>Works 24/7</h3>
                <p>Never miss a customer — day or night, weekend or holiday, your bot is always online.</p>
              </article>

              <article className="card reveal">
                <span className="card__icon card__icon--purple">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="m9 12 2 2 4-4" /></svg>
                </span>
                <h3>Easy &amp; fast setup</h3>
                <p>No coding required. Launch your AI bot in less than two minutes and start selling today.</p>
              </article>
            </div>
          </div>
        </section>

        {/* ───────────────────────── HOW IT WORKS ───────────────────────── */}
        <section className="section section--alt" id="how">
          <div className="container">
            <div className="section__head reveal">
              <span className="eyebrow">Get started in 3 easy steps</span>
              <h2 className="section__title">Live in three steps</h2>
              <p className="section__sub">No code, no agency. Set it up between two coffees.</p>
            </div>

            <div className="steps3">
              <article className="step3 step3--1 reveal">
                <span className="step3__num">1</span>
                <span className="step3__icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="8" width="16" height="12" rx="3" /><path d="M12 8V5" /><circle cx="12" cy="3.6" r="1.4" /><circle cx="9" cy="13" r="1.2" fill="currentColor" /><circle cx="15" cy="13" r="1.2" fill="currentColor" /><path d="M9.5 17h5" /></svg>
                </span>
                <h3>Create your bot</h3>
                <p>Answer a few simple questions about your business and Closwiz builds your assistant.</p>
              </article>

              <article className="step3 step3--2 reveal">
                <span className="step3__num">2</span>
                <span className="step3__icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>
                </span>
                <h3>Connect your tools</h3>
                <p>Connect WhatsApp, Shopify and Google Sheets in a couple of clicks — no developer needed.</p>
              </article>

              <article className="step3 step3--3 reveal">
                <span className="step3__num">3</span>
                <span className="step3__icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" /><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" /><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" /><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" /></svg>
                </span>
                <h3>Let it work for you</h3>
                <p>Your AI handles every conversation, captures orders, and grows your business — automatically.</p>
              </article>
            </div>

            {/* dashboard preview */}
            <div className="dash reveal" aria-hidden="true">
              <div className="dash__bar">
                <span className="dash__dot" /><span className="dash__dot" /><span className="dash__dot" />
                <span className="dash__url">app.closwiz.com</span>
              </div>
              <div className="dash__body">
                <div className="dash__metrics">
                  <div className="dash__metric">
                    <small>Conversations</small>
                    <strong>2,847</strong>
                    <span className="up">▲ 235% vs last month</span>
                    <svg className="dash__spark" viewBox="0 0 240 64" preserveAspectRatio="none" aria-hidden="true">
                      <defs>
                        <linearGradient id="kvSparkLine" x1="0" y1="0" x2="1" y2="0">
                          <stop offset="0" stopColor="#00C896" /><stop offset="0.5" stopColor="#00E0A8" /><stop offset="1" stopColor="#00A37A" />
                        </linearGradient>
                        <linearGradient id="kvSparkFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0" stopColor="rgba(0,224,168,0.30)" /><stop offset="1" stopColor="rgba(0,224,168,0)" />
                        </linearGradient>
                      </defs>
                      <path className="dash__spark-area" d="M0,52 30,46 60,49 90,34 120,38 150,22 180,26 210,12 240,8 240,64 0,64 Z" fill="url(#kvSparkFill)" />
                      <polyline className="dash__spark-line" points="0,52 30,46 60,49 90,34 120,38 150,22 180,26 210,12 240,8" fill="none" stroke="url(#kvSparkLine)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                  <div className="dash__metric">
                    <small>Orders generated</small>
                    <strong>578</strong>
                    <span className="up">▲ 442% vs last month</span>
                    <div className="dash__chart">
                      <span style={{ height: '30%' }} /><span style={{ height: '46%' }} /><span style={{ height: '38%' }} />
                      <span style={{ height: '60%' }} /><span style={{ height: '52%' }} /><span style={{ height: '78%' }} />
                      <span style={{ height: '70%' }} /><span style={{ height: '96%' }} />
                    </div>
                  </div>
                </div>
                <div className="dash__status">
                  <span className="ok-dot" /> Live status · All systems operational
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ───────────────────────── INTEGRATIONS ───────────────────────── */}
        <section className="section" id="integrations">
          <div className="container">
            <div className="section__head reveal">
              <span className="eyebrow">Integrations</span>
              <h2 className="section__title">Connects only with the tools you need</h2>
              <p className="section__sub">No bloated setup. Closwiz plugs straight into the three tools that run your store.</p>
            </div>

            <div className="connect__grid">
              {/* visual composition with floating badges */}
              <div className="connect__visual reveal" aria-hidden="true">
                <div className="connect__hub">
                  <img src="/closwiz_logo.svg" alt="" width={60} height={60} />
                </div>
                <span className="badge-float badge-float--a"><b className="grad-text">+42%</b> More sales</span>
                <span className="badge-float badge-float--b"><b className="grad-text">2 min</b> Setup time</span>
                <span className="badge-float badge-float--c"><b className="grad-text">24/7</b> Always online</span>
              </div>

              {/* WhatsApp → Shopify → Sheets flow */}
              <div className="flow reveal">
                <div className="flow__node">
                  <span className="flow__icon" style={{ ['--c' as string]: '#25D366' }}>
                    <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M.057 24l1.687-6.163a11.867 11.867 0 0 1-1.587-5.946C.16 5.335 5.495 0 12.05 0a11.82 11.82 0 0 1 8.413 3.488 11.82 11.82 0 0 1 3.48 8.414c-.003 6.557-5.338 11.892-11.893 11.892a11.9 11.9 0 0 1-5.688-1.448L.057 24z" fill="#25D366" /><path d="M9.5 7.3c-.2-.5-.4-.5-.6-.5h-.5c-.2 0-.5.1-.7.3-.3.3-1 1-1 2.4s1 2.8 1.2 3c.1.2 2 3.1 4.9 4.3 2.4 1 2.9.8 3.4.8.5-.1 1.6-.7 1.9-1.3.2-.6.2-1.2.2-1.3-.1-.1-.3-.2-.6-.3-.3-.2-1.6-.8-1.9-.9-.3-.1-.4-.1-.6.1-.2.3-.6.9-.8 1-.1.2-.3.2-.5.1-.3-.1-1.1-.4-2.1-1.3-.8-.7-1.3-1.5-1.5-1.8-.1-.3 0-.4.1-.5l.4-.5c.1-.2.2-.3.2-.5.1-.1 0-.3 0-.4l-.7-1.9z" fill="#fff" /></svg>
                  </span>
                  <div className="flow__text"><strong>WhatsApp</strong><small>Chat with your customers</small></div>
                </div>

                <span className="flow__arrow" aria-hidden="true">
                  <svg viewBox="0 0 40 24" fill="none"><path d="M2 12h30" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray="3 5" /><path d="M30 6l8 6-8 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </span>

                <div className="flow__node">
                  <span className="flow__icon" style={{ ['--c' as string]: '#95BF47' }}>
                    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#95BF47" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" /><path d="M3 6h18" /><path d="M16 10a4 4 0 0 1-8 0" /></svg>
                  </span>
                  <div className="flow__text"><strong>Shopify</strong><small>Sync orders &amp; products</small></div>
                </div>

                <span className="flow__arrow" aria-hidden="true">
                  <svg viewBox="0 0 40 24" fill="none"><path d="M2 12h30" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray="3 5" /><path d="M30 6l8 6-8 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </span>

                <div className="flow__node">
                  <span className="flow__icon" style={{ ['--c' as string]: '#0F9D58' }}>
                    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#0F9D58" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M8 13h8M8 17h8M12 13v4" /></svg>
                  </span>
                  <div className="flow__text"><strong>Google Sheets</strong><small>Store &amp; manage your data</small></div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ───────────────────────── WHY CLOSWIZ ───────────────────────── */}
        <section className="section section--alt" id="why">
          <div className="container">
            <div className="section__head reveal">
              <span className="eyebrow">Why Closwiz</span>
              <h2 className="section__title">Why businesses choose Closwiz</h2>
              <p className="section__sub">From Casablanca to Dakar to Conakry — built to help you sell more, in less time.</p>
            </div>

            <div className="reasons">
              <article className="reason reveal">
                <span className="reason__icon reason__icon--green">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M23 6l-9.5 9.5-5-5L1 18" /><path d="M17 6h6v6" /></svg>
                </span>
                <h3>Boost sales</h3>
                <p>Convert more conversations into paying customers, with replies that recommend and reassure.</p>
              </article>

              <article className="reason reveal">
                <span className="reason__icon reason__icon--orange">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
                </span>
                <h3>Save time</h3>
                <p>Stop typing the same answers all day. Closwiz handles the repetitive conversations for you.</p>
              </article>

              <article className="reason reveal">
                <span className="reason__icon reason__icon--purple">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M23 4v6h-6" /><path d="M1 20v-6h6" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></svg>
                </span>
                <h3>Automate the busywork</h3>
                <p>Automate repetitive tasks and follow-ups so you can focus on what actually matters.</p>
              </article>

              <article className="reason reveal">
                <span className="reason__icon reason__icon--blue">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6" /><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" /></svg>
                </span>
                <h3>Human-like support</h3>
                <p>Give your customers fast, accurate, human-like support — every hour of every day.</p>
              </article>
            </div>

            {/* loved-by band */}
            <div className="loved reveal">
              <div className="loved__stars">★★★★★</div>
              <p className="loved__text">Loved by <span className="grad-text">2,000+</span> businesses</p>
              <div className="loved__avatars">
                <span className="loved__a" style={{ ['--a' as string]: '#00C896', ['--b' as string]: '#00E0A8' }}>SE</span>
                <span className="loved__a" style={{ ['--a' as string]: '#00A37A', ['--b' as string]: '#FFC700' }}>AD</span>
                <span className="loved__a" style={{ ['--a' as string]: '#00E0A8', ['--b' as string]: '#00A37A' }}>MC</span>
                <span className="loved__a" style={{ ['--a' as string]: '#3ECF8E', ['--b' as string]: '#00C896' }}>YB</span>
                <span className="loved__a loved__a--more">+2k</span>
              </div>
            </div>

            <div className="quotes">
              <figure className="quote reveal">
                <div className="quote__stars">★★★★★</div>
                <blockquote>"Before Closwiz I lost half my DMs at night. Now I wake up to orders already confirmed and synced. C'est magique."</blockquote>
                <figcaption>
                  <span className="avatar" style={{ ['--a' as string]: '#00C896', ['--b' as string]: '#00E0A8' }}>SE</span>
                  <span><strong>Salma El Amrani</strong><small>Boutique mode · Casablanca 🇲🇦</small></span>
                </figcaption>
              </figure>

              <figure className="quote reveal">
                <div className="quote__stars">★★★★★</div>
                <blockquote>"The bot replies like a real salesperson. My customers don't even notice the difference. +40% in sales."</blockquote>
                <figcaption>
                  <span className="avatar" style={{ ['--a' as string]: '#00A37A', ['--b' as string]: '#FFC700' }}>AD</span>
                  <span><strong>Awa Diallo</strong><small>Accessoires · Dakar 🇸🇳</small></span>
                </figcaption>
              </figure>

              <figure className="quote reveal">
                <div className="quote__stars">★★★★★</div>
                <blockquote>"I run 3 WhatsApp numbers from one screen. Closwiz replaced two support agents. Indispensable."</blockquote>
                <figcaption>
                  <span className="avatar" style={{ ['--a' as string]: '#00E0A8', ['--b' as string]: '#00A37A' }}>MC</span>
                  <span><strong>Mamadou Camara</strong><small>Électronique · Conakry 🇬🇳</small></span>
                </figcaption>
              </figure>
            </div>
          </div>
        </section>

        {/* ───────────────────────── PRICING ───────────────────────── */}
        <section className="section" id="pricing">
          <div className="container">
            <div className="section__head reveal">
              <span className="eyebrow">Simple pricing</span>
              <h2 className="section__title">Start free. Upgrade when you grow.</h2>
              <p className="section__sub">Try Closwiz free for 2 days — then pick the plan that fits your shop. Pay in your local currency.</p>
            </div>

            <div className="pricing__grid">
              {/* Free trial */}
              <article className="price-card reveal">
                <span className="price-card__name">Free trial</span>
                <div className="price-card__price">
                  <span className="price-card__amount">Free</span>
                  <span className="price-card__period">for 2 days</span>
                </div>
                <span className="price-card__local">No credit card required</span>
                <p className="price-card__sub">Test the full bot on your real WhatsApp before you pay a dirham.</p>
                <ul className="price-card__list">
                  <li><Check /> 30 customer conversations</li>
                  <li><Check /> 1 WhatsApp session</li>
                  <li><Check /> Full bot — no feature locks</li>
                  <li><Check /> Live in 2 minutes</li>
                </ul>
                <Link className="btn btn--glass btn--lg" to="/signup">Start free trial</Link>
              </article>

              {/* Pack 1 — featured */}
              <article className="price-card price-card--featured reveal">
                <span className="price-card__badge">★ Most popular</span>
                <span className="price-card__name">Pack 1</span>
                <div className="price-card__price">
                  <span className="price-card__amount">$17</span>
                  <span className="price-card__period">/ month</span>
                </div>
                <span className="price-card__local">≈ 170 MAD · 10 000 XOF · 850 EGP</span>
                <p className="price-card__sub">For solo sellers getting serious about WhatsApp.</p>
                <ul className="price-card__list">
                  <li><Check /> 2 WhatsApp sessions</li>
                  <li><Check /> ~250 conversations / month</li>
                  <li><Check /> Unlimited products</li>
                  <li><Check /> Shopify + Google Sheets sync</li>
                  <li><Check /> Human-like AI replies, 24/7</li>
                </ul>
                <Link className="btn btn--primary btn--lg" to="/signup">Choose Pack 1</Link>
              </article>

              {/* Pack 2 */}
              <article className="price-card reveal">
                <span className="price-card__name">Pack 2</span>
                <div className="price-card__price">
                  <span className="price-card__amount">$25</span>
                  <span className="price-card__period">/ month</span>
                </div>
                <span className="price-card__local">≈ 250 MAD · 15 000 XOF · 1 250 EGP</span>
                <p className="price-card__sub">For growing shops handling real volume.</p>
                <ul className="price-card__list">
                  <li><Check /> 5 WhatsApp sessions</li>
                  <li><Check /> ~750 conversations / month</li>
                  <li><Check /> Everything in Pack 1</li>
                  <li><Check /> Multi-number from one screen</li>
                  <li><Check /> Priority support</li>
                </ul>
                <Link className="btn btn--glass btn--lg" to="/signup">Choose Pack 2</Link>
              </article>
            </div>

            <p className="pricing__note">
              Prices shown in USD. Pay in your <b>local currency</b> — MAD · XOF · GNF · XAF · EGP —
              by card or mobile money. No setup fees, cancel anytime.
            </p>
          </div>
        </section>

        {/* ───────────────────────── CTA ───────────────────────── */}
        <section className="section" id="get-started">
          <div className="container">
            <div className="cta reveal">
              <div className="cta__glow" aria-hidden="true" />
              <span className="kicker kicker--light">
                <span className="kicker__dot" />
                Start free · upgrade when you grow
              </span>
              <h2 className="cta__title">Ready to put your WhatsApp on autopilot?</h2>
              <p className="cta__sub">Join 2,000+ businesses turning conversations into paying customers — with real conversations, real customers, real growth.</p>
              <div className="cta__actions">
                <Link className="btn btn--light btn--lg" to="/signup">
                  Create your bot
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
                </Link>
                <a className="btn btn--glass btn--lg" href="#features">Explore features</a>
              </div>
              <p className="cta__fine">No credit card required · live in 2 minutes · no coding</p>
            </div>
          </div>
        </section>
      </main>

      {/* ───────────────────────── FOOTER ───────────────────────── */}
      <footer className="footer">
        <div className="container footer__grid">
          <div className="footer__brand">
            <a className="brand" href="#top" aria-label="Closwiz home">
              <img className="brand__mark" src="/closwiz_logo.svg" alt="" width={34} height={34} />
              <span className="brand__name">Closwiz</span>
            </a>
            <p className="footer__tag">AI-powered client interaction on WhatsApp. Real conversations. Real customers. Real growth.</p>
          </div>

          <nav className="footer__col" aria-label="Product">
            <h4>Product</h4>
            <a href="#features">Features</a>
            <a href="#how">How it works</a>
            <a href="#integrations">Integrations</a>
            <a href="#pricing">Pricing</a>
            <a href="#why">Why Closwiz</a>
          </nav>

          <nav className="footer__col" aria-label="Company">
            <h4>Company</h4>
            <a href="#why">Stories</a>
            <a href="#top">About</a>
            <a href="mailto:hello@closwiz.com">Contact</a>
          </nav>

          <nav className="footer__col" aria-label="Legal">
            <h4>Legal</h4>
            <a href="#">Privacy</a>
            <a href="#">Terms</a>
            <a href="#">Security</a>
          </nav>
        </div>

        <div className="container footer__bottom">
          <small>© {year} Closwiz. All rights reserved.</small>
          <div className="footer__social">
            <a href="#" aria-label="WhatsApp"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M.057 24l1.687-6.163a11.867 11.867 0 0 1-1.587-5.946C.16 5.335 5.495 0 12.05 0a11.82 11.82 0 0 1 8.413 3.488 11.82 11.82 0 0 1 3.48 8.414c-.003 6.557-5.338 11.892-11.893 11.892a11.9 11.9 0 0 1-5.688-1.448L.057 24zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884-.001 2.225.651 3.891 1.746 5.634l-.999 3.648 3.742-.981z" fill="currentColor" /></svg></a>
            <a href="#" aria-label="Instagram"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="2" y="2" width="20" height="20" rx="5" /><circle cx="12" cy="12" r="4" /><circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none" /></svg></a>
            <a href="#" aria-label="X"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg></a>
          </div>
        </div>
      </footer>
    </div>
  );
}
