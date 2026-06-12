// Editor tools: road drawing (grid/free snapping, auto-splitting crossings,
// auto-subdivision into editable nodes), node editing, gates, bulldozing.

import { Network, NodeId, SegId, RNode } from './network';
import {
  V, add, dist, sub, norm, makePoly, Poly, polyIntersections, projectOnPoly,
  polyTangent, polyPoint, mul, signedAngle, clamp, sampleBezT, Bez,
} from './vec';
import { WORLD_W, WORLD_H } from './terrain';

export type ToolKind = 'select' | 'draw' | 'edit' | 'gate' | 'bulldoze' | 'upgrade';
export type SnapMode = 'grid' | 'free' | 'curve';

export interface Selection { kind: 'node' | 'seg'; id: number; }

interface SnapResult {
  pos: V;
  node?: NodeId;
  seg?: { id: SegId; s: number };
}

export interface Preview {
  pts: V[];
  ok: boolean;
  reason?: string;
  crossings: V[];
  /** thin guide ray (curve-mode angle handle), not a road ghost */
  guide?: boolean;
}

const GRID = 16;
const FINE = 2;
const MIN_SEG = 7;
const MAX_PIECE = 52;
const MIN_ANGLE = 0.52;  // ~30 degrees

export class Tools {
  tool: ToolKind = 'draw';
  snapMode: SnapMode = 'grid';
  roadTypeId = '2w1';

  hoverNode: NodeId | null = null;
  hoverSeg: SegId | null = null;
  selection: Selection | null = null;

  anchor: { node?: NodeId; pos: V } | null = null;
  preview: Preview | null = null;
  draggingNode: NodeId | null = null;
  cursor: V = { x: 0, y: 0 };
  /** curve mode: the user-placed direction control point (2nd click) */
  curveCtrl: V | null = null;
  /** curve mode: inherited end tangent for continuous curves */
  private chainTan: V | null = null;
  private createdSplits: NodeId[] = [];
  private lastValidPos: V | null = null;

  constructor(
    private net: Network,
    public onChange: () => void,
    public onSelect: (sel: Selection | null) => void,
    public toast: (msg: string) => void,
  ) {}

  setTool(t: ToolKind) {
    if (t !== this.tool) this.cancelChain();
    this.tool = t;
    if (t !== 'select') this.select(null);
    this.preview = null;
  }

  select(sel: Selection | null) {
    this.selection = sel;
    this.onSelect(sel);
  }

  /* ---------------- snapping ---------------- */

  snap(world: V, forDrawing: boolean): SnapResult {
    const p = { x: clamp(world.x, 0, WORLD_W), y: clamp(world.y, 0, WORLD_H) };
    const segR = 5;

    let bestNode: RNode | null = null;
    let bestD = Infinity;
    for (const n of this.net.nodes.values()) {
      // when inspecting/editing, the whole junction patch is clickable;
      // drawing keeps a tight radius so endpoints land precisely
      const r = forDrawing ? 7 : Math.max(7, n.junctionR + 1);
      const d = dist(n.pos, p);
      if (d < r && d < bestD) { bestD = d; bestNode = n; }
    }
    if (bestNode) return { pos: { ...bestNode.pos }, node: bestNode.id };

    let bestSeg: { id: SegId; s: number; pos: V } | null = null;
    let bestSD = segR;
    for (const s of this.net.segs.values()) {
      const pr = projectOnPoly(s.poly, p);
      if (pr.d < bestSD && pr.s > 4 && pr.s < s.poly.len - 4) {
        bestSD = pr.d;
        bestSeg = { id: s.id, s: pr.s, pos: pr.pt };
      }
    }
    if (bestSeg) return { pos: bestSeg.pos, seg: { id: bestSeg.id, s: bestSeg.s } };

    if (forDrawing) {
      const g = this.snapMode === 'grid' ? GRID : FINE;
      return { pos: { x: Math.round(p.x / g) * g, y: Math.round(p.y / g) * g } };
    }
    return { pos: p };
  }

  /** plain fine-grid position, never snapped to roads (curve control points) */
  private finePos(world: V): V {
    return {
      x: clamp(Math.round(world.x / FINE) * FINE, 0, WORLD_W),
      y: clamp(Math.round(world.y / FINE) * FINE, 0, WORLD_H),
    };
  }

  /* ---------------- hover ---------------- */

