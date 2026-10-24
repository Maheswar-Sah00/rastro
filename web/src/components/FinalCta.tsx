import { useEffect, useRef } from 'react';
import { useData } from '../lib/data';

export function FinalCta({ onTrace }: { onTrace: () => void }) {
  const headline = useData('metrics').data?.headline as { voyages?: number } | undefined;
  const voyages = headline?.voyages;
  const path = useRef<SVGPathElement>(null);

  // The trace line draws itself as the section scrolls into view.
  useEffect(() => {
    const el = path.current;
    if (!el) return;
    const len = el.getTotalLength();
    el.style.strokeDasharray = `${len}`;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let raf = 0;
    const on = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        const p = Math.min(1, Math.max(0, (window.innerHeight - r.top) / (window.innerHeight * 0.6)));
        el.style.strokeDashoffset = `${len * (1 - p)}`;
      });
    };
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', on);
    };
  }, []);

  return (
    <section className="final-cta" aria-labelledby="cta-title">
      <svg className="cta-line" viewBox="0 0 200 130" aria-hidden>
        <path ref={path} d="M40 0 V30 C40 70 150 50 160 108" fill="none" />
        <rect x="155" y="115" width="10" height="10" rx="5" />
      </svg>
      <p className="kicker center">Start with one shipment</p>
      <h2 id="cta-title">Bring us a voyage.</h2>
      <p className="deck">
        Pick any of the {voyages ?? 36} live-export voyages from Barcarena and see where its cattle were born, ranch by ranch, permit by permit.
      </p>
      <div className="hero-cta center">
        <button className="btn btn-primary btn-lg" onClick={onTrace}>
          Trace a ship to Türkiye <span aria-hidden>↗</span>
        </button>
        <a className="btn btn-lg" href="./console.html">
          Open the analyst console <span aria-hidden>↗</span>
        </a>
      </div>
    </section>
  );
}
