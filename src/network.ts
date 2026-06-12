// Road network: graph of nodes + spline segments, from which lanes,
// junction geometry and turn connectors are derived. Pure model — no cars,
// no rendering. Rebuild is full but cheap at game scale.

import {
  V, add, sub, mul, norm, dist, perp, dot,
  signedAngle, bezFromTangents, sampleBezT, makePoly, Poly, subPoly,
  offsetPoly, polyIntersections, polyTangent, polyPoint, projectOnPoly, clamp,
} from './vec';
import { roadType, RoadType, LaneDef, VehicleKind } from './roadTypes';

export type NodeId = number;
export type SegId = number;
export type Turn = 'L' | 'S' | 'R';

export type SignKind = 'none' | 'yield' | 'stop' | 'blinkY' | 'blinkR';

export interface Phase { dur: number; green: string[]; }   // movement keys `${segId}|${turn}`

export type Control =
  | { kind: 'open' }
  | { kind: 'signs'; signs: Record<number, SignKind> }
  | { kind: 'lights'; phases: Phase[]; yellow: number };

export interface Gate { rate: number; industrial?: boolean; }   // cars per minute; industrial gates dispatch semis

export interface Lane {
  id: string;
  seg: SegId;
  idx: number;
  def: LaneDef;
  poly: Poly;          // trimmed, in travel direction
  speed: number;
  /** lateral position in travel frame; positive = right of travel */
  offTravel: number;
}

export interface ConflictRef { other: string; sMine: number; sOther: number; merge: boolean; }

export interface Connector {
  id: string;
  node: NodeId;
  from: string;        // lane id
  to: string;
  fromSeg: SegId;
  toSeg: SegId;
  turn: Turn;
  poly: Poly;
  speed: number;
  conflicts: ConflictRef[];
  movement: string;    // `${fromSeg}|${turn}`
}

export interface Approach {
  seg: SegId;
  /** unit heading of traffic arriving at the junction */
  heading: V;
  inLanes: Lane[];     // left -> right
  turns: Partial<Record<Turn, SegId[]>>;
  stopPos: V;          // center of stop line
  stopDir: V;          // along the stop line (right of travel)
}

export interface RNode {
  id: NodeId;
  pos: V;
  segs: SegId[];
  control: Control;
  gate: Gate | null;
  // built:
  trim: Map<SegId, number>;
  /** marking trim: how far the junction visually extends along each approach —
      unlike `trim` this is NOT capped by single-segment length */
  markTrim: Map<SegId, number>;
  conns: Connector[];
  connByFrom: Map<string, Connector[]>;
  approaches: Approach[];
  junctionR: number;
  isJunction: boolean; // degree >= 3 (controllable)
  /** the single through-road pair whose markings continue across this junction */
  markThrough: [SegId, SegId] | null;
}

export interface Segment {
  id: SegId;
  a: NodeId;
  b: NodeId;
  type: string;
  /** posted speed override (u/s); falls back to the road type's default */
  speedLimit: number | null;
  /** vehicle kinds not allowed on this section */
  bans: VehicleKind[];
  // built:
  poly: Poly;          // centerline a -> b
  lanes: Lane[];
  rt: RoadType;
}

export function segSpeed(seg: Segment): number {
  return seg.speedLimit ?? seg.rt.speed;
}

const VIA_TRIM = 0.6;
const TURN_LANE_LEN = 38;

/** A run of same-type segments through degree-2 nodes — rendered as one stroke. */
export interface Chain {
  segs: SegId[];
  poly: Poly;          // concatenated centerline, oriented start -> end
  rt: RoadType;
  aNode: NodeId;       // node at poly start
  bNode: NodeId;       // node at poly end
  aSeg: SegId;
  bSeg: SegId;
}

export class Network {
  nodes = new Map<NodeId, RNode>();
  segs = new Map<SegId, Segment>();
  lanesById = new Map<string, Lane>();
  connsById = new Map<string, Connector>();
  chains: Chain[] = [];
  version = 0;
  private nextNode = 1;
  private nextSeg = 1;

  /* ---------------- topology ops ---------------- */

