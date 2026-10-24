import { useEffect, useRef, useState } from 'react';
import maplibregl, { type GeoJSONSource, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Feature, FeatureCollection, LineString } from 'geojson';
import { bboxOf, centroid, loadLayer } from './geo';

export type LayerKey = 'ranches' | 'deforestation' | 'cleared2008' | 'indigenous' | 'conservation' | 'embargo' | 'routes';
export const LAYER_LABELS: Record<LayerKey, string> = {
  ranches: 'Ranch risk (synthetic cells)',
  deforestation: 'Forest cleared 2008–2025 (PRODES, real)',
  cleared2008: 'Cleared before 2008 (real)',
  indigenous: 'Indigenous territories (real)',
  conservation: 'Protected areas (real)',
  embargo: 'Embargoes (simulated)',
  routes: 'Movement routes',
};

// Status colours (red only for blocking risk); the same values as the landing page.
export const RISK_COLOR: Record<string, string> = {
  high: '#e5484d',
  watch: '#fab219',
  clean: '#0ca30c',
  insufficient_data: '#898781',
  unassessed: '#2a312c',
};
// Clearing by PRODES year: soil browns up to the EUDR cut-off, magenta after (matches the landing map).
export const DEFOR_COLOR = { post: '#ff6fae', pre: '#a8865a', before2008: '#4a4436' };

// Dark vector basemap (OpenFreeMap). If it cannot load (offline), fall back to a plain background.
const BASEMAP = 'https://tiles.openfreemap.org/styles/dark';
const PLAIN: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#101411' } }],
};
const SATELLITE_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

export interface Route { from: [number, number]; to: [number, number]; head: number; gta: string; refused?: boolean; date?: string }

