// Canvas renderer: terrain (cached offscreen), roads with lane markings,
// junctions, signals/signs, cars, editor overlays.

import { Camera } from './camera';
import { Network, Segment, RNode, Lane, Chain } from './network';
import { Sim, Car } from './sim';
import { Tools } from './tools';
import { TerrainMap, WORLD_W, WORLD_H, inWater } from './terrain';
import { LANE_W, roadType } from './roadTypes';
import { V, Poly, subPoly, offsetPoly, makePoly, polyPoint, polyTangent, projectOnPoly, norm, sub, clamp } from './vec';
import { SignalSystem } from './signals';

const COL = {
  bgVoid: '#101216',
  grass: '#7ba05f',
  grassDark: '#6f9355',
  water: '#4f86b0',
  waterEdge: '#7fb2d4',
  asphalt: '#41454d',
  asphaltEdge: '#34373e',
  junction: '#41454d',
  white: '#e8e6df',
  yellow: '#e7b93c',
  bridgeDeck: '#4d525c',
  bridgeRail: '#262931',
  tree1: '#5d8a48',
  tree2: '#4e7a3c',
};

interface Fillet {
  // curb curve (pavement boundary)
  eA: V; eB: V; ctrl: V;
  // white edge-line sweep, inset from the curb — its endpoints coincide
  // exactly with the adjacent roads' edge-line ends, so the painted line
  // flows continuously around the corner
  wA: V; wB: V; wCtrl: V;
}

interface JGeom {
  pos: V;
  stubs: { pts: V[]; hw: number }[];
  fillets: Fillet[];
  coreR: number;
}

const CAR_COLORS = [
  '#c94f43', '#3f6fb5', '#d9d4c8', '#494e57', '#7a9e63',
  '#b08fc4', '#d98e32', '#5fa8a0', '#8a4f3d', '#e3c84f',
];

export class Renderer {
  private terrainCache: HTMLCanvasElement | null = null;
  private terrainCacheId = '';

  constructor(
    private canvas: HTMLCanvasElement,
    private cam: Camera,
  ) {}

