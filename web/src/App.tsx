import { useCallback, useEffect, useRef, useState } from 'react';
import { ensure } from './lib/data';
import { parseHash, routeTarget, scrollToSection, SECTIONS, settleScroll } from './lib/route';
import { Header } from './components/Header';
import { Hero } from './components/Hero';
import { Problem } from './components/Problem';
import { HerdAssembly } from './components/HerdAssembly';
import { SystemSection } from './components/SystemSection';
import { ResultsSection } from './components/ResultsSection';
import { FinalCta } from './components/FinalCta';
import { MapSection } from './components/MapSection';
import { RanchPanel } from './components/RanchPanel';
import { TraceSection } from './components/TraceSection';
import { LedgerSection } from './components/LedgerSection';
import { Footer } from './components/Footer';

/** Any hash that points inside the site opens the full experience. */
function isDeepLink(hash: string) {
  const r = parseHash(hash);
  return hash.replace(/^#\/?/, '') === 'explore' || !!r.section || !!r.ranch;
}

export default function App() {
  const [ranch, setRanch] = useState<string | null>(null);
  const [shipment, setShipment] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [forceMap, setForceMap] = useState(false);
  const [forceTrace, setForceTrace] = useState(false);
  // Landing first: only the hero until the visitor enters (or arrives on a deep link).
  const [entered, setEntered] = useState(() => isDeepLink(window.location.hash));
  const activeRef = useRef(active);
  activeRef.current = active;

  // Small files for the first screen.
  useEffect(() => {
    void ensure('meta');
    void ensure('metrics');
  }, []);

  // Deep links: #map, #trace/SHP-0018, #ranch/R0120, #ledger, #results
  useEffect(() => {
    const apply = (initial: boolean) => {
      const r = parseHash(window.location.hash);
      const deep = isDeepLink(window.location.hash);
      setEntered(deep);
      if (!deep && !initial) window.scrollTo({ top: 0 });
      setRanch(r.ranch);
      if (r.ranch) setForceMap(true);
      if (r.shipment) setShipment(r.shipment);
      if (r.section === 'trace') setForceTrace(true);
      if (r.section === 'map') setForceMap(true);
      // Land on the target and hold it there while lazy sections above it load.
      if (r.section && (initial || !r.ranch)) {
        const target = routeTarget(r);
        window.setTimeout(() => settleScroll(target, { smooth: !initial, duration: initial ? 4000 : 2500 }), initial ? 30 : 0);
      }
    };
    apply(true);
    const onPop = () => apply(false);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Scroll spy for the nav.
  useEffect(() => {
    const els = SECTIONS.map((id) => document.getElementById(id)).filter(Boolean) as HTMLElement[];
    if (!('IntersectionObserver' in window)) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActive(e.target.id);
      },
      { rootMargin: '-40% 0px -55% 0px' },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [entered]);

  const openRanch = useCallback((id: string) => {
    setRanch(id);
    setForceMap(true);
    window.history.pushState(null, '', `#ranch/${encodeURIComponent(id)}`);
  }, []);
  const closeRanch = useCallback(() => {
    setRanch(null);
    window.history.replaceState(null, '', `#${activeRef.current ?? 'map'}`);
  }, []);
  const pickShipment = useCallback((id: string, scroll = false) => {
    setShipment(id);
    setForceTrace(true);
    window.history.replaceState(null, '', `#trace/${encodeURIComponent(id)}`);
    if (scroll) window.setTimeout(() => settleScroll(routeTarget({ section: 'trace', ranch: null, shipment: id }), { smooth: true }), 30);
  }, []);

  const enter = useCallback(() => {
    setEntered(true);
    window.history.pushState(null, '', '#explore');
    window.setTimeout(() => scrollToSection('problem'), 30);
  }, []);
  const trace = useCallback(() => {
    setEntered(true);
    setForceTrace(true);
    window.history.replaceState(null, '', shipment ? `#trace/${shipment}` : '#trace');
    // The shipment detail renders once the shipments file loads, while lazy sections above it grow,
    // so hold the scroll on it rather than jumping once.
    window.setTimeout(() => settleScroll(() => document.getElementById('trace-detail') ?? document.getElementById('trace'), { smooth: true, duration: 6000 }), 30);
  }, [shipment]);

  return (
    <>
      <Header active={active} onTrace={trace} entered={entered} />
      <main>
        <Hero onEnter={enter} onTrace={trace} entered={entered} />
        {entered && (
          <>
            <Problem />
            <HerdAssembly />
            <SystemSection />
            <ResultsSection />
            <MapSection selected={ranch} onSelect={openRanch} forceLoad={forceMap} />
            <TraceSection shipmentId={shipment} onShipment={(id) => pickShipment(id)} onRanch={openRanch} forceLoad={forceTrace} />
            <LedgerSection onRanch={openRanch} onShipment={(id) => pickShipment(id, true)} />
            <FinalCta onTrace={trace} />
          </>
        )}
      </main>
      {entered && <Footer />}
      {ranch && (
        <RanchPanel
          id={ranch}
          onClose={closeRanch}
          onSelect={openRanch}
          onShowMap={() => {
            setForceMap(true);
            scrollToSection('map');
          }}
        />
      )}
    </>
  );
}