interface Layers { ranches: FeatureCollection; defor: FeatureCollection; before: FeatureCollection; prot: FeatureCollection; aoi: FeatureCollection }

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
  const aoiBox = useRef<[[number, number], [number, number]] | null>(null);
  const [gen, setGen] = useState(0); // bumps every time our layers are (re)installed
  const [err, setErr] = useState<string | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null);
  const cb = useRef(onSelectRanch);
  cb.current = onSelectRanch;
  const ready = gen > 0;

  const fitStudyArea = (duration = 600) => {
    const m = map.current;
    if (m && aoiBox.current) m.fitBounds(aoiBox.current, { padding: compact ? 16 : 40, duration });
  };

  useEffect(() => {
    if (!el.current) return;
    const m = new maplibregl.Map({ container: el.current, style: BASEMAP, center: [-51.95, -6.65], zoom: compact ? 8.3 : 8.8, attributionControl: false, dragRotate: false });
    map.current = m;
    m.touchZoomRotate.disableRotation();
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    if (!compact) m.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
    m.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: 'INPE PRODES, FUNAI via TerraBrasilis; ranch cells synthetic' }), 'bottom-right');

    let data: Layers | null = null;
    let styled = false;
    let fell = false;
    const fallback = () => {
      if (styled || fell) return;
      fell = true;
      m.setStyle(PLAIN);
    };
    const timer = window.setTimeout(fallback, 8000);
    m.on('error', (e) => {
      const msg = String((e as { error?: { message?: string } }).error?.message ?? '');
      if (!m.isStyleLoaded() && /style|fetch|network|load/i.test(msg)) fallback();
    });

    const install = () => {
      if (!data || m.getSource('ranches')) return;
      const d = data;
      m.addSource('sat', { type: 'raster', tiles: [SATELLITE_TILES], tileSize: 256, attribution: 'Esri World Imagery' });
      m.addLayer({ id: 'sat', type: 'raster', source: 'sat', layout: { visibility: 'none' }, paint: { 'raster-saturation': -0.2 } });
      m.addSource('before', { type: 'geojson', data: d.before });
      m.addLayer({ id: 'cleared2008', type: 'fill', source: 'before', paint: { 'fill-color': DEFOR_COLOR.before2008, 'fill-opacity': 0.5 } });
      m.addSource('ranches', { type: 'geojson', data: d.ranches, promoteId: 'ranch_id' });
      m.addLayer({ id: 'ranches', type: 'fill', source: 'ranches', paint: { 'fill-color': RISK_COLOR.unassessed, 'fill-opacity': 0.3 } });
      m.addSource('prot', { type: 'geojson', data: d.prot });
      m.addLayer({ id: 'indigenous', type: 'fill', source: 'prot', filter: ['==', ['get', 'kind'], 'indigenous'], paint: { 'fill-color': '#b49ae0', 'fill-opacity': 0.1 } });
      m.addLayer({ id: 'conservation', type: 'fill', source: 'prot', filter: ['==', ['get', 'kind'], 'conservation'], paint: { 'fill-color': '#4fbf86', 'fill-opacity': 0.06 } });
      m.addSource('defor', { type: 'geojson', data: d.defor });
      m.addLayer({
        id: 'deforestation', type: 'fill', source: 'defor',
        paint: { 'fill-color': ['case', ['>', ['get', 'year'], 2020], DEFOR_COLOR.post, DEFOR_COLOR.pre], 'fill-opacity': ['case', ['>', ['get', 'year'], 2020], 0.95, 0.7] },
      });
      m.addLayer({
        id: 'ranches-line', type: 'line', source: 'ranches',
        paint: {
          'line-color': ['case', ['boolean', ['feature-state', 'selected'], false], '#ffffff', 'rgba(238,241,236,0.22)'],
          'line-width': ['case', ['boolean', ['feature-state', 'selected'], false], 2.8, ['interpolate', ['linear'], ['zoom'], 8, 0.3, 11, 0.9]],
        },
      });
      m.addLayer({ id: 'indigenous-line', type: 'line', source: 'prot', filter: ['==', ['get', 'kind'], 'indigenous'], paint: { 'line-color': '#b49ae0', 'line-width': 1.8 } });
      m.addLayer({ id: 'conservation-line', type: 'line', source: 'prot', filter: ['==', ['get', 'kind'], 'conservation'], paint: { 'line-color': '#4fbf86', 'line-width': 1.6, 'line-dasharray': [3, 2] } });
      m.addLayer({ id: 'embargo', type: 'line', source: 'ranches', filter: ['==', ['get', 'embargo'], 'active'], paint: { 'line-color': '#e5484d', 'line-width': 2.4, 'line-dasharray': [1.5, 1] } });
      m.addSource('aoi', { type: 'geojson', data: d.aoi });
      m.addLayer({ id: 'aoi', type: 'line', source: 'aoi', paint: { 'line-color': '#eef1ec', 'line-opacity': 0.55, 'line-dasharray': [3, 2], 'line-width': 1.2 } });
      m.addSource('routes', { type: 'geojson', data: EMPTY });
      m.addLayer({
        id: 'routes', type: 'line', source: 'routes', layout: { 'line-cap': 'round' },
        paint: {
          'line-color': ['case', ['get', 'refused'], '#e5484d', '#5aa2f0'],
          'line-width': ['interpolate', ['linear'], ['get', 'head'], 1, 1.2, 500, 5],
          'line-opacity': 0.85,
          'line-dasharray': ['case', ['get', 'refused'], ['literal', [2, 2]], ['literal', [1, 0]]],
        },
      });
      setGen((g) => g + 1);
    };

    m.on('style.load', () => {
      if (!fell) styled = true;
      window.clearTimeout(timer);
      install();
    });

    void Promise.all(['ranch_evidence', 'deforestation', 'cleared_before_2008', 'protected', 'aoi'].map(loadLayer))
      .then(([ranches, defor, before, prot, aoi]) => {
        data = { ranches, defor, before, prot, aoi };
        ranchFc.current = ranches;
        const box = aoi.features[0] ? bboxOf(aoi.features[0].geometry) : null;
        aoiBox.current = box;
        if (box) m.fitBounds(box, { padding: compact ? 16 : 40, duration: 0 });
        if (m.isStyleLoaded()) install();
      })
      .catch((e) => setErr(`Map layers could not be loaded: ${(e as Error).message}`));

    const pick = (e: maplibregl.MapMouseEvent) => (m.getLayer('ranches') ? m.queryRenderedFeatures(e.point, { layers: ['ranches'] })[0] : undefined);
    m.on('click', (e) => {
      const f = pick(e);
      if (f?.properties?.ranch_id) cb.current?.(String(f.properties.ranch_id));
    });
    m.on('mousemove', (e) => {
      const r = m.getLayer('routes') ? m.queryRenderedFeatures(e.point, { layers: ['routes'] })[0] : undefined;
      const f = pick(e);
      m.getCanvas().style.cursor = f && cb.current ? 'pointer' : '';
      if (r) setHover({ x: e.point.x, y: e.point.y, text: `${r.properties?.gta} · ${r.properties?.head} head${r.properties?.date ? ` · ${r.properties.date}` : ''}${r.properties?.refused ? ' · refused by the ledger' : ''}` });
      else if (f) setHover({ x: e.point.x, y: e.point.y, text: `${f.properties?.ranch_id} · ${String(f.properties?.risk_class ?? 'unassessed').replace('_', ' ')} · cleared after 2020: ${f.properties?.post_cutoff_ha ?? '—'} ha` });
      else setHover(null);
    });
    m.on('mouseout', () => setHover(null));
    const ro = new ResizeObserver(() => m.resize());
    ro.observe(el.current);
    return () => {
      window.clearTimeout(timer);
      ro.disconnect();
      m.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compact]);

  // Risk colours: the API's ratings when available, otherwise the class published with the map layer.
  // Clean ranches stay faint so the risky ones read at a glance.
  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    const OPACITY: Record<string, number> = { high: 0.5, watch: 0.26, clean: 0.07, insufficient_data: 0.2, unassessed: 0.15 };
    const byClass = (table: Record<string, string | number>, other: string | number) => [
      'match', ['get', 'risk_class'], 'high', table.high, 'watch', table.watch, 'clean', table.clean, 'insufficient_data', table.insufficient_data, other,
    ];
    const expr = (table: Record<string, string | number>, other: string | number) => {
      if (!Object.keys(riskByRanch).length) return byClass(table, other);
      const e: unknown[] = ['match', ['get', 'ranch_id']];
      for (const [id, cls] of Object.entries(riskByRanch)) e.push(id, table[cls] ?? other);
      e.push(byClass(table, other));
      return e;
    };
    m.setPaintProperty('ranches', 'fill-color', expr(RISK_COLOR, RISK_COLOR.unassessed) as maplibregl.ExpressionSpecification);
    m.setPaintProperty('ranches', 'fill-opacity', ['case', ['boolean', ['feature-state', 'selected'], false], 0.65, expr(OPACITY, OPACITY.unassessed)] as unknown as maplibregl.ExpressionSpecification);
  }, [riskByRanch, gen, ready]);

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
  }, [layers, gen, ready, satellite]);

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
  }, [selected, focus, gen, ready]);

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
  }, [routes, gen, ready]);

  return (
    <div className={`map ${compact ? 'map-compact' : ''}`}>
      <div ref={el} className="map-canvas" role="region" aria-label="Map of ranches and environmental layers" />
      {!compact && ready && (
        <button type="button" className="map-fit" onClick={() => fitStudyArea()}>
          Fit whole area
        </button>
      )}
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