  addNode(pos: V, id?: NodeId): RNode {
    const nid = id ?? this.nextNode++;
    if (id !== undefined) this.nextNode = Math.max(this.nextNode, id + 1);
    const n: RNode = {
      id: nid, pos: { ...pos }, segs: [], control: { kind: 'open' }, gate: null,
      trim: new Map(), markTrim: new Map(), conns: [], connByFrom: new Map(),
      approaches: [], junctionR: 0, isJunction: false,
      markThrough: null,
    };
    this.nodes.set(nid, n);
    return n;
  }

  addSegment(a: NodeId, b: NodeId, type: string, id?: SegId): Segment | null {
    if (a === b) return null;
    if (this.findSegBetween(a, b)) return null;
    const sid = id ?? this.nextSeg++;
    if (id !== undefined) this.nextSeg = Math.max(this.nextSeg, id + 1);
    const s: Segment = {
      id: sid, a, b, type, speedLimit: null, bans: [],
      poly: makePoly([this.nodes.get(a)!.pos, this.nodes.get(b)!.pos]),
      lanes: [], rt: roadType(type),
    };
    this.segs.set(sid, s);
    this.nodes.get(a)!.segs.push(sid);
    this.nodes.get(b)!.segs.push(sid);
    return s;
  }

  findSegBetween(a: NodeId, b: NodeId): Segment | undefined {
    for (const sid of this.nodes.get(a)?.segs ?? []) {
      const s = this.segs.get(sid)!;
      if ((s.a === a && s.b === b) || (s.a === b && s.b === a)) return s;
    }
    return undefined;
  }

  removeSegment(sid: SegId) {
    const s = this.segs.get(sid);
    if (!s) return;
    this.segs.delete(sid);
    for (const nid of [s.a, s.b]) {
      const n = this.nodes.get(nid)!;
      n.segs = n.segs.filter(x => x !== sid);
      this.sanitizeControl(n);
      if (n.segs.length === 0) this.nodes.delete(nid);
    }
  }

  removeNode(nid: NodeId) {
    const n = this.nodes.get(nid);
    if (!n) return;
    for (const sid of [...n.segs]) this.removeSegment(sid);
    this.nodes.delete(nid);
  }

  /** Split a segment at centerline arc s; returns the new node. */
  splitSegment(sid: SegId, s: number): RNode {
    const seg = this.segs.get(sid)!;
    const pt = polyPoint(seg.poly, s);
    const n = this.addNode(pt);
    const { a, b, type, speedLimit, bans } = seg;
    // detach without orphan cleanup — endpoints get the new halves right away
    this.segs.delete(sid);
    for (const nid of [a, b]) {
      const nd = this.nodes.get(nid)!;
      nd.segs = nd.segs.filter(x => x !== sid);
      this.sanitizeControl(nd);
    }
    for (const half of [this.addSegment(a, n.id, type), this.addSegment(n.id, b, type)]) {
      if (half) { half.speedLimit = speedLimit; half.bans = [...bans]; }
    }
    return n;
  }

  /** Merge a degree-2 node's segments into one if both share a type. */
  dissolveNode(nid: NodeId): boolean {
    const n = this.nodes.get(nid);
    if (!n || n.segs.length !== 2 || n.gate) return false;
    const [s1, s2] = n.segs.map(id => this.segs.get(id)!);
    if (s1.type !== s2.type) return false;
    const o1 = s1.a === nid ? s1.b : s1.a;
    const o2 = s2.a === nid ? s2.b : s2.a;
    if (o1 === o2 || this.findSegBetween(o1, o2)) return false;
    const { speedLimit, bans } = s1;
    this.removeSegment(s1.id);
    this.removeSegment(s2.id);
    const merged = this.addSegment(o1, o2, s1.type);
    if (merged) { merged.speedLimit = speedLimit; merged.bans = [...bans]; }
    this.nodes.delete(nid);
    return true;
  }

  changeSegType(sid: SegId, type: string) {
    const s = this.segs.get(sid);
    if (s) { s.type = type; s.rt = roadType(type); }
  }

