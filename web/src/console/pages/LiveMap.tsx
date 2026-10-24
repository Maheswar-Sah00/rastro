import { useEffect, useMemo, useState } from 'react';
import { api, unwrap } from '../api/client';
import { riskMap, useAllRanches } from '../api/hooks';
import type { BundleDestination } from '../api/types';
import { useApi } from '../api/useApi';
import { ErrorState } from '../components/States';
import { Drawer } from '../components/Overlays';
import { DEFOR_COLOR, MapCanvas, RISK_COLOR, ranchCentroids, type LayerKey, type Route as MapRoute } from '../map/MapCanvas';
import { type Route, setQuery } from '../lib/router';
import { RanchDetailBody } from './Ranches';

const DEFAULT_LAYERS: Record<LayerKey, boolean> = { ranches: true, deforestation: true, cleared2008: false, indigenous: true, conservation: true, embargo: true, routes: true };

type Row = { key: LayerKey | 'satellite'; label: string; source?: 'real' | 'simulated'; swatch: { color: string; kind?: 'line' | 'line dashed' } };
// Layers grouped by what they mean, with plain names; the colour key sits under the layer it explains.
const GROUPS: { title: string; rows: Row[] }[] = [
  { title: 'Ranches', rows: [{ key: 'ranches', label: 'Ranch risk', source: 'simulated', swatch: { color: `linear-gradient(90deg,${RISK_COLOR.high} 0 33%,${RISK_COLOR.watch} 33% 66%,${RISK_COLOR.clean} 66%)` } }] },
  {
    title: 'Forest',
    rows: [
      { key: 'deforestation', label: 'Forest cleared 2008–2025', source: 'real', swatch: { color: `linear-gradient(90deg,${DEFOR_COLOR.pre} 0 50%,${DEFOR_COLOR.post} 50%)` } },
      { key: 'cleared2008', label: 'Forest cleared before 2008', source: 'real', swatch: { color: DEFOR_COLOR.before2008 } },
    ],
  },
  {
    title: 'Protected land',
    rows: [
      { key: 'indigenous', label: 'Indigenous lands', source: 'real', swatch: { color: '#b49ae0', kind: 'line' } },
      { key: 'conservation', label: 'Protected areas', source: 'real', swatch: { color: '#4fbf86', kind: 'line dashed' } },
    ],
  },
  {
    title: 'Activity',
    rows: [
      { key: 'embargo', label: 'Embargoed ranches', source: 'simulated', swatch: { color: '#e5484d', kind: 'line dashed' } },
      { key: 'routes', label: 'Cattle movements', source: 'simulated', swatch: { color: '#5aa2f0', kind: 'line' } },
    ],
  },
  { title: 'Base map', rows: [{ key: 'satellite', label: 'Satellite photo', swatch: { color: 'linear-gradient(135deg,#3d5a3a,#8a6a43)' } }] },
];

function Key({ items }: { items: [string, string][] }) {
  return (
    <span className="layer-key">
      {items.map(([c, l]) => (
        <span key={l}>
          <i style={{ background: c }} />
          {l}
        </span>
      ))}
    </span>
  );
}

