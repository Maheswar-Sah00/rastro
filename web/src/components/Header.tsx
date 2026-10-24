import { useEffect, useRef, useState } from 'react';
import { switchTheme, useTheme } from '../lib/theme';
import { Mark } from './Tags';

const NAV: [string, string][] = [
  ['problem', 'Problem'],
  ['system', 'System'],
  ['results', 'Results'],
  ['map', 'Map'],
  ['trace', 'Trace'],
  ['ledger', 'Ledger'],
];

export function Header({ active, onTrace, entered }: { active: string | null; onTrace: () => void; entered: boolean }) {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const bar = useRef<HTMLDivElement>(null);

  // Reading progress line under the header, and a hairline once the hero scrolls away.
  useEffect(() => {
    let raf = 0;
    const on = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const max = document.documentElement.scrollHeight - window.innerHeight;
        const p = max > 0 ? Math.min(1, window.scrollY / max) : 0;
        if (bar.current) bar.current.style.transform = `scaleX(${p})`;
        setScrolled(window.scrollY > 8);
      });
    };
    on();
    window.addEventListener('scroll', on, { passive: true });
    window.addEventListener('resize', on);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', on);
      window.removeEventListener('resize', on);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open]);

  return (
    <header className={`site-header${scrolled ? ' scrolled' : ''}${open ? ' open' : ''}`}>
      <div className="wrap">
        <a className="brand" href="#top" aria-label="Rastro, back to top" data-enter="drop">
          <Mark />
          <span className="brand-name">Rastro</span>
        </a>
        <nav className="nav" aria-label="Sections" id="site-nav">
          {entered && NAV.map(([id, label], i) => (
            <a key={id} href={`#${id}`} className={active === id ? 'active' : undefined} onClick={() => setOpen(false)} data-enter="drop" style={{ ['--i' as string]: i + 1 }}>
              {label}
            </a>
          ))}
        </nav>
        <div className="header-right" data-enter="drop" style={{ ['--i' as string]: NAV.length + 2 }}>
          <ThemeButton />
          {entered && <button
            className="btn btn-primary header-cta"
            onClick={() => {
              setOpen(false);
              onTrace();
            }}
          >
            Trace a shipment <span aria-hidden>↗</span>
          </button>}
          <button className="burger" aria-label={open ? 'Close menu' : 'Open menu'} aria-expanded={open} aria-controls="site-nav" onClick={() => setOpen((v) => !v)}>
            <span />
            <span />
          </button>
        </div>
      </div>
      <div className="progress" aria-hidden>
        <div ref={bar} />
      </div>
    </header>
  );
}

function ThemeButton() {
  const [theme] = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      className="theme-btn"
      onClick={(e) => {
        const b = e.currentTarget.getBoundingClientRect();
        switchTheme(next, b.left + b.width / 2, b.top + b.height / 2);
      }}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
    >
      {theme === 'dark' ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
          <circle cx="12" cy="12" r="4.2" />
          <path d="M12 2.8v2.2M12 19v2.2M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2.8 12h2.2M19 12h2.2M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />
        </svg>
      )}
    </button>
  );
}