  private sanitizeControl(n: RNode) {
    if (n.segs.length < 3 && n.control.kind !== 'open') {
      n.control = { kind: 'open' };  // no ghost lights/signs on shape nodes
    }
    const valid = new Set(n.segs);
    if (n.control.kind === 'signs') {
      for (const k of Object.keys(n.control.signs)) if (!valid.has(+k)) delete n.control.signs[+k];
    } else if (n.control.kind === 'lights') {
      for (const ph of n.control.phases) {
        ph.green = ph.green.filter(mk => valid.has(+mk.split('|')[0]));
      }
      n.control.phases = n.control.phases.filter(p => p.green.length > 0);
      if (n.control.phases.length === 0) n.control = { kind: 'open' };
    }
    if (n.segs.length > 1) n.gate = null;
  }

  /* ---------------- geometry build ---------------- */

  rebuild() {
    // 1. centerline beziers with Catmull-Rom-style continuity at degree-2 nodes
    for (const seg of this.segs.values()) {
      const na = this.nodes.get(seg.a)!, nb = this.nodes.get(seg.b)!;
      const chord = norm(sub(nb.pos, na.pos));
      const t0 = this.endTangent(seg, na, chord);
      const t3 = this.endTangent(seg, nb, chord);
      const bez = bezFromTangents(na.pos, t0, nb.pos, t3);
      const n = clamp(Math.round(dist(na.pos, nb.pos) / 3), 8, 64);
      const samp = sampleBezT(bez, n);
      seg.poly = makePoly(samp.pts, samp.tans);
    }

    // 2. marking continuation FIRST (trims need it to walk through neighbor
    // junctions): only simple unsignalized 3-ways with exactly one mutual
    // through pair carry markings across; anything gnarlier gets a bare box
    for (const node of this.nodes.values()) {
      node.markThrough = null;
      if (node.segs.length < 3 || node.segs.length > 4 || node.control.kind === 'lights') continue;
      const pairs: [SegId, SegId][] = [];
      const seen = new Set<SegId>();
      for (const sid of node.segs) {
        if (seen.has(sid)) continue;
        const seg = this.segs.get(sid)!;
        const p = this.continuation(seg, node);
        if (!p || p.type !== seg.type) continue;
        if (this.continuation(p, node)?.id !== seg.id) continue;
        seen.add(sid); seen.add(p.id);
        pairs.push([sid, p.id]);
      }
      if (pairs.length === 1) node.markThrough = pairs[0];
    }

    // 3. junction trims
    for (const node of this.nodes.values()) {
      node.trim.clear();
      node.markTrim.clear();
      node.isJunction = node.segs.length >= 3;
      const deg = node.segs.length;

      if (deg >= 3) {
        // per-approach trims, MEASURED: walk each approach centerline outward
        // and find where the pavements actually separate — handles curled
        // ramps and any approach shape, unlike an angle formula. The walks
        // pass THROUGH neighbor junctions so close junction pairs (loop
        // ramps!) measure against real pavement, not a truncated stub.
        const segObjs = node.segs.map(id => this.segs.get(id)!);
        const maxHalf = Math.max(...segObjs.map(s => s.rt.halfWidth));
        const base = maxHalf * 1.08 + 1.7;
        const apPolys = node.segs.map(sid => this.approachPoly(node.id, sid, 88, true));
        node.junctionR = base;
        segObjs.forEach((s, i) => {
          let t = base;
          const ap = apPolys[i];
          if (ap) {
            for (let j = 0; j < segObjs.length; j++) {
              if (i === j || !apPolys[j]) continue;
              const clear = s.rt.halfWidth + segObjs[j].rt.halfWidth + 0.9;
              let need = 0;
              const lim = Math.min(84, ap.len - 0.5);
              for (let sa = 2; sa <= lim; sa += 2) {
                need = sa;
                if (projectOnPoly(apPolys[j]!, polyPoint(ap, sa)).d >= clear) break;
              }
              t = Math.max(t, need);
            }
          }
          // markings retreat the full taper; lanes are capped so they exist
          node.markTrim.set(s.id, Math.min(t, 84));
          const laneTrim = Math.min(t, 40, s.poly.len * 0.38);
          node.trim.set(s.id, laneTrim);
          node.junctionR = Math.max(node.junctionR, laneTrim);
        });
        continue;
      }

      let trim = VIA_TRIM;
      if (deg === 1) trim = 0.6;
      else if (deg === 2) {
        const [s1, s2] = node.segs.map(id => this.segs.get(id)!);
        trim = s1.type === s2.type ? VIA_TRIM : Math.max(s1.rt.halfWidth, s2.rt.halfWidth) * 0.6 + 1.2;
      }
      node.junctionR = trim;
      for (const sid of node.segs) {
        const seg = this.segs.get(sid)!;
        const t = Math.min(trim, seg.poly.len * 0.38);
        node.trim.set(sid, t);
        node.markTrim.set(sid, t);
      }
    }

    // 4. lanes
    this.lanesById.clear();
    for (const seg of this.segs.values()) {
      seg.lanes = [];
      const trimA = this.nodes.get(seg.a)!.trim.get(seg.id)!;
      const trimB = this.nodes.get(seg.b)!.trim.get(seg.id)!;
      seg.rt.lanes.forEach((def, idx) => {
        const basePts = offsetPoly(seg.poly, def.off);
        const baseTans = seg.poly.tans!;
        const oriented = def.dir === 1 ? basePts : [...basePts].reverse();
        const orientedTans = def.dir === 1
          ? [...baseTans]
          : [...baseTans].reverse().map(t => mul(t, -1));
        const lp = makePoly(oriented, orientedTans);
        let sStart = def.dir === 1 ? trimA : trimB;
        const sEnd = def.dir === 1 ? trimB : trimA;
        if (def.kind === 'turn') sStart = Math.max(sStart, lp.len - sEnd - TURN_LANE_LEN);
        if (lp.len - sEnd - sStart < 1.5) return; // lane too short to exist
        const lane: Lane = {
          id: `${seg.id}:${idx}`, seg: seg.id, idx, def,
          poly: subPoly(lp, sStart, lp.len - sEnd),
          speed: segSpeed(seg),
          offTravel: def.off * def.dir,
        };
        seg.lanes.push(lane);
        this.lanesById.set(lane.id, lane);
      });
    }

    // 5. junction connectors + conflicts + approaches
    this.connsById.clear();
    for (const node of this.nodes.values()) this.buildJunction(node);

    // 6. render chains (same-type runs through shape nodes and through-junctions)
    this.buildChains();

    this.version++;
  }

