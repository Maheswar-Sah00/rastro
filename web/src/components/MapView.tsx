import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import maplibregl, { type GeoJSONSource, type MapGeoJSONFeature, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { AreaGeom, DeforProps, Destination, FeatureCollection, ProtectedProps, Ranch } from '../lib/types';
import { fmt, roleLabel } from '../lib/format';
import { MAP_PAL, RISK_COLOR, RISK_LABEL, deforRamp, type MapPal } from '../lib/colors';
import type { Theme } from '../lib/theme';
import { fixName } from '../lib/content';

const FONT = ['Noto Sans Regular'];
const FONT_BOLD = ['Noto Sans Bold'];
const FONT_IT = ['Noto Sans Italic'];
const fallbackStyle = (pal: MapPal): StyleSpecification => ({
  version: 8,
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': pal.bg } }],
});
const EMPTY = { type: 'FeatureCollection' as const, features: [] as never[] };

export interface LayerToggles { defor: boolean; cleared: boolean; protected: boolean; ranches: boolean; flows: boolean; dest: boolean }

export interface MapViewProps {
  ranches: Ranch[] | null;
  defor: FeatureCollection<AreaGeom, DeforProps> | null;
  cleared: FeatureCollection | null;
  protectedAreas: FeatureCollection<AreaGeom, ProtectedProps> | null;
  aoi: FeatureCollection | null;
  destinations: Destination[] | null;
  flows: { type: 'FeatureCollection'; features: unknown[] } | null;
  bbox: [number, number, number, number] | null;
  layers: LayerToggles;
  hiddenClasses: Set<string>;
  minYear: number;
  postOnly: boolean;
  satellite: boolean;
  selected: string | null;
  onSelect: (id: string) => void;
  fitAllKey: number;
  fitAoiKey: number;
  evalMode: boolean;
  theme: Theme;
  /** Story styling: "risk" = strong risk fills; "quiet" = ranches as a faint backdrop for flows. */
  emphasis?: 'none' | 'risk' | 'quiet';
}

type Tip = { x: number; y: number; body: ReactNode } | null;

export default function MapView(p: MapViewProps) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [gen, setGen] = useState(0); // increments every time our layers are (re)installed
  const [tip, setTip] = useState<Tip>(null);
  const [baseNote, setBaseNote] = useState<string | null>(null);
  const propsRef = useRef(p);
  propsRef.current = p;

  const ranchFC = useMemo(() => {
    if (!p.ranches) return null;
    return {
      type: 'FeatureCollection' as const,
      features: p.ranches.map((r, i) => ({
        type: 'Feature' as const,
        id: i,
        properties: { id: r.id, risk_class: r.risk.class, role: r.role },
        geometry: r.geometry,
      })),
    };
  }, [p.ranches]);
  const ranchPts = useMemo(() => {
    if (!p.ranches) return null;
    return {
      type: 'FeatureCollection' as const,
      features: p.ranches.map((r) => ({ type: 'Feature' as const, properties: { id: r.id, risk_class: r.risk.class }, geometry: { type: 'Point' as const, coordinates: r.centroid } })),
    };
  }, [p.ranches]);
  const fidOf = useMemo(() => new Map((p.ranches ?? []).map((r, i) => [r.id, i])), [p.ranches]);
  const ranchById = useMemo(() => new Map((p.ranches ?? []).map((r) => [r.id, r])), [p.ranches]);
  const ranchByIdRef = useRef(ranchById);
  ranchByIdRef.current = ranchById;
  const destFC = useMemo(() => {
    if (!p.destinations) return null;
    return {
      type: 'FeatureCollection' as const,
      features: p.destinations.map((d) => ({
        type: 'Feature' as const,
        properties: { id: d.id, kind: d.kind, name: fixName(d.name), short: shortName(d), municipality: fixName(d.municipality ?? ''), real: d.real ? 1 : 0 },
        geometry: { type: 'Point' as const, coordinates: [d.lon, d.lat] },
      })),
    };
  }, [p.destinations]);

  // ---------------------------------------------------------------- init
  useEffect(() => {
    if (!el.current) return;
    const b = propsRef.current.bbox;
    const map = new maplibregl.Map({
      container: el.current,
      style: MAP_PAL[propsRef.current.theme].style,
      ...(b ? { bounds: b as [number, number, number, number], fitBoundsOptions: { padding: 30 } } : { center: [-51.95, -6.65], zoom: 9 }),
      maxZoom: 16,
      attributionControl: false,
      cooperativeGestures: true,
      dragRotate: false,
      pitchWithRotate: false,
    });
    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric', maxWidth: 110 }), 'bottom-right');
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
    let installed = false;
    const fallback = (why: string) => {
      if (installed) return;
      installed = true;
      setBaseNote(why);
      map.setStyle(fallbackStyle(MAP_PAL[propsRef.current.theme]));
    };
    const timer = window.setTimeout(() => fallback('Basemap tiles unavailable; data layers shown on a plain background.'), 10000);
    const debug = /[?&]debug/.test(window.location.search);
    if (debug) (window as unknown as { __map: unknown }).__map = map;
    map.on('error', (e) => {
      const msg = String((e as { error?: { message?: string } }).error?.message ?? '');
      if (debug) console.warn('[map error]', msg);
      if (!map.isStyleLoaded() && /style|fetch|network|load/i.test(msg)) fallback('Basemap unavailable; data layers shown on a plain background.');
    });
    map.on('style.load', () => {
      installed = true;
      window.clearTimeout(timer);
      install(map, MAP_PAL[propsRef.current.theme], propsRef.current.theme);
      setGen((g) => g + 1);
    });
    mapRef.current = map;
    const ro = new ResizeObserver(() => map.resize());
    ro.observe(el.current);

    // Interaction
    let hoverFid: number | null = null;
    const setHover = (fid: number | null) => {
      if (hoverFid === fid) return;
      if (hoverFid != null && map.getSource('ranches')) map.setFeatureState({ source: 'ranches', id: hoverFid }, { hover: false });
      hoverFid = fid;
      if (fid != null && map.getSource('ranches')) map.setFeatureState({ source: 'ranches', id: fid }, { hover: true });
    };
    const LAYERS = ['dest-circle', 'flow-rejected', 'flow-line', 'ranch-fill', 'defor-fill', 'protected-fill'];
    const pickAt = (pt: maplibregl.PointLike) => {
      const layers = LAYERS.filter((l) => map.getLayer(l));
      if (!layers.length) return [] as MapGeoJSONFeature[];
      return map.queryRenderedFeatures(pt, { layers });
    };
    let raf = 0;
    map.on('mousemove', (e) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const feats = pickAt(e.point);
        const by = (id: string) => feats.find((f) => f.layer.id === id);
        const dest = by('dest-circle');
        const flow = by('flow-rejected') ?? by('flow-line');
        const ranch = by('ranch-fill');
        const defor = by('defor-fill');
        const prot = by('protected-fill');
        setHover(ranch && !dest && !flow ? (ranch.id as number) : null);
        map.getCanvas().style.cursor = ranch && !dest && !flow ? 'pointer' : '';
        const rb = ranchByIdRef.current;
        const body = dest ? destTip(dest) : flow ? flowTip(flow, rb) : ranch ? ranchTip(String(ranch.properties.id), rb, defor, prot, propsRef.current.evalMode) : defor ? deforTip(defor, prot) : prot ? protTip(prot) : null;
        setTip(body ? { x: e.point.x, y: e.point.y, body } : null);
      });
    });
    map.on('mouseout', () => {
      setHover(null);
      setTip(null);
    });
    map.on('click', (e) => {
      const feats = pickAt(e.point);
      const ranch = feats.find((f) => f.layer.id === 'ranch-fill');
      const flow = feats.find((f) => f.layer.id === 'flow-line' || f.layer.id === 'flow-rejected');
      if (ranch) propsRef.current.onSelect(String(ranch.properties.id));
      else if (flow) {
        const from = String(flow.properties.from);
        if (ranchByIdRef.current.has(from)) propsRef.current.onSelect(from);
      }
    });

    return () => {
      window.clearTimeout(timer);
      cancelAnimationFrame(raf);
      ro.disconnect();
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Theme switch: swap the basemap; style.load re-installs our layers in the new palette.
  const shownTheme = useRef(p.theme);
  useEffect(() => {
    const m = mapRef.current;
    if (!m || shownTheme.current === p.theme) return;
    shownTheme.current = p.theme;
    m.setStyle(MAP_PAL[p.theme].style);
  }, [p.theme]);

  // ---------------------------------------------------------------- data sync
  const setData = (id: string, data: unknown) => {
    const src = mapRef.current?.getSource(id) as GeoJSONSource | undefined;
    if (src) src.setData((data ?? EMPTY) as never);
  };
  useEffect(() => { if (gen) setData('ranches', ranchFC); }, [gen, ranchFC]);
  useEffect(() => { if (gen) setData('ranch-pts', ranchPts); }, [gen, ranchPts]);
  useEffect(() => { if (gen) setData('defor', p.defor); }, [gen, p.defor]);
  useEffect(() => { if (gen) setData('cleared', p.cleared); }, [gen, p.cleared]);
  useEffect(() => { if (gen) setData('protected', p.protectedAreas); }, [gen, p.protectedAreas]);
  useEffect(() => { if (gen) setData('aoi', p.aoi); }, [gen, p.aoi]);
  useEffect(() => { if (gen) setData('dest', destFC); }, [gen, destFC]);
  useEffect(() => { if (gen) setData('flows', p.flows); }, [gen, p.flows]);

  // Fit to the study area once the bbox is known.
  const fitted = useRef(false);
  useEffect(() => {
    const m = mapRef.current;
    if (!m || !gen || !p.bbox || fitted.current) return;
    fitted.current = true;
    m.fitBounds(p.bbox, { padding: 30, duration: 0 });
  }, [gen, p.bbox]);
  useEffect(() => {
    const m = mapRef.current;
    if (!m || !p.fitAllKey) return;
    const pts: [number, number][] = (p.destinations ?? []).map((d) => [d.lon, d.lat]);
    if (p.bbox) pts.push([p.bbox[0], p.bbox[1]], [p.bbox[2], p.bbox[3]]);
    if (!pts.length) return;
    const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
    m.fitBounds([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], { padding: 50, duration: 900 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.fitAllKey]);
  useEffect(() => {
    const m = mapRef.current;
    if (!m || !p.fitAoiKey || !p.bbox) return;
    m.fitBounds(p.bbox, { padding: 30, duration: 900 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.fitAoiKey]);

  // ---------------------------------------------------------------- visibility + filters
  useEffect(() => {
    const m = mapRef.current;
    if (!m || !gen) return;
    const vis = (ids: string[], on: boolean) => ids.forEach((id) => m.getLayer(id) && m.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'));
    vis(['defor-fill'], p.layers.defor);
    vis(['cleared-fill'], p.layers.cleared);
    vis(['protected-fill', 'protected-line', 'protected-label'], p.layers.protected);
    vis(['ranch-fill', 'ranch-line', 'ranch-label'], p.layers.ranches);
    vis(['flow-line', 'flow-rejected', 'flow-arrow'], p.layers.flows);
    vis(['dest-circle', 'dest-label'], p.layers.dest);
    vis(['sat'], p.satellite);
  }, [gen, p.layers, p.satellite]);

  useEffect(() => {
    const m = mapRef.current;
    if (!m || !gen) return;
    const shown = ['clean', 'watch', 'high'].filter((c) => !p.hiddenClasses.has(c));
    const f = ['in', ['get', 'risk_class'], ['literal', shown]] as never;
    ['ranch-fill', 'ranch-line', 'ranch-label'].forEach((id) => m.getLayer(id) && m.setFilter(id, f));
  }, [gen, p.hiddenClasses]);

  useEffect(() => {
    const m = mapRef.current;
    if (!m || !gen || !m.getLayer('defor-fill')) return;
    const minY = p.postOnly ? Math.max(2021, p.minYear) : p.minYear;
    m.setFilter('defor-fill', ['>=', ['get', 'year'], minY] as never);
  }, [gen, p.minYear, p.postOnly]);

  useEffect(() => {
    const m = mapRef.current;
    if (!m || !gen) return;
    const sat = p.satellite;
    const base = p.emphasis === 'risk' ? ['match', ['get', 'risk_class'], 'high', 0.62, 'watch', 0.34, 0.07] : p.emphasis === 'quiet' ? 0.04 : sat ? 0.08 : 0.11;
    if (m.getLayer('ranch-fill')) m.setPaintProperty('ranch-fill', 'fill-opacity', ['case', ['boolean', ['feature-state', 'selected'], false], 0.7, ['boolean', ['feature-state', 'hover'], false], 0.45, base] as never);
    if (m.getLayer('ranch-line')) m.setPaintProperty('ranch-line', 'line-opacity', (p.emphasis === 'risk' ? ['match', ['get', 'risk_class'], 'clean', 0.25, 0.9] : p.emphasis === 'quiet' ? 0.12 : 0.9) as never);
    if (m.getLayer('cleared-fill')) m.setPaintProperty('cleared-fill', 'fill-opacity', sat ? 0.15 : 0.5);
    if (m.getLayer('ranch-label')) m.setPaintProperty('ranch-label', 'text-halo-color', sat ? 'rgba(0,0,0,0.75)' : MAP_PAL[p.theme].halo);
    if (m.getLayer('ranch-label')) m.setPaintProperty('ranch-label', 'text-color', sat ? '#ffffff' : MAP_PAL[p.theme].text);
  }, [gen, p.satellite, p.theme, p.emphasis]);

  // ---------------------------------------------------------------- selection
  const prevSel = useRef<number | null>(null);
  useEffect(() => {
    const m = mapRef.current;
    if (!m || !gen || !m.getSource('ranches')) return;
    if (prevSel.current != null) m.setFeatureState({ source: 'ranches', id: prevSel.current }, { selected: false });
    const fid = p.selected != null ? fidOf.get(p.selected) : undefined;
    prevSel.current = fid ?? null;
    if (fid != null) m.setFeatureState({ source: 'ranches', id: fid }, { selected: true });
    const sel = p.selected ?? '';
    if (m.getLayer('flow-line')) {
      m.setPaintProperty(
        'flow-line',
        'line-opacity',
        (sel
          ? ['case', ['any', ['==', ['get', 'from'], sel], ['==', ['get', 'to'], sel]], 0.95, 0.1]
          : ['case', ['==', ['get', 'susp'], 1], 0.7, 0.3]) as never,
      );
      m.setPaintProperty('flow-arrow', 'icon-opacity', (sel ? ['case', ['any', ['==', ['get', 'from'], sel], ['==', ['get', 'to'], sel]], 1, 0.08] : 0.85) as never);
    }
    const r = p.selected ? ranchById.get(p.selected) : null;
    if (r && el.current) {
      const rect = el.current.getBoundingClientRect();
      const drawerW = Math.min(500, window.innerWidth);
      const overlap = Math.max(0, rect.right - (window.innerWidth - drawerW));
      const right = window.innerWidth > 900 ? Math.min(rect.width * 0.6, overlap + 40) : 40;
      const bounds = m.getBounds();
      const inView = bounds.contains([r.bbox[0], r.bbox[1]]) && bounds.contains([r.bbox[2], r.bbox[3]]);
      if (!inView || m.getZoom() < 10) m.fitBounds(r.bbox, { padding: { top: 80, bottom: 80, left: 80, right }, maxZoom: 11.2, duration: 900 });
    }
  }, [gen, p.selected, fidOf, ranchById]);

  return (
    <>
      <div ref={el} className="map-canvas" aria-label="Map of ranches, deforestation and cattle flows" />
      {tip && (
        <div className="map-tooltip" style={{ left: tip.x, top: tip.y }}>
          {tip.body}
        </div>
      )}
      {baseNote && (
        <div className="map-overlay bl float small" style={{ padding: '6px 10px', bottom: 120 }}>
          {baseNote}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- layer installation
function install(map: maplibregl.Map, pal: MapPal, theme: Theme) {
  addImages(map, pal);
  const ramp = deforRamp(theme);
  const src = (id: string) => {
    if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: EMPTY as never, ...(id === 'flows' ? { lineMetrics: false } : {}) });
  };
  if (!map.getSource('esri')) {
    map.addSource('esri', {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      maxzoom: 18,
      attribution: 'Imagery © <a href="https://www.esri.com" target="_blank" rel="noreferrer">Esri</a>, Maxar, Earthstar Geographics, and the GIS User Community',
    });
  }
  ['cleared', 'protected', 'ranches', 'ranch-pts', 'defor', 'aoi', 'flows', 'dest'].forEach(src);

  const add = (layer: maplibregl.LayerSpecification) => {
    if (!map.getLayer(layer.id)) map.addLayer(layer);
  };
  add({ id: 'sat', type: 'raster', source: 'esri', layout: { visibility: 'none' }, paint: { 'raster-saturation': -0.15, 'raster-contrast': 0.05 } });
  add({ id: 'cleared-fill', type: 'fill', source: 'cleared', paint: { 'fill-color': pal.cleared, 'fill-opacity': 0.55 } });
  add({
    id: 'protected-fill', type: 'fill', source: 'protected',
    paint: { 'fill-pattern': ['match', ['get', 'kind'], 'indigenous', 'hatch-ind', 'hatch-con'] as never, 'fill-opacity': 0.9 },
  });
  add({
    id: 'ranch-fill', type: 'fill', source: 'ranches',
    paint: {
      'fill-color': ['match', ['get', 'risk_class'], 'high', RISK_COLOR.high, 'watch', RISK_COLOR.watch, RISK_COLOR.clean] as never,
      'fill-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 0.42, ['boolean', ['feature-state', 'hover'], false], 0.3, 0.11] as never,
    },
  });
  add({
    id: 'defor-fill', type: 'fill', source: 'defor',
    paint: {
      'fill-color': [
        'case', ['>', ['get', 'year'], 2020],
        ['interpolate', ['linear'], ['get', 'year'], ...ramp.post.flat()],
        ['interpolate', ['linear'], ['get', 'year'], ...ramp.pre.flat()],
      ] as never,
      'fill-opacity': 0.92,
      'fill-outline-color': ['case', ['>', ['get', 'year'], 2020], pal.postOutline, 'rgba(0,0,0,0)'] as never,
    },
  });
  add({
    id: 'protected-line', type: 'line', source: 'protected',
    paint: { 'line-color': ['match', ['get', 'kind'], 'indigenous', pal.indigenous, pal.conservation] as never, 'line-width': 1.8, 'line-dasharray': [3, 1.5] },
  });
  add({
    id: 'ranch-line', type: 'line', source: 'ranches',
    paint: {
      'line-color': ['match', ['get', 'risk_class'], 'high', RISK_COLOR.high, 'watch', RISK_COLOR.watch, RISK_COLOR.clean] as never,
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, ['case', ['boolean', ['feature-state', 'selected'], false], 3, ['boolean', ['feature-state', 'hover'], false], 2, 0.5], 11, ['case', ['boolean', ['feature-state', 'selected'], false], 3.6, ['boolean', ['feature-state', 'hover'], false], 2.4, 1.2]] as never,
      'line-opacity': 0.9,
    },
  });
  add({ id: 'aoi-line', type: 'line', source: 'aoi', paint: { 'line-color': pal.aoi, 'line-width': 1.2, 'line-dasharray': [4, 3], 'line-opacity': 0.5 } });
  add({
    id: 'flow-line', type: 'line', source: 'flows', filter: ['==', ['get', 'rejected'], 0] as never,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['case', ['==', ['get', 'susp'], 1], pal.susp, pal.flow] as never,
      'line-width': ['interpolate', ['linear'], ['get', 'head'], 0, 0.5, 300, 1.2, 2000, 3, 8000, 6, 30000, 11] as never,
      'line-opacity': ['case', ['==', ['get', 'susp'], 1], 0.7, 0.3] as never,
    },
  });
  add({
    id: 'flow-rejected', type: 'line', source: 'flows', filter: ['==', ['get', 'rejected'], 1] as never,
    layout: { 'line-cap': 'butt' },
    paint: { 'line-color': pal.susp, 'line-width': 1.8, 'line-dasharray': [2, 1.6], 'line-opacity': 0.95 },
  });
  add({
    id: 'flow-arrow', type: 'symbol', source: 'flows', filter: ['<', ['get', 'rank'], 180] as never,
    layout: {
      'symbol-placement': 'line', 'symbol-spacing': 110, 'icon-image': 'chev', 'icon-size': ['interpolate', ['linear'], ['get', 'head'], 0, 0.45, 3000, 0.7, 20000, 1] as never,
      'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-rotation-alignment': 'map', 'icon-keep-upright': false,
    },
    paint: { 'icon-color': ['case', ['any', ['==', ['get', 'susp'], 1], ['==', ['get', 'rejected'], 1]], pal.arrowSusp, pal.arrow] as never, 'icon-opacity': 0.85 },
  });
  add({
    id: 'protected-label', type: 'symbol', source: 'protected',
    layout: { 'text-field': ['get', 'name'] as never, 'text-font': FONT_IT, 'text-size': 12.5, 'text-max-width': 10, 'symbol-placement': 'point' },
    paint: { 'text-color': ['match', ['get', 'kind'], 'indigenous', pal.indText, pal.conText] as never, 'text-halo-color': pal.halo, 'text-halo-width': 1.4 },
  });
  add({
    id: 'ranch-label', type: 'symbol', source: 'ranch-pts', minzoom: 10.6,
    layout: { 'text-field': ['get', 'id'] as never, 'text-font': FONT, 'text-size': 11, 'text-allow-overlap': false },
    paint: { 'text-color': pal.text, 'text-halo-color': pal.halo, 'text-halo-width': 1.3 },
  });
  add({
    id: 'dest-circle', type: 'circle', source: 'dest',
    paint: {
      'circle-radius': ['match', ['get', 'kind'], 'port', 9, 6.5] as never,
      'circle-color': ['match', ['get', 'kind'], 'port', pal.port, pal.dest] as never,
      'circle-stroke-color': pal.destStroke, 'circle-stroke-width': 2.2,
    },
  });
  add({
    id: 'dest-label', type: 'symbol', source: 'dest',
    layout: {
      'text-field': ['get', 'short'] as never, 'text-font': FONT_BOLD, 'text-size': 11.5, 'text-variable-anchor': ['left', 'right', 'top', 'bottom'],
      'text-radial-offset': 0.95, 'text-justify': 'auto', 'text-max-width': 12,
    },
    paint: { 'text-color': pal.text, 'text-halo-color': pal.halo, 'text-halo-width': 1.6 },
  });
}

function addImages(map: maplibregl.Map, pal: MapPal) {
  const hatch = (rgb: [number, number, number], alpha: number) => {
    const size = 10;
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const on = (x + y) % size < 2;
        const i = (y * size + x) * 4;
        data[i] = rgb[0];
        data[i + 1] = rgb[1];
        data[i + 2] = rgb[2];
        data[i + 3] = on ? 220 : alpha;
      }
    return { width: size, height: size, data };
  };
  if (!map.hasImage('hatch-ind')) map.addImage('hatch-ind', hatch([pal.hatchInd[0], pal.hatchInd[1], pal.hatchInd[2]], pal.hatchInd[3]));
  if (!map.hasImage('hatch-con')) map.addImage('hatch-con', hatch([pal.hatchCon[0], pal.hatchCon[1], pal.hatchCon[2]], pal.hatchCon[3]));
  if (!map.hasImage('chev')) {
    const s = 24;
    const c = document.createElement('canvas');
    c.width = s;
    c.height = s;
    const ctx = c.getContext('2d');
    if (ctx) {
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 3.4;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(8, 5);
      ctx.lineTo(16, 12);
      ctx.lineTo(8, 19);
      ctx.stroke();
      const img = ctx.getImageData(0, 0, s, s);
      map.addImage('chev', { width: s, height: s, data: new Uint8Array(img.data.buffer) }, { sdf: true, pixelRatio: 2 });
    }
  }
}

// ---------------------------------------------------------------- tooltips
function shortName(d: Destination) {
  if (d.kind === 'port') return fixName(d.name);
  return fixName(d.name).replace(/\s*\(.*\)\s*$/, '');
}
function destTip(f: MapGeoJSONFeature) {
  const p = f.properties as Record<string, string | number>;
  return (
    <>
      <b>{String(p.name)}</b>
      <div className="t-sub">{p.kind === 'port' ? 'Live-cattle export port' : 'Slaughterhouse'} · {String(p.municipality)}</div>
      <div className="t-sub">{Number(p.real) ? 'Real location; flows are synthetic' : 'Mock location'}</div>
    </>
  );
}
function flowTip(f: MapGeoJSONFeature, ranchById: Map<string, Ranch>) {
  const p = f.properties as Record<string, string | number>;
  const fromR = ranchById.get(String(p.from));
  return (
    <>
      <b>
        {String(p.from)} → {String(p.to).replace(/^S:|^P:/, '')}
      </b>
      <div>
        {fmt(Number(p.head))} head in {fmt(Number(p.n))} permit{Number(p.n) === 1 ? '' : 's'}
      </div>
      {Number(p.rejected) ? (
        <div style={{ color: '#ff8a80' }}>Refused by the ledger</div>
      ) : Number(p.susp) ? (
        <div style={{ color: '#ff8a80' }}>Suspicious: {fmt((Number(p.susp_head) / Number(p.head)) * 100)}% of head flagged</div>
      ) : null}
      {fromR && <div className="t-sub">From a {String(fromR.role)} rated {RISK_LABEL[fromR.risk.class].toLowerCase()}</div>}
    </>
  );
}
function ranchTip(id: string, ranchById: Map<string, Ranch>, defor?: MapGeoJSONFeature, prot?: MapGeoJSONFeature, evalMode?: boolean) {
  const r = ranchById.get(id);
  if (!r) return <b>{id}</b>;
  return (
    <>
      <b>
        {r.id} · {RISK_LABEL[r.risk.class]}
      </b>
      <div className="t-sub">{roleLabel(String(r.role))} · synthetic boundary</div>
      <div>
        Herd {fmt(r.head_now)} / capacity {fmt(r.capacity_head)}
      </div>
      {r.risk.flags.length > 0 && <div>{r.risk.flags.length} flag{r.risk.flags.length > 1 ? 's' : ''}: {r.risk.flags.slice(0, 2).map((f) => f.code.replace(/_/g, ' ').toLowerCase()).join(', ')}</div>}
      {defor && <div className="t-sub">Under cursor: PRODES clearing {String(defor.properties.year)}, {fmt(Number(defor.properties.area_ha), 1)} ha</div>}
      {prot && <div className="t-sub">Inside {fixName(String(prot.properties.name))}</div>}
      {evalMode && r.truth && <div style={{ color: '#ffd27a' }}>Ground truth: {r.truth}</div>}
      <div className="t-sub">Click for details</div>
    </>
  );
}
function deforTip(f: MapGeoJSONFeature, prot?: MapGeoJSONFeature) {
  const y = Number(f.properties.year);
  return (
    <>
      <b>Cleared in {y}</b> <span className="t-sub">(PRODES year)</span>
      <div>{fmt(Number(f.properties.area_ha), 1)} ha</div>
      <div style={{ color: y > 2020 ? '#ff9ec4' : '#d9cdb2' }}>{y > 2020 ? 'After the EUDR cut-off' : 'Before the EUDR cut-off'}</div>
      {prot && <div className="t-sub">Inside {fixName(String(prot.properties.name))}</div>}
    </>
  );
}
function protTip(f: MapGeoJSONFeature) {
  return (
    <>
      <b>{fixName(String(f.properties.name))}</b>
      <div className="t-sub">{f.properties.kind === 'indigenous' ? 'Indigenous land' : 'Conservation unit'}</div>
    </>
  );
}
