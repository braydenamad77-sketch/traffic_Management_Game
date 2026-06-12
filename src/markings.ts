// Road paint planner. This keeps marking decisions out of the canvas renderer:
// the renderer draws prepared strokes, while this module decides where paint
// belongs along chains and through simple junctions.

import { Chain, Network, SegId } from './network';
import { LANE_W } from './roadTypes';
import { V, norm, offsetPoly, polyTangent, sub, subPoly } from './vec';

export type MarkingColor = 'white' | 'yellow';

export interface MarkingStroke {
  pts: V[];
  width: number;
  color: MarkingColor | string;
  dash?: number[];
  cap?: CanvasLineCap;
}

export interface MarkingPlan {
  laneBands: MarkingStroke[];
  center: MarkingStroke[];
  edge: MarkingStroke[];
  laneDividers: MarkingStroke[];
}

type Span = [number, number];

const EDGE_INSET = 0.35;

function chainJointNode(a: SegId, b: SegId, net: Network): number | null {
  const s1 = net.segs.get(a);
  const s2 = net.segs.get(b);
  if (!s1 || !s2) return null;
  if (s1.a === s2.a || s1.a === s2.b) return s1.a;
  if (s1.b === s2.a || s1.b === s2.b) return s1.b;
  return null;
}

function branchDirectionFromNode(net: Network, nodeId: number, sid: SegId): V {
  const seg = net.segs.get(sid)!;
  const node = net.nodes.get(nodeId)!;
  const mt = node.markTrim.get(sid) ?? node.trim.get(sid) ?? 8;
  const ap = net.approachPoly(nodeId, sid, Math.max(8, Math.min(mt, 14)));
  if (ap && ap.len > 0.5) return polyTangent(ap, Math.min(2, ap.len));
  const other = net.nodes.get(seg.a === nodeId ? seg.b : seg.a)!;
  return norm(sub(other.pos, node.pos));
}

function branchIsOnSide(ch: Chain, net: Network, nodeId: number, branchSid: SegId, arc: number, side: 1 | -1): boolean {
  const chainTangent = polyTangent(ch.poly, arc);
  const branchDir = branchDirectionFromNode(net, nodeId, branchSid);
  const cr = chainTangent.x * branchDir.y - chainTangent.y * branchDir.x;
  return (cr > 0 ? 1 : -1) === side;
}

function subtractGaps(start: number, end: number, gaps: Span[], minLen: number): Span[] {
  const spans: Span[] = [];
  let s0 = start;
  for (const [g0, g1] of gaps.sort((a, b) => a[0] - b[0])) {
    if (g1 <= s0 || g0 >= end) continue;
    if (g0 > s0 + minLen) spans.push([s0, Math.min(g0, end)]);
    s0 = Math.max(s0, g1);
  }
  if (end > s0 + minLen) spans.push([s0, end]);
  return spans;
}

function edgeSpans(ch: Chain, net: Network, side: 1 | -1): Span[] {
  const aN = net.nodes.get(ch.aNode)!;
  const bN = net.nodes.get(ch.bNode)!;
  const a = aN.markTrim.get(ch.aSeg) ?? aN.trim.get(ch.aSeg) ?? 0;
  const b = bN.markTrim.get(ch.bSeg) ?? bN.trim.get(ch.bSeg) ?? 0;
  const end = ch.poly.len - b;

  const gaps: Span[] = [];
  let arc = 0;
  for (let k = 0; k < ch.segs.length - 1; k++) {
    const s1 = net.segs.get(ch.segs[k])!;
    arc += s1.poly.len;
    const nid = chainJointNode(ch.segs[k], ch.segs[k + 1], net);
    const node = nid === null ? null : net.nodes.get(nid);
    if (!node || !node.isJunction) continue;

    const branchOnThisSide = node.segs.some(sid =>
      sid !== ch.segs[k] &&
      sid !== ch.segs[k + 1] &&
      branchIsOnSide(ch, net, node.id, sid, arc, side)
    );
    if (!branchOnThisSide) continue;

    gaps.push([
      arc - (node.markTrim.get(ch.segs[k]) ?? 0),
      arc + (node.markTrim.get(ch.segs[k + 1]) ?? 0),
    ]);
  }

  return subtractGaps(a, end, gaps, 1);
}