  /** the segment that continues `segId` past `nid` for marking purposes:
      shape nodes always continue, junctions only along their through pair */
  markingContinuation(segId: SegId, nid: NodeId): SegId | null {
    const n = this.nodes.get(nid);
    if (!n) return null;
    if (n.segs.length === 2) {
      const other = n.segs.find(id => id !== segId);
      if (other === undefined) return null;
      return this.segs.get(other)!.type === this.segs.get(segId)!.type ? other : null;
    }
    if (!n.markThrough) return null;
    if (n.markThrough[0] === segId) return n.markThrough[1];
    if (n.markThrough[1] === segId) return n.markThrough[0];
    return null;
  }

  /** centerline walking outward from a node along an approach, following
      shape-node (and optionally through-junction) continuations until maxLen
      is covered. Pass throughJunctions=false during rebuild, before
      markThrough is computed. */
  approachPoly(nodeId: NodeId, sid: SegId, maxLen: number, throughJunctions = true): Poly | null {
    const pts: V[] = [];
    const tans: V[] = [];
    let nid = nodeId;
    let cur = this.segs.get(sid);
    let total = 0;
    let guard = 0;
    while (cur && total < maxLen && guard++ < 16) {
      const sp = cur.poly;
      const fromHere = cur.a === nid;
      let p = sp.pts;
      let t = sp.tans ?? sp.pts.map((_, i) => polyTangent(sp, sp.cum[i]));
      if (!fromHere) {
        p = [...p].reverse();
        t = [...t].reverse().map(x => mul(x, -1));
      }
      for (let i = pts.length ? 1 : 0; i < p.length; i++) {
        pts.push(p[i]);
        tans.push(t[i]);
      }
      total += sp.len;
      nid = fromHere ? cur.b : cur.a;
      if (!throughJunctions && (this.nodes.get(nid)?.segs.length ?? 0) >= 3) break;
      const nxt = this.markingContinuation(cur.id, nid);
      cur = nxt === null ? undefined : this.segs.get(nxt);
    }
    return pts.length > 1 ? makePoly(pts, tans) : null;
  }

