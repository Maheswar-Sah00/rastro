// Graph-building and aggregation helpers, checked against responses captured from the live API
// (src/console/fixtures) for SHP-D-001239 and SHP-D-001677: multi-hop, overlapping categories,
// unknown origin.
import { describe, expect, it } from 'vitest';
import type { GraphEdge, GraphNode, Item, LineageGraph, LineageReport, ShipmentDetail, ShipmentRiskDetail } from '../api/types';
import { fixtureKey } from '../api/client';
import { fromApi, graphChecks, highlightPaths, isUnknownNode, kindOf, layout, type DrawNode } from './graph';
import { resolveSearch } from './ids';
import { ha, num, pct } from './format';

const all = import.meta.glob('../fixtures/*.json', { eager: true }) as Record<string, { default: unknown }>;
function fx<T>(path: string): T {
  const m = all[`../fixtures/${fixtureKey('GET', path)}.json`];
  if (!m) throw new Error(`missing fixture ${path}`);
  return m.default as T;
}

const IDS = ['SHP-D-001239', 'SHP-D-001677'];

describe.each(IDS)('%s graph', (id) => {
  const g = fx<Item<LineageGraph>>(`/api/v1/shipments/${id}/lineage/graph?max_nodes=40`).data;
  const risk = fx<Item<ShipmentRiskDetail>>(`/api/v1/shipments/${id}/risk`).data;
  const report = fx<LineageReport>(`/api/v1/shipments/${id}/lineage/report?format=json`);
  const detail = fx<Item<ShipmentDetail>>(`/api/v1/shipments/${id}`).data;
  const d = fromApi(g);

  it('keeps every API node and edge, with the API quantities', () => {
    expect(d.nodes).toHaveLength(g.nodes.length);
    expect(d.edges).toHaveLength(g.edges.length);
    for (const n of g.nodes) {
      const x = d.nodes.find((y) => y.id === n.id)!;
      expect(x.head).toBe(n.head_fifo);
      expect(x.headProRata).toBe(n.head_pro_rata);
      expect(x.share_pct).toBe(n.share_pct);
    }
    expect(d.edges.reduce((s, e) => s + e.head, 0)).toBeCloseTo(g.edges.reduce((s, e) => s + e.attributed_head, 0), 6);
  });

  it('graph totals agree with the API totals and the declared head', () => {
    const c = graphChecks(g);
    expect(c.originsMatchApi).toBe(true);
    expect(c.destinationMatchesDeclared).toBe(true);
    expect(c.declared).toBe(detail.shipment.declared_head_count);
  });

  it('puts origins left of the destination and the destination last', () => {
    const dest = d.nodes.find((n) => n.kind === 'destination')!;
    expect(dest.id).toBe(g.destination);
    expect(dest.layer).toBe(d.layers - 1);
    for (const e of d.edges.filter((x) => !x.back)) {
      const s = d.nodes.find((n) => n.id === e.source)!;
      const t = d.nodes.find((n) => n.id === e.target)!;
      expect(s.layer).toBeLessThan(t.layer);
    }
  });

  it('shows unknown origin explicitly', () => {
    const unknown = d.nodes.filter(isUnknownNode);
    expect(unknown.length).toBeGreaterThan(0);
    const u = risk.breakdown.categories.unknown_origin;
    expect(u.head).toBeGreaterThan(0);
    expect(unknown.reduce((s, n) => s + n.head, 0)).toBeCloseTo(u.head, 3);
  });

  it('breakdown: bars overlap, the unique total does not double count', () => {
    const b = risk.breakdown;
    const sum = Object.values(b.categories).reduce((s, c) => s + c.pct, 0);
    expect(sum).toBeCloseTo(b.sum_of_category_pct, 2);
    expect(b.sum_of_category_pct).toBeGreaterThan(b.unique_affected_pct); // overlapping categories
    expect(b.unique_affected_pct).toBeLessThanOrEqual(100.0001);
    const multi = g.nodes.filter((n) => n.categories.filter((c) => c !== 'unknown_origin').length >= 2);
    expect(multi.length).toBeGreaterThan(0);
  });

  it('the downloaded JSON report agrees with the graph and risk responses', () => {
    expect(report.shipment_id).toBe(id);
    expect(report.declared_head).toBe(g.declared_head);
    expect(report.breakdown).toEqual(risk.breakdown);
    expect(report.outcome).toBe(detail.decision?.outcome ?? null);
    expect(report.coverage_pct).toBe(detail.lineage?.coverage_pct);
    const sources = report.sources as { node: string; head_fifo: number; head_pro_rata: number; share_pct: number }[];
    expect(sources.reduce((s, x) => s + x.head_fifo, 0)).toBeCloseTo(g.declared_head, 1);
    // every origin in the report is the same node, with the same numbers, in the graph
    for (const s of sources) {
      const n = g.nodes.find((x) => x.id === s.node);
      expect(n, s.node).toBeDefined();
      expect(n!.head_fifo).toBeCloseTo(s.head_fifo, 3);
      expect(n!.head_pro_rata).toBeCloseTo(s.head_pro_rata, 3);
      expect(n!.share_pct).toBeCloseTo(s.share_pct, 3);
    }
  });

  it('highlighting a category lights only paths downstream of nodes in it', () => {
    const lit = highlightPaths(d, 'post_cutoff_deforestation');
    expect(lit.size).toBeGreaterThan(0);
    const marked = new Set(d.nodes.filter((n) => n.categories.includes('post_cutoff_deforestation')).map((n) => n.id));
    // every lit edge either leaves a marked node or continues a lit edge
    const reach = new Set(marked);
    let grew = true;
    while (grew) {
      grew = false;
      for (const e of lit) if (reach.has(e.source) && !reach.has(e.target)) (reach.add(e.target), (grew = true));
    }
    for (const e of lit) expect(reach.has(e.source)).toBe(true);
    expect(highlightPaths(d, null).size).toBe(0);
  });
});

