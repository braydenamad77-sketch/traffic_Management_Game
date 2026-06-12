// Canvas renderer: terrain (cached offscreen), roads with lane markings,
// junctions, signals/signs, cars, editor overlays.

import { Camera } from './camera';
import { Network, Segment, RNode, Lane, Turn } from './network';
import { Sim, Car } from './sim';
import { Tools } from './tools';
import { TerrainMap, WORLD_W, WORLD_H, inWater } from './terrain';
import { LANE_W, roadType } from './roadTypes';
import { buildMarkingPlan, MarkingStroke } from './markings';
import { V, Poly, subPoly, makePoly, polyPoint, polyTangent, projectOnPoly, norm, sub, clamp } from './vec';
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

interface StopBarGeom {
  c: V;
  d: V;
  tIn: V;
  lo: number;
  hi: number;
}

const CAR_COLORS = [
  '#c94f43', '#3f6fb5', '#d9d4c8', '#494e57', '#7a9e63',
  '#b08fc4', '#d98e32', '#5fa8a0', '#8a4f3d', '#e3c84f',
];

export type RenderIdMode = 'nodes' | 'segments' | 'lanes' | 'all';

export interface RenderDebugOptions {
  grid?: boolean;
  ids?: RenderIdMode | null;
  selection?: SelectionRef | null;
}

export interface SelectionRef {
  kind: 'node' | 'seg';
  id: number;
}

interface RenderCanvas {
  width: number;
  height: number;
  getContext(type: '2d'): CanvasRenderingContext2D | null;
  getBoundingClientRect(): { width: number; height: number };
}

interface RenderOptions {
  createCanvas?: (width: number, height: number) => RenderCanvas;
  devicePixelRatio?: number;
}

export class Renderer {
  private terrainCache: RenderCanvas | null = null;
  private terrainCacheId = '';
  private createCanvas: (width: number, height: number) => RenderCanvas;
  private devicePixelRatio?: number;

  constructor(
    private canvas: RenderCanvas,
    private cam: Camera,
    opts: RenderOptions = {},
  ) {
    this.createCanvas = opts.createCanvas ?? ((width, height) => {
      const cv = document.createElement('canvas');
      cv.width = width;
      cv.height = height;
      return cv;
    });
    this.devicePixelRatio = opts.devicePixelRatio;
  }

  render(
    net: Network,
    sim: Sim,
    tools: Tools | null,
    map: TerrainMap,
    heatmap: boolean,
    time: number,
    debug: RenderDebugOptions = {},
  ) {
    const ctx = this.canvas.getContext('2d')!;
    const dpr = this.devicePixelRatio ?? (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);
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

    // global passes. Pavement owns the dark outline/asphalt layers; markings
    // are planned separately and drawn after junction covers, so they are not
    // accidentally erased by later asphalt patches.
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
    // pass B: asphalt and junction covers
    for (const ch of net.chains) this.strokePoly(ctx, ch.poly.pts, ch.rt.halfWidth * 2, COL.asphalt);
    for (const g of jgeoms.values()) this.fillJunctionGeom(ctx, g);

    // pass C: planned markings, plus corner edge sweeps from the same junction
    // geometry that produced the pavement boundary.
    const markings = buildMarkingPlan(net);
    for (const m of markings.laneBands) this.drawMarkingStroke(ctx, m);
    for (const m of markings.center) this.drawMarkingStroke(ctx, m);
    for (const m of markings.laneDividers) this.drawMarkingStroke(ctx, m);
    for (const m of markings.edge) this.drawMarkingStroke(ctx, m);

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

    this.drawCenterTurnLaneArrows(ctx, net);
    for (const seg of net.segs.values()) this.drawTurnPockets(ctx, seg, net);
    for (const node of net.nodes.values()) this.drawJunctionDressing(ctx, node, net, sim.signals, time);

    if (heatmap) this.drawHeatmap(ctx, net, sim);

    for (const car of sim.cars) this.drawCar(ctx, car, time);

    if (debug.grid) this.drawDebugGrid(ctx);
    if (tools) this.drawOverlays(ctx, net, tools, time);
    if (debug.ids) this.drawDebugIds(ctx, net, debug.ids);
    if (debug.selection) this.drawDebugSelection(ctx, net, debug.selection);
    this.drawWorldBorder(ctx);
  }