  private buildChains() {
    this.chains = [];
    const visited = new Set<SegId>();
    const continueId = (segId: SegId, nid: NodeId) => this.markingContinuation(segId, nid);

    for (const seed of this.segs.values()) {
      if (visited.has(seed.id)) continue;

      // walk backwards to the chain start (or all the way around a loop)
      let cur = seed;
      let backNode = seed.a;
      const seen = new Set<SegId>([seed.id]);
      for (;;) {
        const prevId = continueId(cur.id, backNode);
        if (prevId === null || seen.has(prevId)) break;
        cur = this.segs.get(prevId)!;
        seen.add(prevId);
        backNode = cur.a === backNode ? cur.b : cur.a;
      }

      // walk forward collecting segments + orientation
      const startNode = backNode;
      const segIds: SegId[] = [];
      const flips: boolean[] = [];
      let node = backNode;
      let walk = cur;
      for (;;) {
        visited.add(walk.id);
        segIds.push(walk.id);
        flips.push(walk.a !== node);
        node = walk.a === node ? walk.b : walk.a;
        const nextId = continueId(walk.id, node);
        if (nextId === null || visited.has(nextId)) break;
        walk = this.segs.get(nextId)!;
      }

      // concatenate centerlines (skip duplicated joint points)
      const pts: V[] = [];
      const tans: V[] = [];
      segIds.forEach((sid, k) => {
        const sp = this.segs.get(sid)!.poly;
        let p = sp.pts, t = sp.tans ?? sp.pts.map((_, i) => polyTangent(sp, sp.cum[i]));
        if (flips[k]) {
          p = [...p].reverse();
          t = [...t].reverse().map(x => mul(x, -1));
        }
        for (let i = k === 0 ? 0 : 1; i < p.length; i++) {
          pts.push(p[i]);
          tans.push(t[i]);
        }
      });

      this.chains.push({
        segs: segIds,
        poly: makePoly(pts, tans),
        rt: this.segs.get(segIds[0])!.rt,
        aNode: startNode,
        bNode: node,
        aSeg: segIds[0],
        bSeg: segIds[segIds.length - 1],
      });
    }
  }

  /** The segment that continues `seg` through `node`, if any: at shape nodes
      the other segment, at junctions the straightest mutual partner — so a
      curve stays smooth when a branch is attached to one of its nodes. */
  private continuation(seg: Segment, node: RNode): Segment | null {
    if (node.segs.length < 2) return null;
    if (node.segs.length === 2) {
      const otherSid = node.segs.find(id => id !== seg.id);
      return otherSid === undefined ? null : this.segs.get(otherSid) ?? null;
    }
    const away = (s: Segment) => {
      const other = this.nodes.get(s.a === node.id ? s.b : s.a)!;
      return norm(sub(other.pos, node.pos));
    };
    const myAway = away(seg);
    let best: Segment | null = null;
    let bestAng = 0;
    for (const sid of node.segs) {
      if (sid === seg.id) continue;
      const o = this.segs.get(sid)!;
      const ang = Math.abs(signedAngle(myAway, away(o)));
      if (ang > bestAng) { bestAng = ang; best = o; }
    }
    if (!best || bestAng < 2.0) return null;  // needs a near-through partner (~115°+)
    // mutual: I must also be the partner's straightest option
    const bAway = away(best);
    for (const sid of node.segs) {
      if (sid === best.id || sid === seg.id) continue;
      if (Math.abs(signedAngle(bAway, away(this.segs.get(sid)!))) > bestAng + 1e-9) return null;
    }
    return best;
  }

  private endTangent(seg: Segment, node: RNode, chord: V): V {
    // chord points a -> b; returned tangent also in a -> b travel direction
    const other = this.continuation(seg, node);
    if (!other) return chord;
    const myOther = this.nodes.get(seg.a === node.id ? seg.b : seg.a)!;
    const theirOther = this.nodes.get(other.a === node.id ? other.b : other.a)!;
    // Catmull-Rom tangent at the shared node: direction between flanking
    // endpoints, oriented along this segment's a->b travel.
    let t = node.id === seg.b
      ? norm(sub(theirOther.pos, myOther.pos))   // travel: myOther -> node -> theirOther
      : norm(sub(myOther.pos, theirOther.pos));  // travel: theirOther -> node -> myOther
    // safety: blend toward chord on very sharp kinks to avoid loops
    const ang = Math.abs(signedAngle(chord, t));
    if (ang > 1.2) {
      const k = clamp((ang - 1.2) / 0.6, 0, 1);
      t = norm(add(mul(t, 1 - k), mul(chord, k)));
    }
    return t;
  }