  render(net: Network, sim: Sim, tools: Tools, map: TerrainMap, heatmap: boolean, time: number) {
    const ctx = this.canvas.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    if (this.canvas.width !== Math.round(rect.width * dpr)) {
      this.canvas.width = Math.round(rect.width * dpr);
      this.canvas.height = Math.round(rect.height * dpr);
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = COL.bgVoid;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    this.cam.apply(ctx, dpr);
    this.drawTerrain(ctx, map);

    // global passes. The invariant that keeps junctions artifact-free:
    // ALL dark outlines (roads, stubs, fillet curbs) draw in one pass UNDER
    // all asphalt fills — outlines can only ever show against grass. Then
    // markings, then mouth covers (plain asphalt) over markings.
    for (const seg of net.segs.values()) this.drawBridgeBase(ctx, seg, map);

    const jgeoms = new Map<number, JGeom>();
    for (const node of net.nodes.values()) {
      const g = this.computeJunctionGeom(node, net);
      if (g) jgeoms.set(node.id, g);
    }

    // pass A: outlines
    for (const ch of net.chains) this.strokePoly(ctx, ch.poly.pts, ch.rt.halfWidth * 2 + 0.9, COL.asphaltEdge);
    for (const g of jgeoms.values()) {
      for (const s of g.stubs) this.strokePoly(ctx, s.pts, s.hw * 2 + 0.9, COL.asphaltEdge, undefined, 'butt');
      for (const f of g.fillets) this.strokeFilletCurb(ctx, f);
    }
    // pass B: asphalt
    for (const ch of net.chains) this.strokePoly(ctx, ch.poly.pts, ch.rt.halfWidth * 2, COL.asphalt);
    for (const g of jgeoms.values()) this.fillJunctionGeom(ctx, g);
    // pass C: markings
    for (const ch of net.chains) this.drawChainMarkings(ctx, ch, net);
    // pass D: mouth covers — plain asphalt over markings inside junctions
    for (const g of jgeoms.values()) this.fillJunctionGeom(ctx, g);
    // pass E: corner sweeps — the white edge line follows the pavement
    // boundary around every junction corner, joining road edge lines
    ctx.strokeStyle = COL.white;
    ctx.lineWidth = 0.26;
    ctx.lineCap = 'round';
    for (const g of jgeoms.values()) {
      for (const f of g.fillets) {
        ctx.beginPath();
        ctx.moveTo(f.wA.x, f.wA.y);
        ctx.quadraticCurveTo(f.wCtrl.x, f.wCtrl.y, f.wB.x, f.wB.y);
        ctx.stroke();
      }
    }

    for (const seg of net.segs.values()) this.drawTurnPockets(ctx, seg, net);
    for (const node of net.nodes.values()) this.drawJunctionDressing(ctx, node, net, sim.signals, time);

    if (heatmap) this.drawHeatmap(ctx, net, sim);

    for (const car of sim.cars) this.drawCar(ctx, car, time);

    this.drawOverlays(ctx, net, tools, time);
    this.drawWorldBorder(ctx);
  }

  /* ---------------- terrain ---------------- */

  private drawTerrain(ctx: CanvasRenderingContext2D, map: TerrainMap) {
    if (!this.terrainCache || this.terrainCacheId !== map.id) {
      this.terrainCacheId = map.id;
      const sc = 3;
      const cv = document.createElement('canvas');
      cv.width = WORLD_W * sc; cv.height = WORLD_H * sc;
      const c = cv.getContext('2d')!;
      c.scale(sc, sc);
      c.fillStyle = COL.grass;
      c.fillRect(0, 0, WORLD_W, WORLD_H);
      // mottled grass patches (deterministic)
      let s = 42;
      const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
      c.fillStyle = COL.grassDark;
      for (let i = 0; i < 260; i++) {
        const x = rnd() * WORLD_W, y = rnd() * WORLD_H, r = 3 + rnd() * 11;
        c.globalAlpha = 0.12 + rnd() * 0.16;
        c.beginPath(); c.ellipse(x, y, r, r * (0.5 + rnd() * 0.5), rnd() * 3, 0, 7); c.fill();
      }
      c.globalAlpha = 1;
      // water
      for (const poly of map.water) {
        c.fillStyle = COL.waterEdge;
        c.beginPath();
        poly.forEach((p, i) => i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y));
        c.closePath(); c.fill();
        c.save(); c.clip();
        c.fillStyle = COL.water;
        c.beginPath();
        poly.forEach((p, i) => i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y));
        c.closePath();
        c.save(); c.translate(0, 1.6); c.fill(); c.restore();
        c.restore();
      }
      // trees
      for (const t of map.trees) {
        c.fillStyle = 'rgba(0,0,0,.18)';
        c.beginPath(); c.ellipse(t.x + 0.7, t.y + 0.9, 2.3, 1.7, 0, 0, 7); c.fill();
        c.fillStyle = COL.tree1;
        c.beginPath(); c.arc(t.x, t.y, 2.2, 0, 7); c.fill();
        c.fillStyle = COL.tree2;
        c.beginPath(); c.arc(t.x - 0.5, t.y - 0.5, 1.3, 0, 7); c.fill();
      }
      this.terrainCache = cv;
    }
    ctx.drawImage(this.terrainCache, 0, 0, WORLD_W, WORLD_H);
  }

  private drawWorldBorder(ctx: CanvasRenderingContext2D) {
    ctx.strokeStyle = 'rgba(246,201,69,.35)';
    ctx.lineWidth = 0.8;
    ctx.setLineDash([6, 5]);
    ctx.strokeRect(0, 0, WORLD_W, WORLD_H);
    ctx.setLineDash([]);
  }

  /* ---------------- roads ---------------- */

  private strokePoly(ctx: CanvasRenderingContext2D, pts: V[], width: number, color: string, dash?: number[], cap: CanvasLineCap = 'round') {
    if (pts.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = cap;
    ctx.lineJoin = 'round';
    if (dash) ctx.setLineDash(dash);
    ctx.stroke();
    if (dash) ctx.setLineDash([]);
  }

  private waterSpans(seg: Segment, map: TerrainMap): [number, number][] {
    if (!map.water.length) return [];
    const spans: [number, number][] = [];
    let start = -1;
    const step = 4;
    for (let s = 0; s <= seg.poly.len; s += step) {
      const wet = inWater(map, polyPoint(seg.poly, s));
      if (wet && start < 0) start = Math.max(0, s - step);
      if (!wet && start >= 0) { spans.push([start, s]); start = -1; }
    }
    if (start >= 0) spans.push([start, seg.poly.len]);
    return spans;
  }

  private drawBridgeBase(ctx: CanvasRenderingContext2D, seg: Segment, map: TerrainMap) {
    const spans = this.waterSpans(seg, map);
    if (!spans.length) return;
    const hw = seg.rt.halfWidth;
    for (const [s0, s1] of spans) {
      const sp = subPoly(seg.poly, Math.max(0, s0 - 3), Math.min(seg.poly.len, s1 + 3));
      // shadow on water
      ctx.save();
      ctx.translate(1.2, 1.8);
      this.strokePoly(ctx, sp.pts, hw * 2 + 1.2, 'rgba(0,0,0,.25)');
      ctx.restore();
      // rails + deck
      this.strokePoly(ctx, sp.pts, hw * 2 + 2.2, COL.bridgeRail);
      this.strokePoly(ctx, sp.pts, hw * 2 + 1.0, COL.bridgeDeck);
    }
  }

  /** geometry of one junction's patch: branch stubs, corner fillets, core */
  private computeJunctionGeom(node: RNode, net: Network): JGeom | null {
    if (node.segs.length < 2) return null;
    if (node.segs.length === 2) {
      if (node.junctionR <= 1) return null;
      return { pos: node.pos, stubs: [], fillets: [], coreR: Math.max(node.junctionR, 2) };
    }

    const through = node.markThrough;
    // through approach centerlines, for clipping branch stubs against
    const throughAps: Poly[] = [];
    if (through) {
      for (const sid of through) {
        const ap = net.approachPoly(node.id, sid, (node.markTrim.get(sid) ?? 10) + 14);
        if (ap) throughAps.push(ap);
      }
    }

    const stubs: { pts: V[]; hw: number }[] = [];
    const apCache = new Map<number, Poly | null>();
    const approach = (sid: number) => {
      if (!apCache.has(sid)) {
        const mt = node.markTrim.get(sid) ?? node.trim.get(sid) ?? 0;
        apCache.set(sid, net.approachPoly(node.id, sid, mt + 2));
      }
      return apCache.get(sid)!;
    };

    for (const sid of node.segs) {
      // the through road keeps its markings — no stub paves over them
      if (through && (sid === through[0] || sid === through[1])) continue;
      const seg = net.segs.get(sid)!;
      const mt = node.markTrim.get(sid) ?? node.trim.get(sid) ?? 0;
      if (mt < 0.5) continue;
      const ap = approach(sid);
      if (!ap) continue;
      const end = Math.min(mt, ap.len);
      // with a through road, the stub starts only once the branch pavement
      // has actually left it — keeps the centerline yellow intact
      let start = 0;
      if (through && throughAps.length) {
        const clear = seg.rt.halfWidth + 1.2;
        for (let s = 0; s < end; s += 1.5) {
          const p = polyPoint(ap, s);
          const d = Math.min(...throughAps.map(tp => projectOnPoly(tp, p).d));
          if (d >= clear) { start = Math.max(0, s - 1.5); break; }
          start = s;
        }
      }
      if (end - start < 1) continue;
      stubs.push({ pts: subPoly(ap, start, end).pts, hw: seg.rt.halfWidth });
    }

    // corner fillets between adjacent approaches
    interface AG { c: V; tIn: V; away: V; hw: number; ang: number; }
    const geos: AG[] = [];
    for (const sid of node.segs) {
      const seg = net.segs.get(sid)!;
      const mt = node.markTrim.get(sid) ?? node.trim.get(sid) ?? 0;
      if (mt < 1) continue;
      const ap = approach(sid);
      if (!ap) continue;
      // exactly markTrim, so corner sweeps meet the road edge lines point-for-point
      const s = Math.min(mt, ap.len - 0.3);
      const c = polyPoint(ap, s);
      const outward = polyTangent(ap, s);
      geos.push({
        c,
        tIn: { x: -outward.x, y: -outward.y },
        away: norm(sub(c, node.pos)),
        hw: seg.rt.halfWidth,
        ang: Math.atan2(c.y - node.pos.y, c.x - node.pos.x),
      });
    }
    const fillets: Fillet[] = [];
    if (geos.length >= 2) {
      geos.sort((a, b) => a.ang - b.ang);
      const perp = (t: V): V => ({ x: -t.y, y: t.x });
      // A's edge point at lateral `off`, on the side facing B's cut point —
      // a distance test, stable even for near-parallel gore pairs
      const edgePoint = (A: AG, B: AG, off: number): V => {
        const p = perp(A.tIn);
        const e1 = { x: A.c.x + p.x * off, y: A.c.y + p.y * off };
        const e2 = { x: A.c.x - p.x * off, y: A.c.y - p.y * off };
        const d1 = (e1.x - B.c.x) ** 2 + (e1.y - B.c.y) ** 2;
        const d2 = (e2.x - B.c.x) ** 2 + (e2.y - B.c.y) ** 2;
        return d1 <= d2 ? e1 : e2;
      };
      for (let i = 0; i < geos.length; i++) {
        const A = geos[i], B = geos[(i + 1) % geos.length];
        let gap = B.ang - A.ang;
        if (gap <= 0) gap += Math.PI * 2;
        if (gap > 2.3) continue;          // wide corner: nothing to flare
        const eA = edgePoint(A, B, A.hw);
        const eB = edgePoint(B, A, B.hw);
        const wA = edgePoint(A, B, A.hw - 0.35);
        const wB = edgePoint(B, A, B.hw - 0.35);
        const chord = Math.hypot(eA.x - eB.x, eA.y - eB.y);
        if (chord < 1) continue;

        // one validity decision for both curves so the white sweep always
        // stays inside the curb wedge
        const d1 = A.tIn, d2 = B.tIn;
        const denom = d1.x * d2.y - d1.y * d2.x;
        let useIntersect = false;
        if (gap > 0.55 && Math.abs(denom) > 0.12) {
          const t = ((eB.x - eA.x) * d2.y - (eB.y - eA.y) * d2.x) / denom;
          const cand = { x: eA.x + d1.x * t, y: eA.y + d1.y * t };
          const far = Math.hypot(cand.x - node.pos.x, cand.y - node.pos.y);
          useIntersect = t > 0 && t < chord * 2.5 && far < 38;
        }
        const cornerCtrl = (pA: V, pB: V): V => {
          if (useIntersect) {
            const t = ((pB.x - pA.x) * d2.y - (pB.y - pA.y) * d2.x) / denom;
            return { x: pA.x + d1.x * t, y: pA.y + d1.y * t };
          }
          const mid = { x: (pA.x + pB.x) / 2, y: (pA.y + pB.y) / 2 };
          return {
            x: mid.x + (node.pos.x - mid.x) * 0.35,
            y: mid.y + (node.pos.y - mid.y) * 0.35,
          };
        };
        fillets.push({
          eA, eB, ctrl: cornerCtrl(eA, eB),
          wA, wB, wCtrl: cornerCtrl(wA, wB),
        });
      }
    }

    const maxHalf = Math.max(...node.segs.map(id => net.segs.get(id)!.rt.halfWidth));
    return {
      pos: node.pos,
      stubs,
      fillets,
      coreR: node.markThrough ? 0 : maxHalf + 0.6,
    };
  }

  private strokeFilletCurb(ctx: CanvasRenderingContext2D, f: Fillet) {
    ctx.strokeStyle = COL.asphaltEdge;
    ctx.lineWidth = 0.9;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(f.eA.x, f.eA.y);
    ctx.quadraticCurveTo(f.ctrl.x, f.ctrl.y, f.eB.x, f.eB.y);
    ctx.stroke();
  }

  /** plain asphalt: stubs + fillet wedges + core disc (no outlines) */
  private fillJunctionGeom(ctx: CanvasRenderingContext2D, g: JGeom) {
    for (const s of g.stubs) this.strokePoly(ctx, s.pts, s.hw * 2, COL.asphalt, undefined, 'butt');
    ctx.fillStyle = COL.asphalt;
    for (const f of g.fillets) {
      ctx.beginPath();
      ctx.moveTo(f.eA.x, f.eA.y);
      ctx.quadraticCurveTo(f.ctrl.x, f.ctrl.y, f.eB.x, f.eB.y);
      ctx.lineTo(f.ctrl.x, f.ctrl.y);
      ctx.closePath();
      ctx.fill();
    }
    if (g.coreR > 0) {
      ctx.beginPath();
      ctx.arc(g.pos.x, g.pos.y, g.coreR, 0, 7);
      ctx.fill();
    }
  }

  /** centerline spans along a chain, gapped where a junction allows left
      turns across it (MUTCD-style: centerlines break across intersections) */
  private centerSpans(ch: Chain, net: Network, a: number, b: number): [number, number][] {
    const gaps: [number, number][] = [];
    let arc = 0;
    for (let k = 0; k < ch.segs.length - 1; k++) {
      const s1 = net.segs.get(ch.segs[k])!;
      const s2 = net.segs.get(ch.segs[k + 1])!;
      arc += s1.poly.len;
      const nid = (s1.a === s2.a || s1.a === s2.b) ? s1.a : s1.b;
      const node = net.nodes.get(nid);
      if (!node || !node.isJunction) continue;
      if (!node.conns.some(c => c.turn === 'L')) continue;
      // gap only the mouth, not the whole taper — real centerline breaks
      // are about as wide as the crossing road
      const branchHw = Math.max(...node.segs
        .filter(sid => sid !== ch.segs[k] && sid !== ch.segs[k + 1])
        .map(sid => net.segs.get(sid)!.rt.halfWidth), 2);
      const cap = branchHw * 2 + 5;
      gaps.push([
        arc - Math.min(node.markTrim.get(ch.segs[k]) ?? 0, cap) - 0.6,
        arc + Math.min(node.markTrim.get(ch.segs[k + 1]) ?? 0, cap) + 0.6,
      ]);
    }
    const spans: [number, number][] = [];
    const end = ch.poly.len - b;
    let s0 = a;
    for (const [g0, g1] of gaps) {
      if (g0 > s0 + 2) spans.push([s0, Math.min(g0, end)]);
      s0 = Math.max(s0, g1);
    }
    if (end > s0 + 2) spans.push([s0, end]);
    return spans;
  }

  /** white edge-line spans for one side of a chain (+1 right of travel),
      ending exactly at junction markTrims and gapped where branches attach
      on that side — corner sweeps take over from there */
  private edgeSpans(ch: Chain, net: Network, side: 1 | -1): [number, number][] {
    const aN = net.nodes.get(ch.aNode)!;
    const bN = net.nodes.get(ch.bNode)!;
    const a = aN.markTrim.get(ch.aSeg) ?? aN.trim.get(ch.aSeg) ?? 0;
    const b = bN.markTrim.get(ch.bSeg) ?? bN.trim.get(ch.bSeg) ?? 0;
    const end = ch.poly.len - b;

    const gaps: [number, number][] = [];
    let arc = 0;
    for (let k = 0; k < ch.segs.length - 1; k++) {
      const s1 = net.segs.get(ch.segs[k])!;
      const s2 = net.segs.get(ch.segs[k + 1])!;
      arc += s1.poly.len;
      const nid = (s1.a === s2.a || s1.a === s2.b) ? s1.a : s1.b;
      const node = net.nodes.get(nid);
      if (!node || !node.isJunction) continue;
      const T = polyTangent(ch.poly, arc);
      let branchHere = false;
      for (const sid of node.segs) {
        if (sid === ch.segs[k] || sid === ch.segs[k + 1]) continue;
        const seg = net.segs.get(sid)!;
        const other = net.nodes.get(seg.a === nid ? seg.b : seg.a)!;
        const d = norm(sub(other.pos, node.pos));
        const cr = T.x * d.y - T.y * d.x;     // > 0: branch on the right
        if ((cr > 0 ? 1 : -1) === side) { branchHere = true; break; }
      }
      if (!branchHere) continue;
      gaps.push([
        arc - (node.markTrim.get(ch.segs[k]) ?? 0),
        arc + (node.markTrim.get(ch.segs[k + 1]) ?? 0),
      ]);
    }

    gaps.sort((x, y) => x[0] - y[0]);
    const spans: [number, number][] = [];
    let s0 = a;
    for (const [g0, g1] of gaps) {
      if (g0 > s0 + 1) spans.push([s0, Math.min(g0, end)]);
      s0 = Math.max(s0, g1);
    }
    if (end > s0 + 1) spans.push([s0, end]);
    return spans;
  }

  private drawChainMarkings(ctx: CanvasRenderingContext2D, ch: Chain, net: Network) {
    const aN = net.nodes.get(ch.aNode)!;
    const bN = net.nodes.get(ch.bNode)!;
    const aT = (aN.markTrim.get(ch.aSeg) ?? aN.trim.get(ch.aSeg) ?? 0) + (aN.segs.length >= 3 ? 0.6 : 0.1);
    const bT = (bN.markTrim.get(ch.bSeg) ?? bN.trim.get(ch.bSeg) ?? 0) + (bN.segs.length >= 3 ? 0.6 : 0.1);
    if (ch.poly.len - aT - bT < 3) return;
    const span = subPoly(ch.poly, aT, ch.poly.len - bT);
    const rt = ch.rt;
    const hw = rt.halfWidth;

    // edge lines: per side, gapped at branch mouths, exact trim ends
    for (const side of [1, -1] as const) {
      for (const [e0, e1] of this.edgeSpans(ch, net, side)) {
        const es = subPoly(ch.poly, e0, e1);
        if (es.len < 0.8) continue;
        this.strokePoly(ctx, offsetPoly(es, side * (hw - 0.35)), 0.26, COL.white);
      }
    }

    // center markings, gapped across left-turn junctions
    if (rt.centerTurn || !rt.oneWay) {
      for (const [c0, c1] of this.centerSpans(ch, net, aT, bT)) {
        const cs = subPoly(ch.poly, c0, c1);
        if (cs.len < 2) continue;
        if (rt.centerTurn) {
          const o = LANE_W / 2;
          this.strokePoly(ctx, offsetPoly(cs, o + 0.18), 0.24, COL.yellow);
          this.strokePoly(ctx, offsetPoly(cs, -(o + 0.18)), 0.24, COL.yellow);
          this.strokePoly(ctx, offsetPoly(cs, o - 0.32), 0.22, COL.yellow, [2.6, 2.6]);
          this.strokePoly(ctx, offsetPoly(cs, -(o - 0.32)), 0.22, COL.yellow, [2.6, 2.6]);
        } else {
          this.strokePoly(ctx, offsetPoly(cs, 0.24), 0.24, COL.yellow);
          this.strokePoly(ctx, offsetPoly(cs, -0.24), 0.24, COL.yellow);
        }
      }
    }

    // dashed dividers between same-direction lanes
    for (const dir of [1, -1] as const) {
      const offs = rt.lanes
        .filter(l => l.dir === dir && l.kind === 'drive')
        .map(l => l.off)
        .sort((a, b) => a - b);
      for (let i = 1; i < offs.length; i++) {
        const mid = (offs[i - 1] + offs[i]) / 2;
        this.strokePoly(ctx, offsetPoly(span, mid), 0.2, COL.white, [3, 3.2]);
      }
    }
  }

  /** center turn-lane arrows — drawn above junction discs */
  private drawTurnPockets(ctx: CanvasRenderingContext2D, seg: Segment, net: Network) {
    if (!seg.rt.centerTurn || this.cam.zoom <= 1.6) return;
    for (const lane of seg.lanes) {
      if (lane.def.kind !== 'turn' || lane.poly.len < 12) continue;
      const endNode = net.nodes.get(lane.def.dir === 1 ? seg.b : seg.a)!;
      if (!endNode.isJunction) continue;
      this.drawTurnGlyph(ctx, lane, 'L');
    }
  }

  private drawTurnGlyph(ctx: CanvasRenderingContext2D, lane: Lane, turn: 'L' | 'R' | 'S') {
    const s = Math.max(2, lane.poly.len - 7);
    const p = polyPoint(lane.poly, s);
    const t = polyTangent(lane.poly, s);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(Math.atan2(t.y, t.x));
    ctx.strokeStyle = COL.white;
    ctx.lineWidth = 0.45;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-1.8, 0);
    ctx.lineTo(0.6, 0);
    if (turn === 'L') { ctx.quadraticCurveTo(1.6, 0, 1.6, -1.1); }
    else if (turn === 'R') { ctx.quadraticCurveTo(1.6, 0, 1.6, 1.1); }
    else ctx.lineTo(2, 0);
    ctx.stroke();
    // arrowhead
    const hx = turn === 'S' ? 2 : 1.6;
    const hy = turn === 'L' ? -1.1 : turn === 'R' ? 1.1 : 0;
    ctx.fillStyle = COL.white;
    ctx.beginPath();
    if (turn === 'S') {
      ctx.moveTo(hx + 0.9, 0); ctx.lineTo(hx - 0.3, -0.7); ctx.lineTo(hx - 0.3, 0.7);
    } else {
      const dy = turn === 'L' ? -0.9 : 0.9;
      ctx.moveTo(hx, hy + dy); ctx.lineTo(hx - 0.7, hy - dy * 0.2); ctx.lineTo(hx + 0.7, hy - dy * 0.2);
    }
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  /* ---------------- junction dressing: stop lines, signals, signs ---------------- */

  private drawJunctionDressing(ctx: CanvasRenderingContext2D, node: RNode, net: Network, signals: SignalSystem, time: number) {
    if (!node.isJunction) return;
    const isLights = node.control.kind === 'lights';
    const through = node.markThrough;

    // left-turn guide lines: the AI's actual turning paths, made visible
    if (isLights || !through) {
      ctx.strokeStyle = 'rgba(232,230,223,.5)';
      ctx.lineWidth = 0.18;
      ctx.setLineDash([1.2, 2.2]);
      for (const conn of node.conns) {
        if (conn.turn !== 'L' || conn.poly.len < 5) continue;
        ctx.beginPath();
        const pts = conn.poly.pts;
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    for (const ap of node.approaches) {
      const lanes = ap.inLanes;
      if (!lanes.length) continue;
      const lo = Math.min(...lanes.map(l => l.offTravel)) - LANE_W / 2 + 0.3;
      const hi = Math.max(...lanes.map(l => l.offTravel)) + LANE_W / 2 - 0.3;
      const c = ap.stopPos;
      const d = ap.stopDir;
      const sign = net.signFor(node, ap.seg);
      const isThroughAp = !!through && (ap.seg === through[0] || ap.seg === through[1]);

      // stop / yield bar: controlled approaches get the full bar; approaches
      // that must yield by geometry (everything at a bare box, branches at a
      // through road) get a lighter one
      const bar = (width: number, dash?: number[]) => {
        ctx.strokeStyle = COL.white;
        ctx.lineWidth = width;
        if (dash) ctx.setLineDash(dash);
        ctx.beginPath();
        ctx.moveTo(c.x + d.x * lo, c.y + d.y * lo);
        ctx.lineTo(c.x + d.x * hi, c.y + d.y * hi);
        ctx.stroke();
        if (dash) ctx.setLineDash([]);
      };
      if (isLights || sign === 'stop' || sign === 'blinkR') bar(0.7);
      else if (sign === 'yield' || sign === 'blinkY') bar(0.55, [1.1, 1.1]);
      else if (!isThroughAp) bar(0.5);

      // crosswalk at signalized approaches, just beyond the stop bar
      if (isLights) this.drawCrosswalk(ctx, node, net, ap.seg);

      // lane turn glyphs at signal/sign-controlled approaches
      if (this.cam.zoom > 2.1 && (isLights || node.control.kind === 'signs')) {
        for (const lane of lanes) {
          const turns = new Set(net.connsFrom(lane.id).map(cc => cc.turn));
          if (turns.size === 1) this.drawTurnGlyph(ctx, lane, [...turns][0]);
        }
      }

      // signal head / sign icon at right corner of the approach
      const iconPos = {
        x: c.x + d.x * (hi + 1.6),
        y: c.y + d.y * (hi + 1.6),
      };
      if (isLights) {
        const light = signals.lightForApproach(node, ap.seg);
        ctx.fillStyle = '#22252b';
        ctx.beginPath(); ctx.arc(iconPos.x, iconPos.y, 1.45, 0, 7); ctx.fill();
        ctx.fillStyle = light === 'green' ? '#3fd06a' : light === 'yellow' ? '#ffc233' : '#ff5043';
        ctx.beginPath(); ctx.arc(iconPos.x, iconPos.y, 0.85, 0, 7); ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,.4)'; ctx.lineWidth = 0.18;
        ctx.stroke();
      } else if (sign !== 'none') {
        this.drawSignIcon(ctx, iconPos, sign, time);
      }
    }
  }

  /** continental crosswalk bars across the full road width, junction-side
      of the stop bar */
  private drawCrosswalk(ctx: CanvasRenderingContext2D, node: RNode, net: Network, segId: number) {
    const seg = net.segs.get(segId);
    if (!seg) return;
    const trim = node.trim.get(segId) ?? 0;
    if (trim < 2 || seg.poly.len < trim + 2) return;
    const atA = seg.a === node.id;
    // band center sits 1.7 units junction-side of the lane trim
    const arc = atA ? Math.max(0.5, trim - 1.7) : Math.min(seg.poly.len - 0.5, seg.poly.len - trim + 1.7);
    const p = polyPoint(seg.poly, arc);
    let t = polyTangent(seg.poly, arc);
    if (!atA) t = { x: -t.x, y: -t.y };       // toward the junction
    const n = { x: -t.y, y: t.x };
    const hw = seg.rt.halfWidth - 0.7;
    ctx.strokeStyle = 'rgba(232,230,223,.85)';
    ctx.lineWidth = 0.62;
    ctx.lineCap = 'butt';
    for (let off = -hw + 0.5; off <= hw - 0.4; off += 1.18) {
      ctx.beginPath();
      ctx.moveTo(p.x + n.x * off - t.x * 0.8, p.y + n.y * off - t.y * 0.8);
      ctx.lineTo(p.x + n.x * off + t.x * 0.8, p.y + n.y * off + t.y * 0.8);
      ctx.stroke();
    }
  }

  private drawSignIcon(ctx: CanvasRenderingContext2D, p: V, sign: string, time: number) {
    const blinkOn = (time * 1.4) % 1 < 0.55;
    ctx.save();
    ctx.translate(p.x, p.y);
    if (sign === 'stop') {
      ctx.fillStyle = '#cf3d3d';
      this.octagon(ctx, 1.35); ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 0.22;
      this.octagon(ctx, 1.05); ctx.stroke();
    } else if (sign === 'yield') {
      ctx.fillStyle = '#fff';
      this.triangle(ctx, 1.5); ctx.fill();
      ctx.fillStyle = '#cf3d3d';
      this.triangle(ctx, 1.1); ctx.fill();
      ctx.fillStyle = '#fff';
      this.triangle(ctx, 0.55); ctx.fill();
    } else if (sign === 'blinkY' || sign === 'blinkR') {
      ctx.fillStyle = '#22252b';
      ctx.beginPath(); ctx.arc(0, 0, 1.3, 0, 7); ctx.fill();
      if (blinkOn) {
        ctx.fillStyle = sign === 'blinkY' ? '#ffc233' : '#ff5043';
        ctx.beginPath(); ctx.arc(0, 0, 0.8, 0, 7); ctx.fill();
        ctx.shadowColor = ctx.fillStyle as string;
        ctx.shadowBlur = 4;
        ctx.beginPath(); ctx.arc(0, 0, 0.8, 0, 7); ctx.fill();
        ctx.shadowBlur = 0;
      }
    }
    ctx.restore();
  }

  private octagon(ctx: CanvasRenderingContext2D, r: number) {
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      const x = Math.cos(a) * r, y = Math.sin(a) * r;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.closePath();
  }

  private triangle(ctx: CanvasRenderingContext2D, r: number) {
    ctx.beginPath();
    ctx.moveTo(0, r);
    ctx.lineTo(-r * 0.95, -r * 0.7);
    ctx.lineTo(r * 0.95, -r * 0.7);
    ctx.closePath();
  }

  /* ---------------- cars ---------------- */

  private drawCar(ctx: CanvasRenderingContext2D, car: Car, time: number) {
    const { pos, hdg } = car;
    const W = car.width;

    if (car.kind === 'semi') {
      this.drawSemi(ctx, car, time);
      return;
    }

    ctx.save();
    ctx.translate(pos.x, pos.y);
    ctx.rotate(Math.atan2(hdg.y, hdg.x));

    const L = car.len;
    // shadow
    ctx.fillStyle = 'rgba(0,0,0,.22)';
    this.rrect(ctx, -L / 2 + 0.3, -W / 2 + 0.35, L, W, 0.7);
    ctx.fill();
    // body
    ctx.fillStyle = CAR_COLORS[car.colorIdx % CAR_COLORS.length];
    this.rrect(ctx, -L / 2, -W / 2, L, W, 0.7);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.3)';
    ctx.lineWidth = 0.14;
    ctx.stroke();

    if (car.kind === 'pickup') {
      // cab forward, open bed at the rear
      ctx.fillStyle = 'rgba(28,32,40,.75)';
      this.rrect(ctx, L * 0.05, -W / 2 + 0.28, L * 0.26, W - 0.56, 0.25);
      ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,.28)';
      this.rrect(ctx, -L / 2 + 0.25, -W / 2 + 0.3, L * 0.4, W - 0.6, 0.18);
      ctx.fill();
    } else {
      // windshield + rear window (suv gets a longer roof)
      const roof = car.kind === 'suv' ? 0.34 : 0.28;
      ctx.fillStyle = 'rgba(28,32,40,.75)';
      this.rrect(ctx, L * 0.08, -W / 2 + 0.28, L * roof, W - 0.56, 0.25);
      ctx.fill();
      this.rrect(ctx, -L * 0.42, -W / 2 + 0.32, L * 0.2, W - 0.64, 0.2);
      ctx.fill();
    }

    this.drawLights(ctx, car, time, L, W);
    ctx.restore();
  }

  private drawSemi(ctx: CanvasRenderingContext2D, car: Car, time: number) {
    const W = car.width;
    const cabLen = 4.8;
    const trailerLen = car.len - cabLen + 0.8;   // slight overlap at the hitch
    const rh = car.rearHdg;
    // hitch sits behind the cab along the cab heading
    const hitch = {
      x: car.pos.x - car.hdg.x * (cabLen - 0.8),
      y: car.pos.y - car.hdg.y * (cabLen - 0.8),
    };

    // trailer (drawn first, under the cab)
    ctx.save();
    ctx.translate(hitch.x, hitch.y);
    ctx.rotate(Math.atan2(rh.y, rh.x));
    ctx.fillStyle = 'rgba(0,0,0,.22)';
    this.rrect(ctx, -trailerLen + 0.3, -W / 2 + 0.35, trailerLen, W, 0.4);
    ctx.fill();
    ctx.fillStyle = '#d6d3cb';
    this.rrect(ctx, -trailerLen, -W / 2, trailerLen, W, 0.4);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.35)';
    ctx.lineWidth = 0.16;
    ctx.stroke();
    // roof ribs
    ctx.strokeStyle = 'rgba(0,0,0,.12)';
    ctx.lineWidth = 0.12;
    for (let i = 1; i < 5; i++) {
      const x = -trailerLen * (i / 5);
      ctx.beginPath(); ctx.moveTo(x, -W / 2 + 0.2); ctx.lineTo(x, W / 2 - 0.2); ctx.stroke();
    }
    if (car.braking) {
      ctx.fillStyle = '#ff4a3d';
      ctx.fillRect(-trailerLen - 0.08, -W / 2 + 0.2, 0.32, 0.55);
      ctx.fillRect(-trailerLen - 0.08, W / 2 - 0.75, 0.32, 0.55);
    }
    if (car.blinker && (time * 2.4) % 1 < 0.5) {
      const y = car.blinker === 'L' ? -W / 2 - 0.05 : W / 2 + 0.05;
      ctx.fillStyle = '#ffb734';
      ctx.beginPath(); ctx.arc(-trailerLen + 0.5, y, 0.34, 0, 7); ctx.fill();
    }
    ctx.restore();

    // cab
    ctx.save();
    ctx.translate(car.pos.x, car.pos.y);
    ctx.rotate(Math.atan2(car.hdg.y, car.hdg.x));
    ctx.fillStyle = 'rgba(0,0,0,.22)';
    this.rrect(ctx, -cabLen / 2 + 0.3, -W / 2 + 0.35, cabLen, W, 0.6);
    ctx.fill();
    ctx.fillStyle = CAR_COLORS[car.colorIdx % CAR_COLORS.length];
    this.rrect(ctx, -cabLen / 2, -W / 2, cabLen, W, 0.6);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.3)';
    ctx.lineWidth = 0.14;
    ctx.stroke();
    ctx.fillStyle = 'rgba(28,32,40,.78)';
    this.rrect(ctx, cabLen * 0.06, -W / 2 + 0.26, cabLen * 0.3, W - 0.52, 0.22);
    ctx.fill();
    if (car.blinker && (time * 2.4) % 1 < 0.5) {
      const y = car.blinker === 'L' ? -W / 2 - 0.05 : W / 2 + 0.05;
      ctx.fillStyle = '#ffb734';
      ctx.beginPath(); ctx.arc(cabLen / 2 - 0.4, y, 0.34, 0, 7); ctx.fill();
    }
    ctx.restore();
  }

  private drawLights(ctx: CanvasRenderingContext2D, car: Car, time: number, L: number, W: number) {
    if (car.braking) {
      ctx.fillStyle = '#ff4a3d';
      ctx.fillRect(-L / 2 - 0.08, -W / 2 + 0.18, 0.3, 0.5);
      ctx.fillRect(-L / 2 - 0.08, W / 2 - 0.68, 0.3, 0.5);
    }
    if (car.blinker && (time * 2.4) % 1 < 0.5) {
      const y = car.blinker === 'L' ? -W / 2 - 0.05 : W / 2 + 0.05;
      ctx.fillStyle = '#ffb734';
      ctx.beginPath(); ctx.arc(L / 2 - 0.5, y, 0.32, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.arc(-L / 2 + 0.5, y, 0.32, 0, 7); ctx.fill();
    }
  }

  private rrect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ---------------- overlays ---------------- */

  private drawHeatmap(ctx: CanvasRenderingContext2D, net: Network, sim: Sim) {
    for (const lane of net.lanesById.values()) {
      const occ = sim.occOf(lane.id);
      if (occ < 0.04) continue;
      const t = clamp(occ, 0, 1);
      const r = Math.round(70 + 185 * t);
      const g = Math.round(200 - 150 * t);
      this.strokePoly(ctx, lane.poly.pts, 2.2, `rgba(${r},${g},60,${0.25 + 0.45 * t})`);
    }
  }

  private drawOverlays(ctx: CanvasRenderingContext2D, net: Network, tools: Tools, time: number) {
    const zoom = this.cam.zoom;

    // gates
    for (const node of net.nodes.values()) {
      if (!node.gate) continue;
      const seg = net.segs.get(node.segs[0]);
      let dir = { x: 1, y: 0 };
      if (seg) {
        const atA = seg.a === node.id;
        dir = polyTangent(seg.poly, atA ? 0 : seg.poly.len);
        if (!atA) dir = { x: -dir.x, y: -dir.y }; // pointing into the map
      }
      ctx.save();
      ctx.translate(node.pos.x, node.pos.y);
      ctx.rotate(Math.atan2(dir.y, dir.x));
      ctx.fillStyle = '#1d2026';
      ctx.beginPath(); ctx.arc(0, 0, 4.4, 0, 7); ctx.fill();
      ctx.strokeStyle = '#f6c945';
      ctx.lineWidth = 0.7;
      ctx.setLineDash([2.2, 1.6]);
      ctx.beginPath(); ctx.arc(0, 0, 4.4, 0, 7); ctx.stroke();
      ctx.setLineDash([]);
      // double chevron
      ctx.strokeStyle = '#f6c945';
      ctx.lineWidth = 0.8;
      ctx.lineCap = 'round';
      for (const off of [-1.1, 0.7]) {
        ctx.beginPath();
        ctx.moveTo(off - 0.9, -1.5);
        ctx.lineTo(off + 0.9, 0);
        ctx.lineTo(off - 0.9, 1.5);
        ctx.stroke();
      }
      ctx.restore();
    }

    // selection highlight
    if (tools.selection) {
      ctx.strokeStyle = 'rgba(246,201,69,.85)';
      if (tools.selection.kind === 'seg') {
        const seg = net.segs.get(tools.selection.id);
        if (seg) this.strokePoly(ctx, seg.poly.pts, seg.rt.halfWidth * 2 + 1.4, 'rgba(246,201,69,.28)');
      } else {
        const node = net.nodes.get(tools.selection.id);
        if (node) {
          ctx.lineWidth = 0.8;
          ctx.beginPath();
          ctx.arc(node.pos.x, node.pos.y, Math.max(node.junctionR, 3.4) + 1.2, 0, 7);
          ctx.stroke();
        }
      }
    }

    // grid dots while drawing
    if (tools.tool === 'draw' && tools.snapMode === 'grid' && zoom > 1.1) {
      ctx.fillStyle = 'rgba(20,24,18,.32)';
      const view = this.viewBounds();
      const x0 = Math.max(0, Math.floor(view.x0 / 16) * 16);
      const y0 = Math.max(0, Math.floor(view.y0 / 16) * 16);
      for (let x = x0; x <= Math.min(WORLD_W, view.x1); x += 16) {
        for (let y = y0; y <= Math.min(WORLD_H, view.y1); y += 16) {
          ctx.fillRect(x - 0.3, y - 0.3, 0.6, 0.6);
        }
      }
    }

    // edit handles
    if (tools.tool === 'edit') {
      for (const node of net.nodes.values()) {
        const r = node.isJunction ? 2.4 : 1.7;
        const hovered = tools.hoverNode === node.id;
        const dragging = tools.draggingNode === node.id;
        ctx.fillStyle = dragging ? '#f6c945' : hovered ? '#ffffff' : 'rgba(255,255,255,.85)';
        ctx.strokeStyle = 'rgba(20,22,27,.85)';
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.arc(node.pos.x, node.pos.y, hovered || dragging ? r + 0.6 : r, 0, 7);
        ctx.fill(); ctx.stroke();
      }
      // hint: clicking a segment inserts a node
      if (tools.hoverSeg !== null && tools.hoverNode === null) {
        const seg = net.segs.get(tools.hoverSeg);
        if (seg) {
          const pr = projectOnSeg(seg, tools.cursor);
          ctx.fillStyle = 'rgba(246,201,69,.9)';
          ctx.beginPath(); ctx.arc(pr.x, pr.y, 1.6, 0, 7); ctx.fill();
        }
      }
    }

    // hover glow for select/bulldoze
    if ((tools.tool === 'select' || tools.tool === 'bulldoze' || tools.tool === 'gate') && tools.hoverNode !== null) {
      const node = net.nodes.get(tools.hoverNode);
      if (node) {
        ctx.strokeStyle = tools.tool === 'bulldoze' ? 'rgba(229,72,77,.8)' : 'rgba(255,255,255,.7)';
        ctx.lineWidth = 0.7;
        ctx.beginPath();
        ctx.arc(node.pos.x, node.pos.y, Math.max(node.junctionR, 3) + 0.8, 0, 7);
        ctx.stroke();
      }
    } else if ((tools.tool === 'select' || tools.tool === 'bulldoze' || tools.tool === 'upgrade') && tools.hoverSeg !== null) {
      const seg = net.segs.get(tools.hoverSeg);
      if (seg) {
        const col = tools.tool === 'bulldoze' ? 'rgba(229,72,77,.25)'
          : tools.tool === 'upgrade'
            ? (seg.type === tools.roadTypeId ? 'rgba(255,255,255,.10)' : 'rgba(246,201,69,.3)')
            : 'rgba(255,255,255,.16)';
        const w = tools.tool === 'upgrade'
          ? Math.max(seg.rt.halfWidth, roadType(tools.roadTypeId).halfWidth) * 2 + 1
          : seg.rt.halfWidth * 2 + 1;
        this.strokePoly(ctx, seg.poly.pts, w, col);
      }
    }

    // draw preview
    if (tools.tool === 'draw') {
      const rtHalf = roadType(tools.roadTypeId).halfWidth;
      if (tools.preview?.guide) {
        // curve mode, picking the angle handle: thin guide ray only
        this.strokePoly(ctx, tools.preview.pts, 0.5, 'rgba(246,201,69,.9)', [2.5, 2]);
        const e = tools.preview.pts[tools.preview.pts.length - 1];
        ctx.fillStyle = '#f6c945';
        ctx.beginPath(); ctx.arc(e.x, e.y, 1.2, 0, 7); ctx.fill();
      } else if (tools.preview) {
        const ok = tools.preview.ok;
        this.strokePoly(ctx, tools.preview.pts, rtHalf * 2, ok ? 'rgba(255,255,255,.30)' : 'rgba(229,72,77,.35)');
        this.strokePoly(ctx, tools.preview.pts, 0.5, ok ? 'rgba(255,255,255,.8)' : 'rgba(229,72,77,.9)', [2, 2]);
        for (const c of tools.preview.crossings) {
          ctx.strokeStyle = '#f6c945';
          ctx.lineWidth = 0.6;
          ctx.beginPath(); ctx.arc(c.x, c.y, 2.4, 0, 7); ctx.stroke();
        }
      }
      if (tools.curveCtrl && tools.anchor) {
        // locked angle handle
        ctx.strokeStyle = 'rgba(246,201,69,.55)';
        ctx.lineWidth = 0.35;
        ctx.setLineDash([1.6, 1.6]);
        ctx.beginPath();
        ctx.moveTo(tools.anchor.pos.x, tools.anchor.pos.y);
        ctx.lineTo(tools.curveCtrl.x, tools.curveCtrl.y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#f6c945';
        ctx.save();
        ctx.translate(tools.curveCtrl.x, tools.curveCtrl.y);
        ctx.rotate(Math.PI / 4);
        ctx.fillRect(-1.1, -1.1, 2.2, 2.2);
        ctx.restore();
      }
      if (tools.anchor) {
        ctx.fillStyle = '#f6c945';
        ctx.beginPath(); ctx.arc(tools.anchor.pos.x, tools.anchor.pos.y, 1.6, 0, 7); ctx.fill();
      }
      // snap cursor
      const snap = tools.snap(tools.cursor, true);
      ctx.strokeStyle = snap.node !== undefined ? '#f6c945' : snap.seg ? '#7fb2d4' : 'rgba(255,255,255,.65)';
      ctx.lineWidth = 0.45;
      ctx.beginPath(); ctx.arc(snap.pos.x, snap.pos.y, 2, 0, 7); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(snap.pos.x - 3, snap.pos.y); ctx.lineTo(snap.pos.x + 3, snap.pos.y);
      ctx.moveTo(snap.pos.x, snap.pos.y - 3); ctx.lineTo(snap.pos.x, snap.pos.y + 3);
      ctx.stroke();
    }
  }

  private viewBounds() {
    const r = this.canvas.getBoundingClientRect();
    const tl = this.cam.toWorld(0, 0);
    const br = this.cam.toWorld(r.width, r.height);
    return { x0: tl.x, y0: tl.y, x1: br.x, y1: br.y };
  }
}

function projectOnSeg(seg: Segment, q: V): V {
  let best = seg.poly.pts[0];
  let bd = Infinity;
  for (let s = 0; s <= seg.poly.len; s += 2) {
    const p = polyPoint(seg.poly, s);
    const d = (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}