  updateHover(world: V) {
    this.cursor = world;
    const r = this.snap(world, false);
    this.hoverNode = r.node ?? null;
    this.hoverSeg = r.node ? null : (r.seg?.id ?? null);
    if (this.tool === 'draw' && this.anchor) this.computePreview(world);
    else if (this.tool === 'draw') this.preview = null;
  }

  /* ---------------- mouse actions ---------------- */

  onClick(world: V) {
    switch (this.tool) {
      case 'draw': this.drawClick(world); break;
      case 'upgrade': this.paintUpgrade(world); break;
      case 'select': {
        const r = this.snap(world, false);
        if (r.node !== undefined) this.select({ kind: 'node', id: r.node });
        else if (r.seg) this.select({ kind: 'seg', id: r.seg.id });
        else this.select(null);
        break;
      }
      case 'gate': {
        const r = this.snap(world, false);
        if (r.node !== undefined) {
          const n = this.net.nodes.get(r.node)!;
          if (n.segs.length !== 1) { this.toast('Gates go on dead-end road tips — the loose end of a road.'); return; }
          if (n.gate) { this.select({ kind: 'node', id: n.id }); return; }
          n.gate = { rate: 12 };
          this.net.rebuild();
          this.onChange();
          this.select({ kind: 'node', id: n.id });
        } else {
          this.toast('Click the open end of a road to place a spawn gate.');
        }
        break;
      }
      case 'bulldoze': {
        const r = this.snap(world, false);
        if (r.node !== undefined) {
          this.net.removeNode(r.node);
          this.net.rebuild(); this.onChange();
        } else if (r.seg) {
          this.net.removeSegment(r.seg.id);
          this.net.rebuild(); this.onChange();
        }
        break;
      }
      case 'edit': break; // handled by drag in onDown
    }
  }

  /** upgrade tool: convert the road section under the cursor (click or paint-drag) */
  paintUpgrade(world: V) {
    const r = this.snap(world, false);
    let sid: SegId | undefined = r.seg?.id;
    if (sid === undefined && r.node !== undefined) {
      // clicking a shape node upgrades both its sections
      const n = this.net.nodes.get(r.node);
      if (n && n.segs.length <= 2) {
        let changed = false;
        for (const s of n.segs) {
          if (this.net.segs.get(s)!.type !== this.roadTypeId) {
            this.net.changeSegType(s, this.roadTypeId);
            changed = true;
          }
        }
        if (changed) { this.net.rebuild(); this.onChange(); }
        return;
      }
    }
    if (sid === undefined) return;
    if (this.net.segs.get(sid)!.type === this.roadTypeId) return;
    this.net.changeSegType(sid, this.roadTypeId);
    this.net.rebuild();
    this.onChange();
  }

  /** edit tool: mousedown starts node drag (splits segment if needed) */
  onEditDown(world: V): boolean {
    if (this.tool !== 'edit') return false;
    const r = this.snap(world, false);
    if (r.node !== undefined) {
      this.draggingNode = r.node;
      this.lastValidPos = { ...this.net.nodes.get(r.node)!.pos };
      this.select({ kind: 'node', id: r.node });
      return true;
    }
    if (r.seg) {
      const n = this.net.splitSegment(r.seg.id, r.seg.s);
      this.net.rebuild();
      this.onChange();
      this.draggingNode = n.id;
      this.lastValidPos = { ...n.pos };
      this.select({ kind: 'node', id: n.id });
      return true;
    }
    this.select(null);
    return false;
  }

  onDrag(world: V) {
    if (this.draggingNode === null) return;
    const n = this.net.nodes.get(this.draggingNode);
    if (!n) { this.draggingNode = null; return; }
    n.pos = {
      x: clamp(Math.round(world.x / FINE) * FINE, 0, WORLD_W),
      y: clamp(Math.round(world.y / FINE) * FINE, 0, WORLD_H),
    };
    this.net.rebuild();
    if (this.dragBad(n.id)) {
      // hold the node at the last legal spot — slides along the constraint
      if (this.lastValidPos) {
        n.pos = { ...this.lastValidPos };
        this.net.rebuild();
      }
    } else {
      this.lastValidPos = { ...n.pos };
    }
  }

