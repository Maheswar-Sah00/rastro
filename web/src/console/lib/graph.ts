// Lineage graph helpers. They turn the API graph (/shipments/{id}/lineage/graph) into a drawable,
// layered layout. They never compute risk totals: node and edge quantities are the API's numbers.
// The only derived quantities (inHead/outHead) size the drawn bands.
import type { GraphEdge, GraphNode, LineageGraph } from '../api/types';

export type DrawKind = 'source' | 'intermediary' | 'direct_supplier' | 'destination' | 'unknown' | 'folded';

export interface DrawNode {
  id: string;
  kind: DrawKind;
  label: string;
  ranch_id: string | null;
  roles: string[];
  head: number;          // API head_fifo (origin contribution)
  headProRata: number;   // API head_pro_rata
  share_pct: number;     // API share_pct
  categories: string[];
  finding_ids: string[];
  data_status: string;
  members: string[];     // folded nodes: the ranches the API grouped
  layer: number;
  inHead: number;
  outHead: number;
}
export interface DrawEdge {
  source: string;
  target: string;
  head: number;          // API attributed_head
  permit_head: number;
  gta_id: string | null;
  date: string | null;
  gta_count: number | null;
  kind: GraphEdge['kind'];
  back?: boolean;
}
export interface DrawGraph { nodes: DrawNode[]; edges: DrawEdge[]; layers: number; removedBackEdges: number }

export function kindOf(n: GraphNode): DrawKind {
  if (n.kind === 'sink') return 'destination';
  if (n.kind === 'unknown_origin') return 'unknown';
  if (n.kind === 'folded') return 'folded';
  if (n.roles.includes('direct_supplier')) return 'direct_supplier';
  if (n.roles.includes('intermediary')) return 'intermediary';
  return 'source';
}

export function isUnknownNode(n: Pick<DrawNode, 'id' | 'kind'>): boolean {
  return n.kind === 'unknown' || n.id.startsWith('UNRESOLVED') || n.id.startsWith('MISSING') || n.id === 'other:unknown_origin';
}

export function fromApi(g: LineageGraph): DrawGraph {
  const members = new Map(g.view.folded.map((f) => [f.node, f.members]));
  const nodes = g.nodes.map((n) => {
    const kind = kindOf(n);
    const m = members.get(n.id) || [];
    return {
      id: n.id,
      kind,
      label: kind === 'folded' ? `${m.length} ${n.id.replace(/^other:/, '').replace(/_/g, ' ')}` : n.id,
      ranch_id: n.ranch_id,
      roles: n.roles,
      head: n.head_fifo,
      headProRata: n.head_pro_rata,
      share_pct: n.share_pct,
      categories: n.categories,
      finding_ids: n.finding_ids,
      data_status: n.data_status,
      members: m,
      layer: 0,
      inHead: 0,
      outHead: 0,
    } satisfies DrawNode;
  });
  const edges: DrawEdge[] = g.edges.map((e) => ({
    source: e.from, target: e.to, head: e.attributed_head, permit_head: e.permit_head, gta_id: e.gta_id, date: e.date,
    gta_count: e.gta_count ?? null, kind: e.kind,
  }));
  return layout(nodes, edges);
}

/** Remove cycles (first-seen direction wins), then assign columns by longest path from the origins. */
export function layout(nodes: DrawNode[], edges: DrawEdge[]): DrawGraph {
  const ids = new Set(nodes.map((n) => n.id));
  const es = edges.filter((e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target).map((e) => ({ ...e, back: false }));
  const out = new Map<string, DrawEdge[]>();
  for (const e of es) out.set(e.source, [...(out.get(e.source) || []), e]);
  const state = new Map<string, number>();
  let removed = 0;
  const visit = (id: string) => {
    state.set(id, 1);
    for (const e of out.get(id) || []) {
      const s = state.get(e.target) || 0;
      if (s === 1) {
        e.back = true;
        removed++;
      } else if (s === 0) visit(e.target);
    }
    state.set(id, 2);
  };
  const order = [...nodes].sort((a, b) => RANK[a.kind] - RANK[b.kind] || a.id.localeCompare(b.id));
  for (const n of order) if (!state.get(n.id)) visit(n.id);
  const dag = es.filter((e) => !e.back);

  const layer = new Map<string, number>();
  const indeg = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  for (const e of dag) indeg.set(e.target, (indeg.get(e.target) || 0) + 1);
  const queue = nodes.filter((n) => !indeg.get(n.id)).map((n) => n.id);
  queue.forEach((id) => layer.set(id, 0));
  while (queue.length) {
    const id = queue.shift()!;
    for (const e of out.get(id) || []) {
      if (e.back) continue;
      layer.set(e.target, Math.max(layer.get(e.target) || 0, (layer.get(id) || 0) + 1));
      indeg.set(e.target, (indeg.get(e.target) || 0) - 1);
      if (!indeg.get(e.target)) queue.push(e.target);
    }
  }
  // Destinations sit in the last column, one past the deepest other node.
  const inner = nodes.filter((n) => n.kind !== 'destination').map((n) => layer.get(n.id) || 0);
  const hasDest = nodes.some((n) => n.kind === 'destination');
  const last = Math.max(0, ...inner) + (hasDest ? 1 : 0);
  for (const n of nodes) if (n.kind === 'destination') layer.set(n.id, last);

  const inHead = new Map<string, number>();
  const outHead = new Map<string, number>();
  for (const e of dag) {
    outHead.set(e.source, (outHead.get(e.source) || 0) + e.head);
    inHead.set(e.target, (inHead.get(e.target) || 0) + e.head);
  }
  return {
    nodes: nodes.map((n) => ({ ...n, layer: layer.get(n.id) || 0, inHead: inHead.get(n.id) || 0, outHead: outHead.get(n.id) || 0 })),
    edges: es,
    layers: last + 1,
    removedBackEdges: removed,
  };
}

const RANK: Record<DrawKind, number> = { source: 0, unknown: 0, folded: 0, intermediary: 1, direct_supplier: 2, destination: 3 };

/** Edges downstream of any node carrying `category` (paths to highlight). */
export function highlightPaths(g: DrawGraph, category: string | null): Set<DrawEdge> {
  const on = new Set<DrawEdge>();
  if (!category) return on;
  const marked = g.nodes.filter((n) => n.categories.includes(category) || (category === 'unknown_origin' && isUnknownNode(n))).map((n) => n.id);
  const down = new Map<string, DrawEdge[]>();
  for (const e of g.edges) if (!e.back) down.set(e.source, [...(down.get(e.source) || []), e]);
  const seen = new Set<string>();
  const walk = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const e of down.get(id) || []) {
      on.add(e);
      walk(e.target);
    }
  };
  marked.forEach(walk);
  return on;
}

/** Display checks only: what the drawn graph says next to the API totals (used in the UI and tests). */
export function graphChecks(api: LineageGraph) {
  const originHead = api.nodes.reduce((s, n) => s + n.head_fifo, 0);
  const intoDestination = api.edges.filter((e) => e.to === api.destination).reduce((s, e) => s + e.attributed_head, 0);
  return {
    originHead,
    intoDestination,
    declared: api.declared_head,
    apiSourceHead: api.totals.source_head_fifo ?? null,
    originsMatchApi: api.totals.source_head_fifo === undefined ? null : Math.abs(originHead - api.totals.source_head_fifo) < 0.01,
    destinationMatchesDeclared: Math.abs(intoDestination - api.declared_head) < 0.01,
  };
}
