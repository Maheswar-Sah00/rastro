import type { Theme } from './theme';

// JS-side palette (mirrors CSS tokens). Risk colours are validated for CVD
// separation and always appear with a text label.
export const RISK_COLOR: Record<string, string> = {
  clean: '#0ca30c',
  watch: '#fab219',
  high: '#e5484d',
  unknown: '#6d746e',
  other: '#5a615b',
  shipment: '#eef1ec',
};
export const RISK_LABEL: Record<string, string> = {
  clean: 'Clean',
  watch: 'Watch',
  high: 'High risk',
  unknown: 'Unknown',
  other: 'Other',
};
export const TRACE_LABEL: Record<string, string> = { clean: 'Clean', watch: 'Watch (post-2020 clearing)', high: 'Flagged', unknown: 'Unknown origin' };

// Deforestation by PRODES year: soil browns up to the EUDR cut-off, magenta after.
// The ramps are stepped per theme so old clearings stay visible on either background.
type Ramp = [number, string][];
const DEFOR: Record<Theme, { pre: Ramp; post: Ramp }> = {
  dark: {
    pre: [[2008, '#4d4030'], [2014, '#7a6244'], [2020, '#a8865a']],
    post: [[2021, '#ff8fbf'], [2023, '#e8508f'], [2025, '#c02a68']],
  },
  light: {
    pre: [[2008, '#e7d6b5'], [2014, '#cfb187'], [2020, '#a87b52']],
    post: [[2021, '#ec6a9c'], [2023, '#d0306f'], [2025, '#92104a']],
  },
};
export const deforRamp = (t: Theme) => DEFOR[t];

export function deforColor(year: number, theme: Theme = 'dark'): string {
  const ramp = year > 2020 ? DEFOR[theme].post : DEFOR[theme].pre;
  if (year <= ramp[0][0]) return ramp[0][1];
  for (let i = 1; i < ramp.length; i++) {
    if (year <= ramp[i][0]) {
      const [y0, c0] = ramp[i - 1];
      const [y1, c1] = ramp[i];
      return mix(c0, c1, (year - y0) / (y1 - y0));
    }
  }
  return ramp[ramp.length - 1][1];
}

type RGBA = [number, number, number, number];

/** Map chrome per theme: basemap, context layers, flows, labels. */
export const MAP_PAL = {
  dark: {
    style: 'https://tiles.openfreemap.org/styles/dark',
    bg: '#121614', cleared: '#4a4436', postOutline: 'rgba(255,170,205,0.7)',
    indigenous: '#b49ae0', conservation: '#4fbf86', indText: '#cdbcf2', conText: '#86dcaf',
    hatchInd: [180, 154, 224, 30] as RGBA, hatchCon: [79, 191, 134, 26] as RGBA,
    aoi: '#eef1ec', flow: '#66736b', susp: '#e5484d', arrow: '#8a928b', arrowSusp: '#ff6b6b',
    text: '#eef1ec', halo: 'rgba(12,15,13,0.92)', port: '#3987e5', dest: '#eef1ec', destStroke: '#0c0f0d',
  },
  light: {
    style: 'https://tiles.openfreemap.org/styles/positron',
    bg: '#ece6d9', cleared: '#d9cdb2', postOutline: '#7a0d3d',
    indigenous: '#6b4a8c', conservation: '#2b6a4c', indText: '#4f3570', conText: '#1f5039',
    hatchInd: [107, 74, 140, 26] as RGBA, hatchCon: [43, 106, 76, 22] as RGBA,
    aoi: '#17231d', flow: '#56635b', susp: '#c62828', arrow: '#2a362f', arrowSusp: '#a31f1f',
    text: '#17231d', halo: 'rgba(255,253,248,0.95)', port: '#2a78d6', dest: '#17231d', destStroke: '#ffffff',
  },
};
export type MapPal = (typeof MAP_PAL)['dark'];

function mix(a: string, b: string, t: number) {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return '#' + pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, '0')).join('');
}