  private incomingLanes(node: RNode, seg: Segment): Lane[] {
    const lanes = seg.lanes.filter(l => (l.def.dir === 1 ? seg.b : seg.a) === node.id);
    return lanes.sort((x, y) => x.offTravel - y.offTravel); // left -> right
  }

  private outgoingLanes(node: RNode, seg: Segment): Lane[] {
    const lanes = seg.lanes.filter(l => (l.def.dir === 1 ? seg.a : seg.b) === node.id && l.def.kind === 'drive');
    return lanes.sort((x, y) => x.offTravel - y.offTravel);
  }

  private buildJunction(node: RNode) {
    node.conns = [];
    node.connByFrom = new Map();
    node.approaches = [];
    const deg = node.segs.length;
    if (deg < 2) return;

    const segObjs = node.segs.map(id => this.segs.get(id)!);

    // approach headings (direction traffic arrives at the node)
    const headIn = new Map<SegId, V>();
    const headOut = new Map<SegId, V>();
    for (const seg of segObjs) {
      const atEnd = seg.b === node.id;
      const trim = node.trim.get(seg.id)!;
      const sPos = atEnd ? seg.poly.len - trim : trim;
      let t = polyTangent(seg.poly, sPos);
      if (!atEnd) t = mul(t, -1);          // now points INTO node
      headIn.set(seg.id, t);
      headOut.set(seg.id, mul(t, -1));     // direction leaving via this seg
    }

    const addConn = (from: Lane, to: Lane, turn: Turn, fromSeg: Segment, toSeg: Segment) => {
      const id = `c${node.id}:${from.id}>${to.id}`;
      if (this.connsById.has(id)) return;
      const p0 = from.poly.pts[from.poly.pts.length - 1];
      const t0 = polyTangent(from.poly, from.poly.len);
      const p3 = to.poly.pts[0];
      const t3 = polyTangent(to.poly, 0);
      const d = dist(p0, p3);
      let poly: Poly;
      if (d < 0.8) {
        poly = makePoly([p0, d < 0.05 ? add(p0, mul(t3, 0.3)) : p3]);
      } else {
        const samp = sampleBezT(bezFromTangents(p0, t0, p3, t3), clamp(Math.round(d / 1.5), 6, 24));
        poly = makePoly(samp.pts, samp.tans);
      }
      const speed = turn === 'S' ? Math.min(from.speed, to.speed) : turn === 'R' ? 6.5 : 7.5;
      const conn: Connector = {
        id, node: node.id, from: from.id, to: to.id,
        fromSeg: fromSeg.id, toSeg: toSeg.id, turn, poly, speed,
        conflicts: [], movement: `${fromSeg.id}|${turn}`,
      };
      node.conns.push(conn);
      this.connsById.set(id, conn);
      const arr = node.connByFrom.get(from.id) ?? [];
      arr.push(conn);
      node.connByFrom.set(from.id, arr);
    };

    if (deg === 2) {
      // via node: map lanes right-aligned, all 'S'
      const [sa, sb] = segObjs;
      for (const [inSeg, outSeg] of [[sa, sb], [sb, sa]] as [Segment, Segment][]) {
        const ins = this.incomingLanes(node, inSeg).filter(l => l.def.kind === 'drive');
        const outs = this.outgoingLanes(node, outSeg);
        if (!ins.length || !outs.length) continue;
        for (let i = 0; i < ins.length; i++) {
          // right-aligned mapping (rightmost stays rightmost)
          const j = clamp(i + (outs.length - ins.length), 0, outs.length - 1);
          addConn(ins[i], outs[j], 'S', inSeg, outSeg);
        }
        // make sure every out lane is reachable (diverge from the matching side)
        for (let j = 0; j < outs.length; j++) {
          if (!node.conns.some(c => c.to === outs[j].id && c.fromSeg === inSeg.id)) {
            const i = clamp(j - (outs.length - ins.length), 0, ins.length - 1);
            addConn(ins[i], outs[j], 'S', inSeg, outSeg);
          }
        }
      }
      this.finishJunction(node, headIn);
      return;
    }

    // real junction (deg >= 3)
    for (const inSeg of segObjs) {
      const hIn = headIn.get(inSeg.id)!;
      const driveIn = this.incomingLanes(node, inSeg).filter(l => l.def.kind === 'drive');
      const turnIn = this.incomingLanes(node, inSeg).filter(l => l.def.kind === 'turn');
      if (!driveIn.length && !turnIn.length) continue;

      // classify exits
      const exits: { seg: Segment; turn: Turn; ang: number }[] = [];
      for (const outSeg of segObjs) {
        if (outSeg.id === inSeg.id) continue;
        const outs = this.outgoingLanes(node, outSeg);
        if (!outs.length) continue;
        const ang = signedAngle(hIn, headOut.get(outSeg.id)!);
        if (Math.abs(ang) > 2.55) continue; // no U-turns
        const turn: Turn = ang > Math.PI / 6 ? 'R' : ang < -Math.PI / 6 ? 'L' : 'S';
        exits.push({ seg: outSeg, turn, ang });
      }
      if (!exits.length) continue;

      const present = new Set(exits.map(e => e.turn));
      const useTurnLane = turnIn.length > 0 && present.has('L');

      // lane class assignment, left -> right
      const n = driveIn.length;
      const assign: Turn[][] = driveIn.map(() => []);
      const give = (i: number, t: Turn) => { if (!assign[i].includes(t)) assign[i].push(t); };
      if (n === 1) {
        (['L', 'S', 'R'] as Turn[]).forEach(t => { if (present.has(t)) give(0, t); });
      } else if (n === 2) {
        if (present.has('L')) give(0, 'L');
        if (present.has('S')) { give(0, 'S'); give(1, 'S'); }
        if (present.has('R')) give(1, 'R');
      } else {
        if (present.has('L')) give(0, 'L');
        if (present.has('S')) for (let i = 0; i < n; i++) if (i > 0 || !present.has('L')) give(i, 'S');
        if (present.has('R')) give(n - 1, 'R');
      }
      if (useTurnLane) {
        // lefts move to the dedicated turn lane
        for (const arr of assign) {
          const k = arr.indexOf('L');
          if (k >= 0) arr.splice(k, 1);
        }
      }
      // every lane needs at least one movement
      for (let i = 0; i < n; i++) {
        if (assign[i].length === 0) {
          if (present.has('S')) give(i, 'S');
          else if (i === 0 && present.has('L') && !useTurnLane) give(i, 'L');
          else if (present.has('R')) give(i, 'R');
          else if (present.has('L') && !useTurnLane) give(i, 'L');
        }
      }
      // every present movement needs at least one lane
      for (const t of present) {
        if (t === 'L' && useTurnLane) continue;
        if (!assign.some(a => a.includes(t))) {
          if (t === 'L') give(0, 'L');
          else if (t === 'R') give(n - 1, 'R');
          else give(Math.floor(n / 2), 'S');
        }
      }

      for (const exit of exits) {
        const outs = this.outgoingLanes(node, exit.seg);
        if (exit.turn === 'L' && useTurnLane) {
          for (const tl of turnIn) addConn(tl, outs[0], 'L', inSeg, exit.seg);
          continue;
        }
        const fromLanes = driveIn.filter((_, i) => assign[i].includes(exit.turn));
        if (!fromLanes.length) continue;
        if (exit.turn === 'L') {
          fromLanes.forEach((l, i) => addConn(l, outs[clamp(i, 0, outs.length - 1)], 'L', inSeg, exit.seg));
        } else if (exit.turn === 'R') {
          fromLanes.forEach((l, i) => {
            const j = clamp(outs.length - fromLanes.length + i, 0, outs.length - 1);
            addConn(l, outs[j], 'R', inSeg, exit.seg);
          });
        } else {
          // straight: right-aligned index mapping
          fromLanes.forEach((l, i) => {
            const j = clamp(i + (outs.length - fromLanes.length), 0, outs.length - 1);
            addConn(l, outs[j], 'S', inSeg, exit.seg);
          });
          // make extra out lanes reachable
          for (let j = 0; j < outs.length; j++) {
            if (!node.conns.some(c => c.to === outs[j].id && c.fromSeg === inSeg.id && c.turn === 'S')) {
              const i = clamp(j - (outs.length - fromLanes.length), 0, fromLanes.length - 1);
              addConn(fromLanes[i], outs[j], 'S', inSeg, exit.seg);
            }
          }
        }
      }
    }

    this.finishJunction(node, headIn);
  }

