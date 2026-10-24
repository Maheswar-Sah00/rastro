import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

// Plain-English meanings for names that have to stay (agencies, datasets, permits). Shown on hover, focus or tap.
export const GLOSSARY = {
  GTA: 'Guia de Trânsito Animal: the government permit needed to move cattle from one ranch to another in Brazil.',
  PRODES: "Brazil's official satellite monitoring of forest clearing, run by the space agency INPE.",
  FUNAI: "Brazil's Indigenous affairs agency. It publishes the official map of Indigenous lands.",
  'IBGE PPM': "Brazil's official yearly count of cattle in each municipality.",
  Trase: 'A public dataset that maps which slaughterhouses and exporters buy from where.',
  EUDR: 'EU Deforestation Regulation: beef sold in the EU must not come from land cleared after 31 December 2020.',
} as const;

const EDGE = 8; // minimum gap between the tooltip and the window edge

/** A term with a dotted underline; its meaning pops up kept fully inside the window (never clipped by panels). */
export function Term({ k, children }: { k: keyof typeof GLOSSARY; children?: ReactNode }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  const id = useId();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Place after render, once the tooltip's real size is known: centred on the term, clamped to the window, above if it fits.
  useLayoutEffect(() => {
    if (!open || !anchor.current || !tip.current) return setPos(null);
    const a = anchor.current.getBoundingClientRect();
    const { offsetWidth: w, offsetHeight: h } = tip.current;
    const left = Math.min(Math.max(EDGE, a.left + a.width / 2 - w / 2), window.innerWidth - w - EDGE);
    const top = a.top - h - 8 >= EDGE ? a.top - h - 8 : a.bottom + 8;
    setPos({ left, top });
  }, [open]);

  // A fixed tooltip would drift away from its term on scroll, so close it instead.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  return (
    <span
      ref={anchor}
      className="term"
      tabIndex={0}
      aria-describedby={open ? id : undefined}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onClick={() => setOpen((v) => !v)}
    >
      {children ?? k}
      {open && (
        <span ref={tip} id={id} className="term-tip" role="tooltip" style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden', left: 0, top: 0 }}>
          {GLOSSARY[k]}
        </span>
      )}
    </span>
  );
}