  private drawMarkingStroke(ctx: CanvasRenderingContext2D, m: MarkingStroke) {
    const color = m.color === 'white' || m.color === 'yellow' ? COL[m.color] : m.color;
    this.strokePoly(ctx, m.pts, m.width, color, m.dash, m.cap ?? 'round');
  }

  /* ---------------- terrain ---------------- */

  private drawTerrain(ctx: CanvasRenderingContext2D, map: TerrainMap) {
    if (!this.terrainCache || this.terrainCacheId !== map.id) {
      this.terrainCacheId = map.id;
      const sc = 3;
      const cv = this.createCanvas(WORLD_W * sc, WORLD_H * sc);
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
    ctx.drawImage(this.terrainCache as unknown as CanvasImageSource, 0, 0, WORLD_W, WORLD_H);
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
    interface AG { sid: number; c: V; tIn: V; away: V; hw: number; ang: number; }
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
        sid,
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
        const isThroughPair = !!through &&
          ((through[0] === A.sid && through[1] === B.sid) ||
           (through[0] === B.sid && through[1] === A.sid));
        if (gap > 2.3 && isThroughPair) continue; // the through-side edge stays on the road chain
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

  /** center turn-lane arrows — drawn above junction discs */
  private drawCenterTurnLaneArrows(ctx: CanvasRenderingContext2D, net: Network) {
    if (this.cam.zoom <= 1.05) return;
    for (const ch of net.chains) {
      if (!ch.rt.centerTurn || ch.poly.len < 30) continue;
      const step = 34;
      for (let s = 14; s < ch.poly.len - 12; s += step) {
        const p = polyPoint(ch.poly, s);
        const t = polyTangent(ch.poly, s);
        this.drawLaneUseGlyphAt(ctx, p, t, ['L']);
        if (s + step * 0.45 < ch.poly.len - 12) {
          const q = polyPoint(ch.poly, s + step * 0.45);
          const u = polyTangent(ch.poly, s + step * 0.45);
          this.drawLaneUseGlyphAt(ctx, q, { x: -u.x, y: -u.y }, ['L']);
        }
      }
    }
  }

  private drawTurnPockets(ctx: CanvasRenderingContext2D, seg: Segment, net: Network) {
    if (!seg.rt.centerTurn || this.cam.zoom <= 1.6) return;
    for (const lane of seg.lanes) {
      if (lane.def.kind !== 'turn' || lane.poly.len < 12) continue;
      const endNode = net.nodes.get(lane.def.dir === 1 ? seg.b : seg.a)!;
      if (!endNode.isJunction) continue;
      this.drawTurnGlyph(ctx, lane, 'L');
    }
  }

  private drawTurnGlyph(ctx: CanvasRenderingContext2D, lane: Lane, turn: Turn) {
    this.drawLaneUseGlyph(ctx, lane, [turn]);
  }

  private arrowHead(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, size = 0.44) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(size, 0);
    ctx.lineTo(-size * 0.45, -size * 0.58);
    ctx.lineTo(-size * 0.24, 0);
    ctx.lineTo(-size * 0.45, size * 0.58);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  private drawLaneUseGlyph(ctx: CanvasRenderingContext2D, lane: Lane, turns: Turn[]) {
    if (!turns.length || lane.poly.len < 8) return;
    const s = Math.max(2, lane.poly.len - 4.2);
    const p = polyPoint(lane.poly, s);
    const t = polyTangent(lane.poly, s);
    this.drawLaneUseGlyphAt(ctx, p, t, turns);
  }

  private drawLaneUseGlyphAt(ctx: CanvasRenderingContext2D, p: V, heading: V, turns: Turn[]) {
    if (!turns.length) return;
    const unique = new Set(turns);

    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(Math.atan2(heading.y, heading.x));
    ctx.strokeStyle = 'rgba(232,230,223,.92)';
    ctx.fillStyle = 'rgba(232,230,223,.92)';
    ctx.lineWidth = 0.26;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(-1.25, 0);
    ctx.lineTo(0.18, 0);
    if (unique.has('S')) {
      ctx.moveTo(0.14, 0);
      ctx.lineTo(1.35, 0);
    }
    if (unique.has('L')) {
      ctx.moveTo(0.03, 0);
      ctx.quadraticCurveTo(0.7, -0.03, 0.76, -0.58);
    }
    if (unique.has('R')) {
      ctx.moveTo(0.03, 0);
      ctx.quadraticCurveTo(0.7, 0.03, 0.76, 0.58);
    }
    ctx.stroke();

    if (unique.has('S')) this.arrowHead(ctx, 1.35, 0, 0);
    if (unique.has('L')) this.arrowHead(ctx, 0.76, -0.58, -Math.PI / 2);
    if (unique.has('R')) this.arrowHead(ctx, 0.76, 0.58, Math.PI / 2);
    ctx.restore();
  }

  /* ---------------- junction dressing: stop lines, signals, signs ---------------- */

  private stopBarGeom(node: RNode, net: Network, ap: RNode['approaches'][number]): StopBarGeom | null {
    const lanes = ap.inLanes;
    if (!lanes.length) return null;
    const seg = net.segs.get(ap.seg);
    if (!seg) return null;

    const markTrim = node.markTrim.get(ap.seg) ?? node.trim.get(ap.seg) ?? 0;
    const approach = net.approachPoly(node.id, ap.seg, Math.max(10, markTrim + 4));
    if (!approach || approach.len < 1) return null;

    // approachPoly walks outward from the junction. The stop bar belongs just
    // outside the measured mouth, not at the capped vehicle connector endpoint.
    const s = clamp(markTrim + 0.75, 0.8, Math.max(0.8, approach.len - 0.3));
    const c = polyPoint(approach, s);
    const tOut = polyTangent(approach, s);
    const tIn = { x: -tOut.x, y: -tOut.y };
    const d = { x: -tIn.y, y: tIn.x };

    const roadLo = -seg.rt.halfWidth + 0.38;
    const roadHi = seg.rt.halfWidth - 0.38;
    const laneLo = Math.min(...lanes.map(l => l.offTravel - LANE_W / 2));
    const laneHi = Math.max(...lanes.map(l => l.offTravel + LANE_W / 2));
    let lo = Math.max(roadLo, laneLo);
    let hi = Math.min(roadHi, laneHi);

    if (seg.rt.oneWay) {
      lo = roadLo;
      hi = roadHi;
    } else if ((laneLo + laneHi) / 2 >= 0) {
      lo = Math.max(roadLo, Math.min(0, laneLo));
      hi = roadHi;
    } else {
      lo = roadLo;
      hi = Math.min(roadHi, Math.max(0, laneHi));
    }
    if (hi - lo < 1) {
      const mid = (lo + hi) / 2;
      lo = Math.max(roadLo, mid - 0.5);
      hi = Math.min(roadHi, mid + 0.5);
    }

    return { c, d, tIn, lo, hi };
  }

  private drawJunctionDressing(ctx: CanvasRenderingContext2D, node: RNode, net: Network, signals: SignalSystem, time: number) {
    if (!node.isJunction) return;
    const kind = node.control.kind;
    const isLights = node.control.kind === 'lights';
    const through = node.markThrough;

    // left-turn guide lines: the AI's actual turning paths, made visible
    if (node.showTurnHelpers || isLights || !through) {
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
      const stop = this.stopBarGeom(node, net, ap);
      if (!stop) continue;
      const { c, d, lo, hi } = stop;
      const sign = net.signFor(node, ap.seg);
      const isThroughAp = !!through && (ap.seg === through[0] || ap.seg === through[1]);

      // stop / yield bar: controlled approaches get the full bar; approaches
      // that must yield by geometry (everything at a bare box, branches at a
      // through road) get a lighter one
      const bar = (width: number, dash?: number[]) => {
        ctx.strokeStyle = COL.white;
        ctx.lineWidth = width;
        ctx.lineCap = 'butt';
        if (dash) ctx.setLineDash(dash);
        ctx.beginPath();
        ctx.moveTo(c.x + d.x * lo, c.y + d.y * lo);
        ctx.lineTo(c.x + d.x * hi, c.y + d.y * hi);
        ctx.stroke();
        if (dash) ctx.setLineDash([]);
      };
      if (isLights || sign === 'stop' || sign === 'blinkR') bar(0.7);
      else if (sign === 'yield' || sign === 'blinkY') bar(0.55, [1.1, 1.1]);
      else if (kind === 'open') bar(0.5);
      else if (!isThroughAp) bar(0.5);

      // crosswalk at signalized approaches, just beyond the stop bar
      if (isLights) this.drawCrosswalk(ctx, stop);

      // lane-use arrows come from actual lane connectors, so they follow every
      // generated intersection shape and road type.
      if (this.cam.zoom > 1.35) {
        for (const lane of lanes) {
          const present = new Set(net.connsFrom(lane.id).map(cc => cc.turn));
          const turns = (['L', 'S', 'R'] as Turn[]).filter(t => present.has(t));
          const lateral = clamp(lane.offTravel, lo + 0.7, hi - 0.7);
          const arrowPos = {
            x: c.x + d.x * lateral - stop.tIn.x * 3.35,
            y: c.y + d.y * lateral - stop.tIn.y * 3.35,
          };
          this.drawLaneUseGlyphAt(ctx, arrowPos, stop.tIn, turns);
        }
      }

      // signal head / sign icon at right corner of the approach
      const shoulder = {
        x: c.x + d.x * (hi + 0.35),
        y: c.y + d.y * (hi + 0.35),
      };
      const iconPos = {
        x: c.x + d.x * (hi + 2.15) - stop.tIn.x * 0.2,
        y: c.y + d.y * (hi + 2.15) - stop.tIn.y * 0.2,
      };
      if (isLights) {
        const light = signals.lightForApproach(node, ap.seg);
        this.drawSignalIcon(ctx, shoulder, iconPos, light);
      } else if (sign !== 'none') {
        this.drawSignIcon(ctx, shoulder, iconPos, sign, time);
      }
    }
  }

  /** continental crosswalk bars across the full road width, junction-side
      of the stop bar */
  private drawCrosswalk(ctx: CanvasRenderingContext2D, stop: StopBarGeom) {
    const p = {
      x: stop.c.x + stop.tIn.x * 1.7,
      y: stop.c.y + stop.tIn.y * 1.7,
    };
    const t = stop.tIn;
    const n = stop.d;
    ctx.strokeStyle = 'rgba(232,230,223,.85)';
    ctx.lineWidth = 0.62;
    ctx.lineCap = 'butt';
    for (let off = stop.lo + 0.5; off <= stop.hi - 0.4; off += 1.18) {
      ctx.beginPath();
      ctx.moveTo(p.x + n.x * off - t.x * 0.8, p.y + n.y * off - t.y * 0.8);
      ctx.lineTo(p.x + n.x * off + t.x * 0.8, p.y + n.y * off + t.y * 0.8);
      ctx.stroke();
    }
  }

  private drawControlPost(ctx: CanvasRenderingContext2D, shoulder: V, p: V) {
    ctx.strokeStyle = 'rgba(28,32,40,.72)';
    ctx.lineWidth = 0.18;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(shoulder.x, shoulder.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    ctx.fillStyle = 'rgba(28,32,40,.75)';
    ctx.beginPath();
    ctx.arc(shoulder.x, shoulder.y, 0.18, 0, 7);
    ctx.fill();
  }

  private drawSignalIcon(ctx: CanvasRenderingContext2D, shoulder: V, p: V, light: string) {
    this.drawControlPost(ctx, shoulder, p);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.fillStyle = 'rgba(0,0,0,.22)';
    this.rrect(ctx, -0.95 + 0.18, -1.55 + 0.2, 1.9, 3.1, 0.35);
    ctx.fill();
    ctx.fillStyle = '#22252b';
    this.rrect(ctx, -0.95, -1.55, 1.9, 3.1, 0.35);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.22)';
    ctx.lineWidth = 0.12;
    ctx.stroke();
    const lamps: [string, string, number][] = [
      ['red', '#ff5043', -0.85],
      ['yellow', '#ffc233', 0],
      ['green', '#3fd06a', 0.85],
    ];
    for (const [kind, color, y] of lamps) {
      ctx.fillStyle = kind === light ? color : 'rgba(130,138,150,.32)';
      ctx.beginPath();
      ctx.arc(0, y, 0.38, 0, 7);
      ctx.fill();
      if (kind === light) {
        ctx.shadowColor = color;
        ctx.shadowBlur = 4;
        ctx.beginPath();
        ctx.arc(0, y, 0.38, 0, 7);
        ctx.fill();
        ctx.shadowBlur = 0;
      }
    }
    ctx.restore();
  }

  private drawSignIcon(ctx: CanvasRenderingContext2D, shoulder: V, p: V, sign: string, time: number) {
    const blinkOn = (time * 1.4) % 1 < 0.55;
    this.drawControlPost(ctx, shoulder, p);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.fillStyle = 'rgba(0,0,0,.22)';
    ctx.beginPath();
    if (sign === 'stop') {
      ctx.save(); ctx.translate(0.16, 0.18); this.octagon(ctx, 1.28); ctx.fill(); ctx.restore();
      ctx.fillStyle = '#cf3d3d';
      this.octagon(ctx, 1.28); ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 0.18;
      this.octagon(ctx, 1.04); ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = '700 0.48px Overpass, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('STOP', 0, 0.03);
    } else if (sign === 'yield') {
      ctx.save(); ctx.translate(0.16, 0.18); this.triangle(ctx, 1.42); ctx.fill(); ctx.restore();
      ctx.fillStyle = '#fff';
      this.triangle(ctx, 1.42); ctx.fill();
      ctx.fillStyle = '#cf3d3d';
      this.triangle(ctx, 1.08); ctx.fill();
      ctx.fillStyle = '#fff';
      this.triangle(ctx, 0.55); ctx.fill();
    } else if (sign === 'blinkY' || sign === 'blinkR') {
      ctx.save(); ctx.translate(0.14, 0.16); this.rrect(ctx, -0.95, -0.95, 1.9, 1.9, 0.35); ctx.fill(); ctx.restore();
      ctx.fillStyle = '#22252b';
      this.rrect(ctx, -0.95, -0.95, 1.9, 1.9, 0.35);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.2)';
      ctx.lineWidth = 0.12;
      ctx.stroke();
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

  private drawDebugGrid(ctx: CanvasRenderingContext2D) {
    const view = this.viewBounds();
    ctx.save();
    ctx.strokeStyle = 'rgba(246,201,69,.22)';
    ctx.lineWidth = 0.12;
    ctx.setLineDash([1, 3]);
    const x0 = Math.max(0, Math.floor(view.x0 / 16) * 16);
    const y0 = Math.max(0, Math.floor(view.y0 / 16) * 16);
    for (let x = x0; x <= Math.min(WORLD_W, view.x1); x += 16) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, WORLD_H);
      ctx.stroke();
    }
    for (let y = y0; y <= Math.min(WORLD_H, view.y1); y += 16) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(WORLD_W, y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();
  }

  private drawDebugIds(ctx: CanvasRenderingContext2D, net: Network, mode: RenderIdMode) {
    ctx.save();
    ctx.font = '5px Overpass Mono, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 0.9;
    const label = (text: string, p: V, color: string) => {
      ctx.strokeStyle = 'rgba(16,18,22,.85)';
      ctx.fillStyle = color;
      ctx.strokeText(text, p.x, p.y);
      ctx.fillText(text, p.x, p.y);
    };

    if (mode === 'nodes' || mode === 'all') {
      for (const node of net.nodes.values()) label(`n${node.id}`, node.pos, '#ffe07a');
    }
    if (mode === 'segments' || mode === 'all') {
      for (const seg of net.segs.values()) label(`s${seg.id}`, polyPoint(seg.poly, seg.poly.len / 2), '#dceeff');
    }
    if (mode === 'lanes' || mode === 'all') {
      for (const lane of net.lanesById.values()) label(lane.id, polyPoint(lane.poly, lane.poly.len / 2), '#b6f7c4');
    }
    ctx.restore();
  }

  private drawDebugSelection(ctx: CanvasRenderingContext2D, net: Network, selection: SelectionRef) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,232,112,.95)';
    ctx.fillStyle = 'rgba(255,232,112,.18)';
    if (selection.kind === 'node') {
      const node = net.nodes.get(selection.id);
      if (node) {
        const r = Math.max(node.junctionR, 4.5) + 2;
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.arc(node.pos.x, node.pos.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    } else {
      const seg = net.segs.get(selection.id);
      if (seg) this.strokePoly(ctx, seg.poly.pts, seg.rt.halfWidth * 2 + 2.4, 'rgba(255,232,112,.34)');
    }
    ctx.restore();
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