  private finishJunction(node: RNode, headIn: Map<SegId, V>) {
    // conflicts between connectors from different approaches
    const cs = node.conns;
    for (let i = 0; i < cs.length; i++) {
      for (let j = i + 1; j < cs.length; j++) {
        const a = cs[i], b = cs[j];
        if (a.fromSeg === b.fromSeg) continue;
        if (a.to === b.to) {
          a.conflicts.push({ other: b.id, sMine: a.poly.len - 0.5, sOther: b.poly.len - 0.5, merge: true });
          b.conflicts.push({ other: a.id, sMine: b.poly.len - 0.5, sOther: a.poly.len - 0.5, merge: true });
          continue;
        }
        const hits = polyIntersections(a.poly, b.poly);
        if (hits.length) {
          const h = hits[0];
          a.conflicts.push({ other: b.id, sMine: h.sa, sOther: h.sb, merge: false });
          b.conflicts.push({ other: a.id, sMine: h.sb, sOther: h.sa, merge: false });
        }
      }
    }

    // approaches (for UI + signs + stop lines)
    node.approaches = [];
    for (const sid of node.segs) {
      const seg = this.segs.get(sid)!;
      const inLanes = this.incomingLanes(node, seg).filter(l => l.def.kind === 'drive');
      if (!inLanes.length) continue;
      const turns: Partial<Record<Turn, SegId[]>> = {};
      for (const c of node.conns) {
        if (c.fromSeg !== sid) continue;
        const arr = (turns[c.turn] ??= []);
        if (!arr.includes(c.toSeg)) arr.push(c.toSeg);
      }
      const ends = inLanes.map(l => l.poly.pts[l.poly.pts.length - 1]);
      const mid = ends.reduce((acc, p) => add(acc, p), { x: 0, y: 0 });
      const h = headIn.get(sid)!;
      node.approaches.push({
        seg: sid,
        heading: h,
        inLanes,
        turns,
        stopPos: mul(mid, 1 / ends.length),
        stopDir: perp(h),
      });
    }
    // stable order: clockwise by angle of arrival
    node.approaches.sort((a, b) => Math.atan2(a.heading.y, a.heading.x) - Math.atan2(b.heading.y, b.heading.x));
  }