describe('layout', () => {
  const node = (id: string, roles: string[], kind: GraphNode['kind'] = 'ranch'): DrawNode => ({
    id, kind: kindOf({ id, kind, roles } as GraphNode), label: id, ranch_id: id, roles, head: 0, headProRata: 0, share_pct: 0, categories: [], finding_ids: [],
    data_status: 'synthetic', members: [], layer: 0, inHead: 0, outHead: 0,
  });
  const edge = (a: string, b: string, head: number) =>
    ({ source: a, target: b, head, permit_head: head, gta_id: null, date: null, gta_count: null, kind: 'gta' as GraphEdge['kind'] });

  it('breaks cycles without losing nodes and reports them', () => {
    const g = layout(
      [node('A', ['source']), node('B', ['intermediary']), node('C', ['direct_supplier']), node('S', ['destination'], 'sink')],
      [edge('A', 'B', 10), edge('B', 'C', 10), edge('C', 'B', 4), edge('C', 'S', 10)],
    );
    expect(g.nodes).toHaveLength(4);
    expect(g.removedBackEdges).toBe(1);
    expect(g.nodes.find((n) => n.id === 'S')!.layer).toBe(g.layers - 1);
  });

  it('drops self loops and edges to unknown nodes', () => {
    const g = layout([node('A', ['source']), node('S', [], 'sink')], [edge('A', 'A', 3), edge('A', 'Z', 3), edge('A', 'S', 3)]);
    expect(g.edges).toHaveLength(1);
  });
});

describe('ids and formatting', () => {
  it('routes search text to the right page', () => {
    expect(resolveSearch('r0120')).toEqual({ page: 'ranches', id: 'R0120', label: 'Ranch' });
    expect(resolveSearch('120')?.id).toBe('R0120');
    expect(resolveSearch('gta-pa-2024-004256')?.page).toBe('gtas');
    expect(resolveSearch('LOT-GTA-PA-2024-004256')?.page).toBe('lots');
    expect(resolveSearch('shp-d-001239')?.page).toBe('shipments');
    expect(resolveSearch('0x' + 'ab'.repeat(32))?.page).toBe('certificates');
    expect(resolveSearch('hello')).toBeNull();
  });
  it('keeps missing distinct from zero', () => {
    expect(num(null)).toBe('—');
    expect(num(0)).toBe('0');
    expect(pct(null)).toBe('—');
    expect(pct(0)).toBe('0.0%');
    expect(ha(undefined)).toBe('—');
  });
});
