import { useEffect, useState } from 'react';

// "Our system": three stacked layers, permits → lineage (AI) → HerdLedger (chain).

const N = 8; // grid cells per side on each plane
const A = 210; // half-width of a plane
const B = 72; // half-height of a plane
const CX = 240;
const LAYER_Y = [104, 240, 376];

type Cell = [number, number];
const LAYERS: { title: string; tag: string; text: string; cells: Cell[]; red?: Cell[]; links?: [Cell, Cell][] }[] = [
  {
    title: 'Permits in',
    tag: 'GTA feed',
    text: 'Every animal transit permit becomes a lot: date, origin, destination, head count. Only salted hashes leave the agency.',
    cells: [[1, 1], [5, 1], [3, 3], [6, 4], [2, 5], [5, 6], [1, 6]],
  },
  {
    title: 'Lineage traced',
    tag: 'AI',
    text: 'Lots flow first in, first out through every farm. Pass-through resales, phantom births and over-capacity herds get flagged with evidence.',
    cells: [[1, 1], [3, 3], [5, 3], [6, 6], [2, 5]],
    red: [[1, 1], [3, 3]],
    links: [[[1, 1], [3, 3]], [[3, 3], [5, 3]], [[2, 5], [5, 3]], [[5, 3], [6, 6]]],
  },
  {
    title: 'Ledger enforced',
    tag: 'HerdLedger',
    text: 'The contract refuses impossible herds for every buyer at once, and a clean-lot certificate can be spent exactly once.',
    cells: [[2, 2], [3, 2], [4, 2], [5, 2], [2, 4], [3, 4], [4, 4], [5, 4]],
    red: [[5, 4]],
  },
];

function pt(cy: number, u: number, v: number): [number, number] {
  // u runs top→right, v runs top→left.
  return [CX + (u - v) * A, cy - B + (u + v) * B];
}
function rhomb(cy: number, u0: number, v0: number, du: number, dv: number) {
  const p = [pt(cy, u0, v0), pt(cy, u0 + du, v0), pt(cy, u0 + du, v0 + dv), pt(cy, u0, v0 + dv)];
  return p.map((q) => q.join(',')).join(' ');
}

function Plane({ cy, active, layer }: { cy: number; active: boolean; layer: (typeof LAYERS)[number] }) {
  const lines = [];
  for (let k = 1; k < N; k++) {
    const a = pt(cy, k / N, 0), b = pt(cy, k / N, 1), c = pt(cy, 0, k / N), d = pt(cy, 1, k / N);
    lines.push(<line key={`u${k}`} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} />, <line key={`v${k}`} x1={c[0]} y1={c[1]} x2={d[0]} y2={d[1]} />);
  }
  const isRed = (c: Cell) => layer.red?.some((r) => r[0] === c[0] && r[1] === c[1]);
  const centre = (c: Cell) => pt(cy, (c[0] + 0.5) / N, (c[1] + 0.5) / N);
  return (
    <g className={`plane${active ? ' on' : ''}`}>
      {/* slab edge */}
      <polygon className="slab" points={[pt(cy, 1, 0), pt(cy, 1, 1), pt(cy, 0, 1)].map((p) => p.join(',')).join(' ') + ` ${CX - A},${cy + 6} ${CX},${cy + B + 6} ${CX + A},${cy + 6}`} />
      <polygon className="face" points={rhomb(cy, 0, 0, 1, 1)} />
      <g className="grid">{lines}</g>
      {layer.links?.map(([a, b], i) => {
        const p = centre(a), q = centre(b);
        return <line key={i} className="link" x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} />;
      })}
      {layer.cells.map((c) => (
        <polygon key={c.join('-')} className={`cell${isRed(c) ? ' red' : ''}`} points={rhomb(cy, (c[0] + 0.18) / N, (c[1] + 0.18) / N, 0.64 / N, 0.64 / N)} />
      ))}
    </g>
  );
}

export function SystemSection() {
  const [step, setStep] = useState(0);
  const [hold, setHold] = useState(false);

  useEffect(() => {
    if (hold || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const t = window.setInterval(() => setStep((s) => (s + 1) % LAYERS.length), 3600);
    return () => window.clearInterval(t);
  }, [hold]);

  return (
    <section id="system" className="section system" aria-labelledby="system-title">
      <div className="wrap">
        <div className="section-head center">
          <p className="kicker">02 · Our system</p>
          <h2 className="title" id="system-title">
            One rulebook for every buyer.
          </h2>
          <p className="deck">AI judges off-chain. The ledger enforces the rules on-chain, for every buyer at once.</p>
        </div>

        <div className="system-stage">
          <svg viewBox="0 0 480 470" className="stack" role="img" aria-label={`Three stacked layers. Active: ${LAYERS[step].title}.`}>
            <line className="axis" x1={CX} y1={0} x2={CX} y2={470} />
            {[...LAYERS].reverse().map((l, ri) => {
              const i = LAYERS.length - 1 - ri;
              return <Plane key={l.title} cy={LAYER_Y[i]} active={i === step} layer={l} />;
            })}
            <rect className="axis-dot" x={CX - 5} y={LAYER_Y[step] - 5} width={10} height={10} rx={5} />
          </svg>

          <ol className="system-steps" onMouseLeave={() => setHold(false)}>
            {LAYERS.map((l, i) => (
              <li key={l.title}>
                <button
                  className={i === step ? 'on' : undefined}
                  aria-pressed={i === step}
                  onMouseEnter={() => {
                    setHold(true);
                    setStep(i);
                  }}
                  onFocus={() => {
                    setHold(true);
                    setStep(i);
                  }}
                  onClick={() => {
                    setHold(true);
                    setStep(i);
                  }}
                >
                  <span className="rule" aria-hidden />
                  <span className="n">0{i + 1}</span>
                  <span className="t">{l.title}</span>
                  <span className="tg">{l.tag}</span>
                </button>
              </li>
            ))}
          </ol>
        </div>

        <div className="system-cards">
          {LAYERS.map((l, i) => (
            <div key={l.title} className={`system-card${i === step ? ' on' : ''}`}>
              <div className="h">
                <span className="n">0{i + 1}</span>
                <span>{l.title}</span>
              </div>
              <p>{l.text}</p>
            </div>
          ))}
        </div>
        <p className="center-link">
          <a href="#results" className="link-arrow">
            See the results <span aria-hidden>↗</span>
          </a>
        </p>
      </div>
    </section>
  );
}