  /** would the drag leave roads crossing without a junction, or degenerate geometry? */
  private dragBad(nodeId: NodeId): boolean {
    const n = this.net.nodes.get(nodeId);
    if (!n) return false;
    // geometry changed for segs at the node AND segs at their far nodes
    // (their spline tangents depend on the moved node)
    const affected = new Set<SegId>();
    for (const sid of n.segs) {
      affected.add(sid);
      const s = this.net.segs.get(sid)!;
      for (const nid of [s.a, s.b]) {
        for (const sid2 of this.net.nodes.get(nid)!.segs) affected.add(sid2);
      }
    }

    const touched = new Set<NodeId>();
    for (const sid of affected) {
      const s = this.net.segs.get(sid)!;
      if (s.poly.len < 4.5) return true;
      touched.add(s.a); touched.add(s.b);
    }

    // no hairpins / razor junctions
    for (const nid of touched) {
      const node = this.net.nodes.get(nid)!;
      if (node.segs.length < 2) continue;
      const dirs = node.segs.map(sid => {
        const s = this.net.segs.get(sid)!;
        const other = this.net.nodes.get(s.a === nid ? s.b : s.a)!;
        return norm(sub(other.pos, node.pos));
      });
      for (let i = 0; i < dirs.length; i++) {
        for (let j = i + 1; j < dirs.length; j++) {
          if (Math.abs(signedAngle(dirs[i], dirs[j])) < MIN_ANGLE) return true;
        }
      }
    }

    // no crossings with non-adjacent segments
    const bbox = (p: { pts: V[] }) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const q of p.pts) {
        if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x;
        if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y;
      }
      return { x0, y0, x1, y1 };
    };
    const shares = (a: { a: NodeId; b: NodeId }, b: { a: NodeId; b: NodeId }) =>
      a.a === b.a || a.a === b.b || a.b === b.a || a.b === b.b;

    const aff = [...affected].map(id => this.net.segs.get(id)!);
    const affBoxes = aff.map(s => bbox(s.poly));
    for (let i = 0; i < aff.length; i++) {
      const s = aff[i], sb = affBoxes[i];
      for (const o of this.net.segs.values()) {
        if (o.id === s.id) continue;
        if (affected.has(o.id) && o.id < s.id) continue; // each affected pair once
        if (shares(s, o)) continue;
        // pavements must not touch, let alone cross
        const clear = (s.rt.halfWidth + o.rt.halfWidth) * 0.85;
        const ob = bbox(o.poly);
        if (sb.x1 < ob.x0 - clear || ob.x1 < sb.x0 - clear || sb.y1 < ob.y0 - clear || ob.y1 < sb.y0 - clear) continue;
        if (polyIntersections(s.poly, o.poly).length) return true;
        for (let k = 0; k < s.poly.pts.length; k += 2) {
          if (projectOnPoly(o.poly, s.poly.pts[k]).d < clear) return true;
        }
      }
    }
    return false;
  }

  onDragEnd() {
    if (this.draggingNode !== null) {
      this.draggingNode = null;
      this.net.rebuild();
      this.onChange();
    }
  }

  deleteSelected() {
    if (!this.selection) return;
    if (this.selection.kind === 'node') {
      const n = this.net.nodes.get(this.selection.id);
      if (!n) return;
      if (n.segs.length === 2 && this.net.dissolveNode(n.id)) {
        this.toast('Node dissolved — road merged.');
      } else {
        this.net.removeNode(n.id);
      }
    } else {
      this.net.removeSegment(this.selection.id);
    }
    this.select(null);
    this.net.rebuild();
    this.onChange();
  }

  /* ---------------- road drawing ---------------- */

  private drawClick(world: V) {
    const r = this.snap(world, true);
    if (!this.anchor) {
      // start a chain
      if (r.seg) {
        const n = this.net.splitSegment(r.seg.id, r.seg.s);
        this.net.rebuild();
        this.createdSplits.push(n.id);
        this.anchor = { node: n.id, pos: { ...n.pos } };
      } else if (r.node !== undefined) {
        this.anchor = { node: r.node, pos: { ...r.pos } };
      } else {
        this.anchor = { pos: { ...r.pos } };
      }
      this.curveCtrl = null;
      this.chainTan = this.snapMode === 'curve' ? this.inheritTangent(this.anchor.node) : null;
      this.preview = null;
      return;
    }

    // curve mode, second click: lock the direction control point
    if (this.snapMode === 'curve' && !this.chainTan && !this.curveCtrl) {
      const c = this.finePos(world);
      if (dist(c, this.anchor.pos) < 4) { this.toast('Pull the angle handle a bit further out.'); return; }
      this.curveCtrl = c;
      return;
    }

    const path = this.buildPath(r.pos);
    if (!path) return;
    const result = this.commitPath(path, r);
    if (result !== null) {
      if (this.snapMode === 'curve') {
        this.chainTan = polyTangent(path, path.len);
        this.curveCtrl = null;
      }
      this.anchor = { node: result, pos: { ...this.net.nodes.get(result)!.pos } };
      this.preview = null;
    }
  }

  cancelChain() {
    if (this.anchor?.node !== undefined && this.createdSplits.includes(this.anchor.node)) {
      const n = this.net.nodes.get(this.anchor.node);
      if (n && n.segs.length === 2) {
        this.net.dissolveNode(n.id);
        this.net.rebuild();
        this.onChange();
      }
    }
    this.anchor = null;
    this.preview = null;
    this.curveCtrl = null;
    this.chainTan = null;
    this.createdSplits = [];
  }

  get isDrawingChain(): boolean { return this.anchor !== null; }

  /** continuing a curve from a dead end inherits the road's direction */
  private inheritTangent(nodeId?: NodeId): V | null {
    if (nodeId === undefined) return null;
    const n = this.net.nodes.get(nodeId);
    if (!n || n.segs.length !== 1) return null;
    const seg = this.net.segs.get(n.segs[0])!;
    return seg.a === nodeId
      ? mul(polyTangent(seg.poly, 0), -1)
      : polyTangent(seg.poly, seg.poly.len);
  }

  /** centerline being drawn: a chord, or a quadratic curve in curve mode */
  private buildPath(end: V): Poly | null {
    const p0 = this.anchor!.pos;
    if (this.snapMode !== 'curve') {
      return makePoly([p0, end], [norm(sub(end, p0)), norm(sub(end, p0))]);
    }
    let ctrl = this.curveCtrl;
    if (!ctrl && this.chainTan) {
      // continuous curve: control point sits on the inherited tangent ray
      const chord = dist(p0, end);
      const along = sub(end, p0).x * this.chainTan.x + sub(end, p0).y * this.chainTan.y;
      if (along < 4) return null; // would double back on the previous curve
      const k = clamp(along * 0.55, chord * 0.2, chord * 0.62);
      ctrl = add(p0, mul(this.chainTan, k));
    }
    if (!ctrl) return null;
    // quadratic -> cubic, sampled with analytic tangents
    const bez: Bez = [
      p0,
      add(p0, mul(sub(ctrl, p0), 2 / 3)),
      add(end, mul(sub(ctrl, end), 2 / 3)),
      end,
    ];
    const approxLen = dist(p0, ctrl) + dist(ctrl, end);
    const samp = sampleBezT(bez, clamp(Math.round(approxLen / 2.5), 12, 64));
    return makePoly(samp.pts, samp.tans);
  }

  private pathCrossings(path: Poly, skipNodes: (NodeId | undefined)[]) {
    const out: { seg: SegId; sSeg: number; sPath: number; pos: V; tooClose: boolean; badAngle: boolean }[] = [];
    for (const seg of this.net.segs.values()) {
      // skip segments incident to chain endpoints
      if (skipNodes.some(n => n !== undefined && (seg.a === n || seg.b === n))) continue;
      for (const h of polyIntersections(path, seg.poly)) {
        if (h.sa < 3 || h.sa > path.len - 3) continue;
        const tooClose = h.sb < 5 || h.sb > seg.poly.len - 5;
        const a = Math.abs(signedAngle(polyTangent(path, h.sa), polyTangent(seg.poly, h.sb)));
        const crossAng = Math.min(a, Math.PI - a);
        out.push({ seg: seg.id, sSeg: h.sb, sPath: h.sa, pos: h.pt, tooClose, badAngle: crossAng < MIN_ANGLE });
      }
    }
    out.sort((a, b) => a.sPath - b.sPath);
    return out;
  }

  private angleOkAtNode(nodeId: NodeId, dirAway: V): boolean {
    const n = this.net.nodes.get(nodeId);
    if (!n) return true;
    for (const sid of n.segs) {
      const seg = this.net.segs.get(sid)!;
      const t = seg.a === nodeId
        ? polyTangent(seg.poly, 0)
        : mul(polyTangent(seg.poly, seg.poly.len), -1);
      if (Math.abs(signedAngle(dirAway, t)) < MIN_ANGLE) return false;
    }
    return true;
  }

  private validatePath(path: Poly, end: SnapResult, anchorNode?: NodeId): { ok: boolean; reason?: string; crossings: ReturnType<Tools['pathCrossings']> } {
    const crossings = this.pathCrossings(path, [anchorNode, end.node]);
    if (path.len < MIN_SEG) return { ok: false, reason: 'Too short', crossings };
    const startDir = polyTangent(path, 0);
    const endDir = polyTangent(path, path.len);
    if (anchorNode !== undefined && !this.angleOkAtNode(anchorNode, startDir)) {
      return { ok: false, reason: 'Angle too sharp at start', crossings };
    }
    if (end.node !== undefined && !this.angleOkAtNode(end.node, mul(endDir, -1))) {
      return { ok: false, reason: 'Angle too sharp at end', crossings };
    }
    if (end.node !== undefined && anchorNode !== undefined) {
      if (end.node === anchorNode) return { ok: false, reason: 'Same point', crossings };
      if (this.net.findSegBetween(anchorNode, end.node)) {
        return { ok: false, reason: 'Road already exists here', crossings };
      }
    }
    for (const c of crossings) {
      if (c.tooClose) return { ok: false, reason: 'Crossing too close to an intersection', crossings };
      if (c.badAngle) return { ok: false, reason: 'Crossing angle too shallow', crossings };
    }
    // cut points too close together along the path
    const cuts = [0, ...crossings.map(c => c.sPath), path.len];
    for (let i = 1; i < cuts.length; i++) {
      if (cuts[i] - cuts[i - 1] < 6) return { ok: false, reason: 'Crossings too close together', crossings };
    }
    return { ok: true, crossings };
  }

  private computePreview(world: V) {
    if (!this.anchor) return;
    // curve mode, picking the angle handle: show a guide ray
    if (this.snapMode === 'curve' && !this.chainTan && !this.curveCtrl) {
      this.preview = { pts: [this.anchor.pos, this.finePos(world)], ok: true, crossings: [], guide: true };
      return;
    }
    const r = this.snap(world, true);
    const path = this.buildPath(r.pos);
    if (!path) {
      this.preview = { pts: [this.anchor.pos, r.pos], ok: false, reason: 'Curve would double back', crossings: [] };
      return;
    }
    const val = this.validatePath(path, r, this.anchor.node);
    this.preview = {
      pts: path.pts,
      ok: val.ok,
      reason: val.reason,
      crossings: val.crossings.map(c => c.pos),
    };
  }

  /** returns end node id on success */
  private commitPath(path: Poly, end: SnapResult): NodeId | null {
    if (!this.anchor) return null;
    const val = this.validatePath(path, end, this.anchor.node);
    if (!val.ok) {
      if (val.reason) this.toast(val.reason);
      return null;
    }

    // resolve anchor node
    let aId = this.anchor.node;
    if (aId === undefined) aId = this.net.addNode(this.anchor.pos).id;

    // split crossed segments
    const cutNodes: NodeId[] = [aId];
    const cutArcs: number[] = [0];
    for (const c of val.crossings) {
      const n = this.net.splitSegment(c.seg, c.sSeg);
      this.createdSplits.push(n.id);
      cutNodes.push(n.id);
      cutArcs.push(c.sPath);
    }

    // resolve end node
    let bId = end.node;
    if (bId === undefined && end.seg) {
      const n = this.net.splitSegment(end.seg.id, end.seg.s);
      this.createdSplits.push(n.id);
      bId = n.id;
    }
    if (bId === undefined) bId = this.net.addNode(end.pos).id;
    cutNodes.push(bId);
    cutArcs.push(path.len);

    // create segments along the path, subdividing into editable pieces;
    // curves get shorter pieces so the spline rebuild tracks them closely
    const pieceMax = this.snapMode === 'curve' ? 34 : MAX_PIECE;
    for (let i = 1; i < cutNodes.length; i++) {
      const arc = cutArcs[i] - cutArcs[i - 1];
      const k = Math.max(1, Math.ceil(arc / pieceMax));
      let prev = cutNodes[i - 1];
      for (let j = 1; j <= k; j++) {
        const nid = j === k
          ? cutNodes[i]
          : this.net.addNode(polyPoint(path, cutArcs[i - 1] + (arc * j) / k)).id;
        this.net.addSegment(prev, nid, this.roadTypeId);
        prev = nid;
      }
    }

    this.net.rebuild();
    this.onChange();
    return bId;
  }
}
