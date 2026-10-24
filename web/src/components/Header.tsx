import { useEffect, useRef, useState } from 'react';
import { Mark } from './Tags';
import { ThemeButton } from './ThemeButton';
import { TraceLauncher } from './TraceLauncher';

const NAV: [string, string][] = [
  ['problem', 'Problem'],
  ['system', 'System'],
  ['results', 'Results'],
  ['map', 'Map'],
  ['trace', 'Trace'],
  ['ledger', 'Ledger'],
];

export function Header({ active, entered, onTrace }: { active: string | null; entered: boolean; onTrace: (id: string) => void }) {
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
          <TraceLauncher
            onPick={(id) => {
              setOpen(false);
              onTrace(id);
            }}
          />
          <ThemeButton />
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