function centerSpans(ch: Chain, net: Network, a: number, b: number): Span[] {
  const gaps: Span[] = [];
  let arc = 0;
  for (let k = 0; k < ch.segs.length - 1; k++) {
    const s1 = net.segs.get(ch.segs[k])!;
    arc += s1.poly.len;
    const nid = chainJointNode(ch.segs[k], ch.segs[k + 1], net);
    const node = nid === null ? null : net.nodes.get(nid);
    if (!node || !node.isJunction) continue;

    // Every real junction gets a clean, intentional box gap. Center markings
    // should not run through a conflict area where cross traffic can enter.
    const branchHw = Math.max(...node.segs
      .filter(sid => sid !== ch.segs[k] && sid !== ch.segs[k + 1])
      .map(sid => net.segs.get(sid)!.rt.halfWidth), 2);
    const cap = branchHw * 2 + 5;
    gaps.push([
      arc - Math.min(node.markTrim.get(ch.segs[k]) ?? 0, cap) - 0.6,
      arc + Math.min(node.markTrim.get(ch.segs[k + 1]) ?? 0, cap) + 0.6,
    ]);
  }

  return subtractGaps(a, ch.poly.len - b, gaps, 2);
}

function pushCenterMarkings(plan: MarkingPlan, ch: Chain, net: Network, aT: number, bT: number) {
  const rt = ch.rt;
  if (!rt.centerTurn && rt.oneWay) return;

  const spans = rt.centerTurn
    ? [[aT, ch.poly.len - bT] as Span]
    : centerSpans(ch, net, aT, bT);

  for (const [c0, c1] of spans) {
    const cs = subPoly(ch.poly, c0, c1);
    if (cs.len < 2) continue;
    if (rt.centerTurn) {
      const o = LANE_W / 2;
      plan.laneBands.push({ pts: cs.pts, width: LANE_W - 0.05, color: 'rgba(231,185,60,.12)', cap: 'butt' });
      plan.center.push({ pts: offsetPoly(cs, o + 0.48), width: 0.32, color: 'yellow' });
      plan.center.push({ pts: offsetPoly(cs, -(o + 0.48)), width: 0.32, color: 'yellow' });
      plan.center.push({ pts: offsetPoly(cs, o - 0.28), width: 0.28, color: 'yellow', dash: [3.8, 3.0] });
      plan.center.push({ pts: offsetPoly(cs, -(o - 0.28)), width: 0.28, color: 'yellow', dash: [3.8, 3.0] });
    } else {
      plan.center.push({ pts: offsetPoly(cs, 0.24), width: 0.24, color: 'yellow' });
      plan.center.push({ pts: offsetPoly(cs, -0.24), width: 0.24, color: 'yellow' });
    }
  }
}

function pushLaneDividers(plan: MarkingPlan, ch: Chain, spanStart: number, spanEnd: number) {
  const span = subPoly(ch.poly, spanStart, spanEnd);
  for (const dir of [1, -1] as const) {
    const offs = ch.rt.lanes
      .filter(l => l.dir === dir && l.kind === 'drive')
      .map(l => l.off)
      .sort((a, b) => a - b);
    for (let i = 1; i < offs.length; i++) {
      const mid = (offs[i - 1] + offs[i]) / 2;
      plan.laneDividers.push({ pts: offsetPoly(span, mid), width: 0.2, color: 'white', dash: [3, 3.2] });
    }
  }
}

export function buildMarkingPlan(net: Network): MarkingPlan {
  const plan: MarkingPlan = { laneBands: [], center: [], edge: [], laneDividers: [] };

  for (const ch of net.chains) {
    const aN = net.nodes.get(ch.aNode)!;
    const bN = net.nodes.get(ch.bNode)!;
    const aT = (aN.markTrim.get(ch.aSeg) ?? aN.trim.get(ch.aSeg) ?? 0) + (aN.segs.length >= 3 ? 0.6 : 0.1);
    const bT = (bN.markTrim.get(ch.bSeg) ?? bN.trim.get(ch.bSeg) ?? 0) + (bN.segs.length >= 3 ? 0.6 : 0.1);
    if (ch.poly.len - aT - bT < 3) continue;

    for (const side of [1, -1] as const) {
      for (const [e0, e1] of edgeSpans(ch, net, side)) {
        const es = subPoly(ch.poly, e0, e1);
        if (es.len < 0.8) continue;
        plan.edge.push({ pts: offsetPoly(es, side * (ch.rt.halfWidth - EDGE_INSET)), width: 0.26, color: 'white' });
      }
    }

    pushCenterMarkings(plan, ch, net, aT, bT);
    pushLaneDividers(plan, ch, aT, ch.poly.len - bT);
  }

  return plan;
}
