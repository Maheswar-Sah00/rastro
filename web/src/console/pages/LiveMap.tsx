import { useEffect, useMemo, useState } from 'react';
import { api, unwrap } from '../api/client';
import { riskMap, useAllRanches } from '../api/hooks';
import type { BundleDestination } from '../api/types';
import { useApi } from '../api/useApi';
import { ProvenanceLabel } from '../components/Badges';
import { ErrorState } from '../components/States';
import { Drawer } from '../components/Overlays';
import { LAYER_LABELS, MapCanvas, RISK_COLOR, ranchCentroids, type LayerKey, type Route as MapRoute } from '../map/MapCanvas';
import { type Route, setQuery } from '../lib/router';
import { RanchDetailBody } from './Ranches';

const DEFAULT_LAYERS: Record<LayerKey, boolean> = { ranches: true, deforestation: true, cleared2008: false, indigenous: true, conservation: true, embargo: true, routes: true };

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
          <h1>Live Map</h1>
          <fieldset className="layer-control">
            <legend>Layers</legend>
            {(Object.keys(LAYER_LABELS) as LayerKey[]).map((k) => (
              <label key={k}>
                <input type="checkbox" checked={layers[k]} onChange={(e) => setLayers({ ...layers, [k]: e.target.checked })} /> {LAYER_LABELS[k]}
              </label>
            ))}
            <label>
              <input type="checkbox" checked={satellite} onChange={(e) => setSatellite(e.target.checked)} /> Satellite imagery (Esri, online)
            </label>
          </fieldset>
          <div className="legend">
            <div className="legend-title">Ranch risk (risk engine)</div>
            {Object.entries(RISK_COLOR).map(([k, c]) => (
              <div key={k}>
                <span className="swatch" style={{ background: c }} /> {k === 'unassessed' ? 'not assessed' : k.replace('_', ' ')}
              </div>
            ))}
            <div className="legend-title">Layers</div>
            <div><span className="swatch" style={{ background: '#e5484d' }} /> clearing after 2020 (PRODES)</div>
            <div><span className="swatch" style={{ background: '#a7773f' }} /> clearing 2008–2020</div>
            <div><span className="swatch" style={{ background: '#3b3527' }} /> cleared before 2008</div>
            <div><span className="swatch line" style={{ borderColor: '#a58bc0' }} /> Indigenous territory</div>
            <div><span className="swatch line dashed" style={{ borderColor: '#5ccf5c' }} /> protected area (APA)</div>
            <div><span className="swatch line dashed" style={{ borderColor: '#e5484d' }} /> active embargo (simulated)</div>
            <div><span className="swatch line" style={{ borderColor: '#3987e5' }} /> movement route · <span style={{ color: '#e5484d' }}>dashed red = refused</span></div>
          </div>
          <div className="small">
            <ProvenanceLabel status="synthetic">Ranch cells</ProvenanceLabel> <ProvenanceLabel status="real">PRODES / FUNAI</ProvenanceLabel>
          </div>
          {shipment && (
            <div className="note">
              Showing the upstream movements of <strong className="mono">{shipment}</strong>.{' '}
              <button type="button" className="btn btn-link" onClick={() => setQuery(route, { shipment: null })}>
                Clear
              </button>
            </div>
          )}
          {selected && !shipment && <div className="small muted">Routes: movements of {selected} (first 500).</div>}
          {offMap > 0 && <div className="small muted">{offMap} movement(s) involve places with no coordinates (suppliers outside the window) and are not drawn.</div>}
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
