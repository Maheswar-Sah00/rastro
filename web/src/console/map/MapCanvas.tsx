import { useEffect, useRef, useState } from 'react';
import maplibregl, { type GeoJSONSource, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Feature, FeatureCollection, LineString } from 'geojson';
import { bboxOf, centroid, loadLayer } from './geo';

export type LayerKey = 'ranches' | 'deforestation' | 'cleared2008' | 'indigenous' | 'conservation' | 'embargo' | 'routes';
export const LAYER_LABELS: Record<LayerKey, string> = {
  ranches: 'Ranch boundaries (synthetic)',
  deforestation: 'PRODES clearing 2008–2025 (real)',
  cleared2008: 'Cleared before 2008 (real)',
  indigenous: 'Indigenous territories (real)',
  conservation: 'Protected areas (real)',
  embargo: 'Embargoes (simulated)',
  routes: 'Movement routes',
};

// Muted earth tones; red only for blocking risk.
export const RISK_COLOR: Record<string, string> = {
  high: '#e5484d',
  watch: '#fab219',
  clean: '#0ca30c',
  insufficient_data: '#898781',
  unassessed: '#2a312c',
};

// Plain background style: no third-party basemap needed, so the map never fails on tiles.
const STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#101411' } }],
};
const SATELLITE_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

export interface Route { from: [number, number]; to: [number, number]; head: number; gta: string; refused?: boolean; date?: string }