  /* ---------------- queries ---------------- */

  lane(id: string): Lane | undefined { return this.lanesById.get(id); }
  conn(id: string): Connector | undefined { return this.connsById.get(id); }

  /** outgoing connectors from a lane's end */
  connsFrom(laneId: string): Connector[] {
    const lane = this.lanesById.get(laneId);
    if (!lane) return [];
    const seg = this.segs.get(lane.seg)!;
    const endNode = lane.def.dir === 1 ? seg.b : seg.a;
    return this.nodes.get(endNode)?.connByFrom.get(laneId) ?? [];
  }

  laneEndNode(laneId: string): RNode | undefined {
    const lane = this.lanesById.get(laneId);
    if (!lane) return undefined;
    const seg = this.segs.get(lane.seg)!;
    return this.nodes.get(lane.def.dir === 1 ? seg.b : seg.a);
  }

  /** adjacent same-direction lanes on the same segment (for lane changes) */
  adjacentLanes(laneId: string): Lane[] {
    const lane = this.lanesById.get(laneId);
    if (!lane) return [];
    const seg = this.segs.get(lane.seg)!;
    return seg.lanes.filter(l =>
      l.id !== lane.id &&
      l.def.dir === lane.def.dir &&
      Math.abs(l.offTravel - lane.offTravel) < 1.6 * 3.5 + 0.1 &&
      Math.abs(l.offTravel - lane.offTravel) > 0.1
    );
  }

  gates(): RNode[] {
    return [...this.nodes.values()].filter(n => n.gate && n.segs.length === 1);
  }

  signFor(node: RNode, segId: SegId): SignKind {
    if (node.control.kind !== 'signs') return 'none';
    return node.control.signs[segId] ?? 'none';
  }
}