export function LiveMap({ route }: { route: Route }) {
  const selected = route.query.get('ranch');
  const shipment = route.query.get('shipment');
  const [layers, setLayers] = useState(DEFAULT_LAYERS);
  const [satellite, setSatellite] = useState(false);
  const ranches = useAllRanches();
  const risk = useMemo(() => riskMap(ranches.data?.data), [ranches.data]);
  const [cent, setCent] = useState<Record<string, [number, number]>>({});
  useEffect(() => {
    ranchCentroids().then(setCent).catch(() => setCent({}));
  }, []);
  const dests = useApi((s) => api.bundleDestinations(s), []);
  const movements = useApi((s) => api.ranchMovements(selected!, { limit: 500 }, s), [selected], !!selected && !shipment);
  const lineage = useApi((s) => api.shipment(shipment!, s).then(unwrap), [shipment], !!shipment);

  const where = useMemo(() => {
    const out: Record<string, [number, number]> = { ...cent };
    for (const d of (dests.data?.data || []) as BundleDestination[]) out[d.id] = [d.lon, d.lat];
    return out;
  }, [cent, dests.data]);

  const routes: MapRoute[] = useMemo(() => {
    if (shipment && lineage.data?.lineage) {
      return lineage.data.lineage.trace_path
        .filter((p) => where[p.from] && where[p.to])
        .map((p) => ({ from: where[p.from], to: where[p.to], head: p.attributed_head, gta: p.gta_id, date: p.date }));
    }
    return (movements.data?.data || [])
      .filter((m) => where[m.movement.origin_id] && where[m.movement.destination_id])
      .map((m) => ({
        from: where[m.movement.origin_id], to: where[m.movement.destination_id], head: m.movement.head_count,
        gta: m.movement.gta_id, date: m.movement.movement_date, refused: m.ledger_status !== 'accepted',
      }));
  }, [movements.data, lineage.data, shipment, where]);
  const offMap = shipment
    ? (lineage.data?.lineage?.trace_path || []).filter((p) => !where[p.from] || !where[p.to]).length
    : (movements.data?.data || []).filter((m) => !where[m.movement.origin_id] || !where[m.movement.destination_id]).length;

  return (
    <div className="page page-map">
      <div className="map-layout">
        <aside className="map-side">
          <div>
            <h1>Live Map</h1>
            <p className="muted map-sub">Click any ranch to see why it got its rating.</p>
          </div>

          {shipment && (
            <div className="map-context">
              <span>
                Tracing <strong className="mono">{shipment}</strong> back to its ranches
              </span>
              <button type="button" className="btn btn-small" onClick={() => setQuery(route, { shipment: null })}>
                Clear
              </button>
            </div>
          )}
          {selected && !shipment && (
            <div className="map-context">
              <span>
                Showing cattle moving in and out of <strong className="mono">{selected}</strong>
              </span>
              <button type="button" className="btn btn-small" onClick={() => setQuery(route, { ranch: null, focus: null })}>
                Clear
              </button>
            </div>
          )}

          {GROUPS.map((g) => (
            <section key={g.title} className="layer-group" aria-label={g.title}>
              <h2 className="layer-group-title">{g.title}</h2>
              {g.rows.map((r) => {
                const on = r.key === 'satellite' ? satellite : layers[r.key];
                const set = (v: boolean) => (r.key === 'satellite' ? setSatellite(v) : setLayers({ ...layers, [r.key]: v }));
                return (
                  <div key={r.key} className={`layer-row ${on ? 'on' : ''}`}>
                    <label className="layer-main">
                      <span className={`swatch ${r.swatch.kind ?? ''}`} style={r.swatch.kind ? { borderColor: r.swatch.color } : { background: r.swatch.color }} />
                      <span className="layer-name">{r.label}</span>
                      {r.source && <span className={`layer-src ${r.source}`}>{r.source}</span>}
                      <input type="checkbox" role="switch" className="switch" checked={on} onChange={(e) => set(e.target.checked)} />
                    </label>
                    {on && r.key === 'ranches' && <Key items={[[RISK_COLOR.high, 'High'], [RISK_COLOR.watch, 'Watch'], [RISK_COLOR.clean, 'Clean']]} />}
                    {on && r.key === 'deforestation' && <Key items={[[DEFOR_COLOR.post, 'After 2020 (EU deadline)'], [DEFOR_COLOR.pre, '2008–2020']]} />}
                    {on && r.key === 'routes' && <span className="layer-hint">Dashed red: refused by the ledger</span>}
                  </div>
                );
              })}
            </section>
          ))}

          {offMap > 0 && <p className="small muted">{offMap} movement(s) go to places outside the map and are not drawn.</p>}
          {ranches.error && <ErrorState error={ranches.error} onRetry={ranches.reload} />}
        </aside>
        <MapCanvas
          riskByRanch={risk}
          layers={layers}
          satellite={satellite}
          selected={selected}
          focus={route.query.get('focus') || selected}
          routes={routes}
          onSelectRanch={(id) => setQuery(route, { ranch: id, focus: null, shipment: null })}
        />
        {selected && (
          <Drawer title={selected} subtitle="Ranch details" onClose={() => setQuery(route, { ranch: null, focus: null })}>
            <RanchDetailBody id={selected} compact />
          </Drawer>
        )}
      </div>
    </div>
  );
}
