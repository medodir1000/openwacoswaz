import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Smartphone, ChevronDown, Check, Layers } from 'lucide-react';
import { useActiveSession, type WaSession } from '../hooks/useActiveSession';

// Pretty-print a session for the trigger / menu rows. Prefer the friendly
// OpenWA name ("bot1"), then the phone, then a short slice of the UUID.
function sessionLabel(s: WaSession): string {
  if (s.name) return s.name;
  if (s.phone) return `+${s.phone.replace(/^\+/, '')}`;
  return s.id.slice(0, 8);
}
function sessionPhone(s: WaSession): string {
  return s.phone ? `+${s.phone.replace(/^\+/, '')}` : '';
}

/**
 * Top-bar dropdown that scopes every seller surface (products, services,
 * orders, conversations) to ONE connected WhatsApp number — or "All
 * sessions". Renders nothing for sellers with fewer than two numbers
 * (there is nothing to switch between) and for admins (no tenant).
 */
export function SessionSwitcher() {
  const { t } = useTranslation();
  const { sessions, activeSessionId, setActiveSessionId, activeSession } = useActiveSession();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Close on outside-click + Esc (same affordance as the language menu).
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  // A switcher only earns its space once the seller runs 2+ numbers.
  if (sessions.length < 2) return null;

  const allLabel = t('topbar.allSessions', 'All sessions');
  const triggerLabel = activeSession ? sessionLabel(activeSession) : allLabel;
  const pick = (id: string | null) => {
    setActiveSessionId(id);
    setOpen(false);
  };

  return (
    <div className="topbar-session-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`topbar-session ${open ? 'is-open' : ''} ${activeSessionId ? 'is-scoped' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={t('topbar.sessionScope', 'View one WhatsApp number at a time')}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {activeSessionId ? <Smartphone size={15} /> : <Layers size={15} />}
        <span className="topbar-session-label">{triggerLabel}</span>
        <ChevronDown size={14} className="topbar-session-chevron" />
      </button>

      {open && (
        <div className="session-menu" role="menu">
          <button
            role="menuitemradio"
            aria-checked={!activeSessionId}
            className={`session-menu-item ${!activeSessionId ? 'is-active' : ''}`}
            onClick={() => pick(null)}
          >
            <Layers size={15} />
            <span className="session-menu-name">{allLabel}</span>
            {!activeSessionId && <Check size={14} className="session-menu-tick" />}
          </button>

          <div className="session-menu-sep" />

          {sessions.map((s) => {
            const on = s.id === activeSessionId;
            const ready = (s.status || '').toLowerCase() === 'ready'
              || (s.status || '').toLowerCase() === 'connected';
            const phone = sessionPhone(s);
            return (
              <button
                key={s.id}
                role="menuitemradio"
                aria-checked={on}
                className={`session-menu-item ${on ? 'is-active' : ''}`}
                onClick={() => pick(s.id)}
                title={s.id}
              >
                <span className={`session-dot ${ready ? 'ok' : 'off'}`} />
                <span className="session-menu-body">
                  <span className="session-menu-name">{sessionLabel(s)}</span>
                  {phone && s.name && <span className="session-menu-phone">{phone}</span>}
                </span>
                {on && <Check size={14} className="session-menu-tick" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
