import { useEffect, useRef, useState, type ReactNode } from 'react';
import { fmt } from '../lib/format';
import { HELDOUT, HELDOUT_LABEL } from '../lib/heldout';
import { SourceTag } from './Tags';

const reduced = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function Hero({ onEnter, onTrace, entered }: { onEnter: () => void; onTrace: () => void; entered: boolean }) {
  const img = useRef<HTMLImageElement>(null);
  const [imgReady, setImgReady] = useState(false);
  const ref = HELDOUT.reference;
  const red = HELDOUT.redteam;

  useEffect(() => entrance(img.current), []);

  return (
    <section id="top" className="hero" aria-labelledby="hero-title">
      <div className={`hero-media${imgReady ? ' ready' : ''}`} aria-hidden>
        <img
          ref={img}
          src="./hero/xingu-s2-2048.jpg"
          srcSet="./hero/xingu-s2-1280.jpg 1280w, ./hero/xingu-s2-2048.jpg 2048w"
          sizes="100vw"
          alt=""
          decoding="async"
          fetchPriority="high"
          onLoad={() => setImgReady(true)}
        />
      </div>
      <div className="hero-veil" aria-hidden />

      <div className="hero-stage wrap">
        <div className="hero-copy">
          <p className="hero-eyebrow">
            <span className="dot" data-enter="dot" />
            <span data-enter="fade">For every forest frontier · piloted in the Amazon</span>
          </p>
          <h1 id="hero-title">
            <span className="line">
              <span data-enter="rise">Every head traced.</span>
            </span>
            <span className="line dim">
              <span data-enter="rise" style={{ ['--i' as string]: 1 }}>
                Back to its birth.
              </span>
            </span>
          </h1>
          <p className="hero-lede" data-enter="settle">
            Cattle is the biggest driver of tropical deforestation. Rastro checks every ranch against the physics of a herd, traces each shipment
            to where it was born, and anchors the proof on a ledger every buyer shares.
          </p>
          <div className="hero-cta" data-enter="settle" style={{ ['--i' as string]: 1 }}>
            <button className="btn btn-primary btn-lg" onClick={onEnter}>
              Explore Rastro <span aria-hidden>→</span>
            </button>
            <button className="btn btn-glass btn-lg" onClick={onTrace}>
              Trace a ship to Türkiye <span aria-hidden>↗</span>
            </button>
          </div>
          <p className="hero-note" data-enter="settle" style={{ ['--i' as string]: 2 }}>
            <span className="sq" aria-hidden>
              IEEE
            </span>
            ClimateChain 2026 · Sustainable supply chains
          </p>
        </div>

        <div className="hero-cards" role="list" aria-label="Results on the simulated supply chain">
          <Glass i={0} label="Tainted head flagged" icon={<IconTrace />} value={`${fmt(ref.flaggedPct, 1)}%`} sub={`vs ${fmt(ref.baselinePct, 1)}% today`} note={`${fmt(ref.flagOrReviewPct, 1)}% incl. human review`} />
          <Glass i={1} label="Clean lots blocked" icon={<IconShield />} value={`${fmt(ref.cleanBlockedPct, 1)}%`} sub={`vs ${fmt(ref.baselineCleanBlockedPct, 1)}% today`} />
          <Glass i={2} label="Red team: flagged" icon={<IconRanch />} value={`${fmt(red.flaggedPct, 1)}%`} sub={`vs ${fmt(red.baselinePct, 1)}% today`} note="patient, two-hop launderers" />
          <p className="hero-cards-note" data-enter="settle" style={{ ['--i' as string]: 3 }}>
            <SourceTag kind="synthetic" title={HELDOUT_LABEL} /> held-out world, never used for tuning ·{' '}
            <button className="linkish" onClick={onEnter}>results</button>
          </p>
        </div>
      </div>

      <div className="hero-foot wrap">
        {entered ? (
          <a className="scroll-cue" href="#problem" data-enter="fade" style={{ ['--i' as string]: 4 }}>
            Scroll to explore <span aria-hidden>↓</span>
          </a>
        ) : (
          <span className="frontiers" data-enter="fade" style={{ ['--i' as string]: 4 }} aria-label="Cattle-driven forest frontiers">
            {FRONTIERS.map((f) => (
              <span key={f}>{f}</span>
            ))}
          </span>
        )}
        <p className="hero-credit" data-enter="fade" style={{ ['--i' as string]: 4 }}>
          <SourceTag kind="real" title="Copernicus Sentinel-2 L2A true colour, via Microsoft Planetary Computer" /> Sentinel-2 · 11 Sep 2025 · São Félix do
          Xingu, Pará · 6.75°S 52.03°W
        </p>
      </div>
    </section>
  );
}

