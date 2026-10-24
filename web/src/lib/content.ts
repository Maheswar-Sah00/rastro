// Editorial copy with sources. Real-world facts only; synthetic numbers come from metrics.json.

export interface SourceLink { label: string; url: string }

export const CONTEXT_STATS: { value: string; text: string; sources: SourceLink[] }[] = [
  {
    value: '2030',
    text: 'Pará pushed mandatory ear-tagging of every animal back five years, from 2026 to 2030. Until then, cattle move as batches on paper permits.',
    sources: [{ label: 'Mighty Earth, Dec 2025', url: 'https://mightyearth.org/article/delay-to-cattle-traceability-in-brazils-para-state-poses-major-threat-to-amazon/' }],
  },
  {
    value: '30 Dec 2026',
    text: 'The EU Deforestation Regulation applies to beef: no animal may have been kept on land cleared after 31 Dec 2020.',
    sources: [
      { label: 'Regulation (EU) 2025/2650', url: 'https://eur-lex.europa.eu/eli/reg/2025/2650/oj' },
      { label: 'European Commission', url: 'https://environment.ec.europa.eu/topics/forests/deforestation/regulation-deforestation-free-products_en' },
    ],
  },
  {
    value: '64.5%',
    text: "of Brazil's live-cattle exports left from Pará in Jan–Jul 2025 (about 55% over the year), mostly to Egypt, Iraq and Lebanon. Türkiye is Brazil's largest live-cattle buyer overall.",
    sources: [
      { label: 'Agência Pará, Aug 2025', url: 'https://agenciapara.com.br/news/70079/assessorias' },
      { label: 'Compre Rural (Agrifatto), 2025', url: 'https://comprerural.com/exportacao-de-gado-vivo-do-brasil-superam-105-milhao-de-bovinos-em-2025-um-recorde-historico/' },
      { label: 'Türkiye, 2024', url: 'https://comprerural.com/brasil-envia-quase-22-000-bovinos-em-retomada-da-exportacao-de-gado-vivo-para-o-gigante-turco/' },
    ],
  },
];

export const GTA_COURT: SourceLink[] = [
  { label: 'MPF/PA, 10 Oct 2025', url: 'https://www.mpf.mp.br/o-mpf/unidades/pr-pa/noticias/a-pedido-do-mpf-justica-sentencia-governo-do-para-a-publicar-dados-de-transparencia-da-pecuaria' },
  { label: 'on the earlier injunction', url: 'https://www.mpf.mp.br/o-mpf/unidades/pr-pa/noticias/mpf-recorre-para-que-governo-do-para-volte-a-ser-obrigado-a-publicar-dados-de-transparencia-da-pecuaria' },
];

export const BASEMAP_SOURCES = [
  { name: 'OpenFreeMap vector tiles (OpenMapTiles schema)', url: 'https://openfreemap.org', license: '© OpenMapTiles, data © OpenStreetMap contributors (ODbL)' },
  { name: 'Esri World Imagery (satellite toggle)', url: 'https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9', license: 'Esri, Maxar, Earthstar Geographics and the GIS User Community; Esri terms of use' },
];

export const TEAM = {
  name: 'Team Rastro',
  repo: 'https://github.com/',
  video: '',
  members: ['Team member 1', 'Team member 2', 'Team member 3'],
};

/** Display repair for place names that lost their accents upstream. */
export function fixName(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .replace(/^Rea De Proteo Ambiental/i, 'Área de Proteção Ambiental')
    .replace(/\bTriunfo Do Xingu\b/g, 'Triunfo do Xingu')
    .replace(/\bSao Felix Do Xingu\b/g, 'São Félix do Xingu')
    .replace(/\bTucuma\b/g, 'Tucumã')
    .replace(/\bAgua Azul Do Norte\b/g, 'Água Azul do Norte');
}