export function MapCanvas({ riskByRanch, layers, selected, onSelectRanch, routes, focus, compact, satellite }: {
  riskByRanch: Record<string, string>;
  layers: Record<LayerKey, boolean>;
  selected?: string | null;
  onSelectRanch?: (id: string) => void;
  routes?: Route[];
  focus?: string | null;
  compact?: boolean;
  satellite?: boolean;
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const ranchFc = useRef<FeatureCollection | null>(null);
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null);
  const cb = useRef(onSelectRanch);
  cb.current = onSelectRanch;

  useEffect(() => {
    if (!el.current) return;
    const m = new maplibregl.Map({ container: el.current, style: STYLE, center: [-51.95, -6.65], zoom: compact ? 8.3 : 8.8, attributionControl: false });
    map.current = m;
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    if (!compact) m.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
    m.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: 'INPE PRODES, FUNAI via TerraBrasilis; ranch cells synthetic' }), 'bottom-right');
    m.on('load', async () => {
      try {
        const [ranches, defor, before, prot, aoi] = await Promise.all(
          ['ranch_evidence', 'deforestation', 'cleared_before_2008', 'protected', 'aoi'].map(loadLayer),
        );
        ranchFc.current = ranches;
        m.addSource('sat', { type: 'raster', tiles: [SATELLITE_TILES], tileSize: 256, attribution: 'Esri World Imagery' });
        m.addLayer({ id: 'sat', type: 'raster', source: 'sat', layout: { visibility: 'none' } });
        m.addSource('aoi', { type: 'geojson', data: aoi });
        m.addLayer({ id: 'aoi', type: 'line', source: 'aoi', paint: { 'line-color': '#8a928b', 'line-dasharray': [2, 2], 'line-width': 1 } });
        m.addSource('before', { type: 'geojson', data: before });
        m.addLayer({ id: 'cleared2008', type: 'fill', source: 'before', paint: { 'fill-color': '#3b3527', 'fill-opacity': 0.55 } });
        m.addSource('defor', { type: 'geojson', data: defor });
        m.addLayer({
          id: 'deforestation', type: 'fill', source: 'defor',
          paint: { 'fill-color': ['case', ['>', ['get', 'year'], 2020], '#e5484d', '#a7773f'], 'fill-opacity': 0.7 },
        });
        m.addSource('prot', { type: 'geojson', data: prot });
        m.addLayer({ id: 'indigenous', type: 'fill', source: 'prot', filter: ['==', ['get', 'kind'], 'indigenous'], paint: { 'fill-color': '#7d6a8c', 'fill-opacity': 0.18 } });
        m.addLayer({ id: 'indigenous-line', type: 'line', source: 'prot', filter: ['==', ['get', 'kind'], 'indigenous'], paint: { 'line-color': '#a58bc0', 'line-width': 1.4 } });
        m.addLayer({ id: 'conservation', type: 'fill', source: 'prot', filter: ['==', ['get', 'kind'], 'conservation'], paint: { 'fill-color': '#4f7a5a', 'fill-opacity': 0.08 } });
        m.addLayer({ id: 'conservation-line', type: 'line', source: 'prot', filter: ['==', ['get', 'kind'], 'conservation'], paint: { 'line-color': '#5ccf5c', 'line-width': 1.2, 'line-dasharray': [3, 2] } });
        m.addSource('ranches', { type: 'geojson', data: ranches, promoteId: 'ranch_id' });
        m.addLayer({ id: 'ranches', type: 'fill', source: 'ranches', paint: { 'fill-color': '#2a312c', 'fill-opacity': 0.5 } });
        m.addLayer({
          id: 'ranches-line', type: 'line', source: 'ranches',
          paint: { 'line-color': ['case', ['boolean', ['feature-state', 'selected'], false], '#eef1ec', 'rgba(255,255,255,.28)'], 'line-width': ['case', ['boolean', ['feature-state', 'selected'], false], 2.6, 0.5] },
        });
        m.addLayer({ id: 'embargo', type: 'line', source: 'ranches', filter: ['==', ['get', 'embargo'], 'active'], paint: { 'line-color': '#e5484d', 'line-width': 2, 'line-dasharray': [1, 1] } });
        m.addSource('routes', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        m.addLayer({
          id: 'routes', type: 'line', source: 'routes',
          paint: {
            'line-color': ['case', ['get', 'refused'], '#e5484d', '#3987e5'],
            'line-width': ['interpolate', ['linear'], ['get', 'head'], 1, 1, 500, 5],
            'line-opacity': 0.8,
            'line-dasharray': ['case', ['get', 'refused'], ['literal', [2, 2]], ['literal', [1, 0]]],
          },
        });
        const pick = (e: maplibregl.MapMouseEvent) => m.queryRenderedFeatures(e.point, { layers: ['ranches'] })[0];
        m.on('click', (e) => {
          const f = pick(e);
          if (f?.properties?.ranch_id) cb.current?.(String(f.properties.ranch_id));
        });
        m.on('mousemove', (e) => {
          const r = m.queryRenderedFeatures(e.point, { layers: ['routes'] })[0];
          const f = pick(e);
          m.getCanvas().style.cursor = f && cb.current ? 'pointer' : '';
          if (r) setHover({ x: e.point.x, y: e.point.y, text: `${r.properties?.gta} · ${r.properties?.head} head${r.properties?.date ? ` · ${r.properties.date}` : ''}${r.properties?.refused ? ' · refused by the ledger' : ''}` });
          else if (f) setHover({ x: e.point.x, y: e.point.y, text: `${f.properties?.ranch_id} (synthetic cell) · post-cut-off ${f.properties?.post_cutoff_ha ?? '—'} ha` });
          else setHover(null);
        });
        m.on('mouseout', () => setHover(null));
        setReady(true);
      } catch (e) {
        setErr(`Map layers could not be loaded: ${(e as Error).message}`);
      }
    });
    return () => {
      m.remove();
      map.current = null;
    };
  }, [compact]);

  // risk colours
  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    const expr: unknown[] = ['match', ['get', 'ranch_id']];
    for (const [id, cls] of Object.entries(riskByRanch)) expr.push(id, RISK_COLOR[cls] || RISK_COLOR.unassessed);
    expr.push(RISK_COLOR.unassessed);
    m.setPaintProperty('ranches', 'fill-color', Object.keys(riskByRanch).length ? (expr as maplibregl.ExpressionSpecification) : RISK_COLOR.unassessed);
  }, [riskByRanch, ready]);

  // layer visibility
  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    const vis = (id: string, on: boolean) => m.getLayer(id) && m.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    vis('ranches', layers.ranches);
    vis('ranches-line', layers.ranches);
    vis('deforestation', layers.deforestation);
    vis('cleared2008', layers.cleared2008);
    vis('indigenous', layers.indigenous);
    vis('indigenous-line', layers.indigenous);
    vis('conservation', layers.conservation);
    vis('conservation-line', layers.conservation);
    vis('embargo', layers.embargo);
    vis('routes', layers.routes);
    vis('sat', !!satellite);
  }, [layers, ready, satellite]);

  // selection + focus
  const prevSel = useRef<string | null>(null);
  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    if (prevSel.current) m.setFeatureState({ source: 'ranches', id: prevSel.current }, { selected: false });
    if (selected) m.setFeatureState({ source: 'ranches', id: selected }, { selected: true });
    prevSel.current = selected || null;
    const target = focus || selected;
    const f = target ? ranchFc.current?.features.find((x) => x.properties?.ranch_id === target) : null;
    if (f && focus) {
      const b = bboxOf(f.geometry);
      if (b) m.fitBounds(b, { padding: 120, maxZoom: 11.5, duration: 600 });
    }
  }, [selected, focus, ready]);

  // routes
  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    const fc: FeatureCollection<LineString> = {
      type: 'FeatureCollection',
      features: (routes || []).map(
        (r): Feature<LineString> => ({
          type: 'Feature',
          properties: { head: r.head, gta: r.gta, refused: !!r.refused, date: r.date || '' },
          geometry: { type: 'LineString', coordinates: [r.from, r.to] },
        }),
      ),
    };
    (m.getSource('routes') as GeoJSONSource | undefined)?.setData(fc);
  }, [routes, ready]);

  return (
    <div className={`map ${compact ? 'map-compact' : ''}`}>
      <div ref={el} className="map-canvas" role="region" aria-label="Map of ranches and environmental layers" />
      {err && <div className="map-msg">{err}</div>}
      {hover && (
        <div className="map-hover" style={{ left: hover.x + 12, top: hover.y + 12 }}>
          {hover.text}
        </div>
      )}
    </div>
  );
}

/** Ranch-cell centroids keyed by ranch id (from the published map layer). */
export async function ranchCentroids(): Promise<Record<string, [number, number]>> {
  const fc = await loadLayer('ranch_evidence');
  const out: Record<string, [number, number]> = {};
  for (const f of fc.features) {
    const c = centroid(f.geometry);
    if (c && f.properties?.ranch_id) out[String(f.properties.ranch_id)] = c;
  }
  return out;
}