// Frontiers where cattle ranching is a leading driver of forest loss. Rastro's pilot data is the first one.
const FRONTIERS = ['Amazon', 'Cerrado', 'Gran Chaco', 'Colombian Amazon', 'Central America'];

function Glass({ i, label, icon, value, sub, note }: { i: number; label: string; icon: ReactNode; value: string; sub: string; note?: string }) {
  return (
    <article className="glass" role="listitem" data-enter="card" style={{ ['--i' as string]: i }}>
      <span className="glass-label">
        {icon}
        {label}
      </span>
      <span className="glass-value">{value}</span>
      <span className="glass-sub">{sub}</span>
      {note && <span className="glass-note">{note}</span>}
    </article>
  );
}

const ico = { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': true } as const;
function IconTrace() {
  return (
    <svg {...ico}>
      <circle cx="3" cy="12" r="1.6" />
      <circle cx="13" cy="4" r="1.6" />
      <path d="M4.4 11 C 8 10, 8 6, 11.6 5" strokeLinecap="round" />
    </svg>
  );
}
function IconRanch() {
  return (
    <svg {...ico}>
      <rect x="2" y="2" width="5" height="5" />
      <rect x="9" y="2" width="5" height="5" />
      <rect x="2" y="9" width="5" height="5" />
      <rect x="9" y="9" width="5" height="5" fill="currentColor" />
    </svg>
  );
}
function IconShield() {
  return (
    <svg {...ico}>
      <path d="M8 1.8 L13.5 4 V8 C13.5 11 11 13.4 8 14.2 C5 13.4 2.5 11 2.5 8 V4 Z" strokeLinejoin="round" />
      <path d="M5.6 8.2 L7.3 9.8 L10.5 6.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const EASE = 'cubic-bezier(0.2, 0.7, 0.1, 1)';
const KEYFRAMES: Record<string, { k: Keyframe[]; d: number; gap: number; at: number }> = {
  drop: { k: [{ opacity: 0, transform: 'translateY(-14px)' }, { opacity: 1, transform: 'none' }], d: 700, gap: 60, at: 0 },
  dot: { k: [{ clipPath: 'circle(0% at 50% 50%)' }, { clipPath: 'circle(75% at 50% 50%)' }], d: 500, gap: 0, at: 250 },
  fade: { k: [{ opacity: 0 }, { opacity: 1 }], d: 700, gap: 120, at: 420 },
  rise: { k: [{ transform: 'translateY(105%)' }, { transform: 'none' }], d: 1000, gap: 130, at: 380 },
  settle: { k: [{ opacity: 0, transform: 'translateY(14px)' }, { opacity: 1, transform: 'none' }], d: 900, gap: 110, at: 760 },
  card: { k: [{ opacity: 0, transform: 'translateY(28px)' }, { opacity: 1, transform: 'none' }], d: 1000, gap: 130, at: 900 },
};

/**
 * One Web Animations timeline with backwards fill. Waits for fonts and the hero photo,
 * then cancels every animation so the page is left on its authored styles.
 */
function entrance(img: HTMLImageElement | null): () => void {
  const root = document.documentElement;
  const done = () => root.classList.remove('pre-enter');
  if (reduced() || !('animate' in Element.prototype)) {
    done();
    return () => {};
  }
  root.classList.add('pre-enter');
  let cancelled = false;
  const anims: Animation[] = [];
  const safety = window.setTimeout(done, 3000);
  const ready = Promise.all([
    document.fonts?.ready ?? Promise.resolve(),
    img ? (img.complete ? Promise.resolve() : img.decode().catch(() => undefined)) : Promise.resolve(),
  ]);
  void Promise.race([ready, new Promise((r) => window.setTimeout(r, 1800))]).then(() => {
    if (cancelled) return;
    for (const el of document.querySelectorAll<HTMLElement>('[data-enter]')) {
      const spec = KEYFRAMES[el.dataset.enter ?? ''];
      if (!spec) continue;
      const i = Number(getComputedStyle(el).getPropertyValue('--i')) || 0;
      anims.push(el.animate(spec.k, { duration: spec.d, delay: spec.at + i * spec.gap, easing: EASE, fill: 'backwards' }));
    }
    done();
    void Promise.all(anims.map((a) => a.finished.catch(() => undefined))).then(() => anims.forEach((a) => a.cancel()));
  });
  return () => {
    cancelled = true;
    window.clearTimeout(safety);
    anims.forEach((a) => a.cancel());
    done();
  };
}
