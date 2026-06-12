import { Network, NodeId, SegId, SignKind, Control, Segment } from './network';
import { ROAD_TYPES, VehicleKind } from './roadTypes';
import { autoPhases } from './signals';
import { Router } from './router';
import { dist, norm, signedAngle, sub, V } from './vec';

export type PointTuple = [number, number];
export type PointRef = string | PointTuple | V;
export type DebugIdMode = 'nodes' | 'segments' | 'lanes' | 'all';
export type DebugOverlay = 'grid' | 'heatmap' | `ids:${DebugIdMode}`;

export type LevelDecal =
  | { kind: 'circle'; center: PointTuple; radius: number; fill: string; stroke?: string; lineWidth?: number }
  | { kind: 'poly'; points: PointTuple[]; fill: string; stroke?: string; lineWidth?: number };

export interface LevelShot {
  center: PointTuple;
  zoom: number;
  size: PointTuple;
  overlays?: DebugOverlay[];
  selection?: string;
  simSeconds?: number;
  seed?: number | string;
}

export type CampaignDifficulty = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export interface LevelObjective {
  targetArrivals: number;
  maxGridlockEvents: 0;
}

export interface LevelCampaignMeta {
  difficulty: CampaignDifficulty;
  title: string;
  subtitle: string;
  objective: LevelObjective;
}

export interface LevelDefinition {
  id: string;
  name: string;
  map: string;
  build: (ctx: LevelBuilder) => void;
  shots?: Record<string, LevelShot>;
  decals?: LevelDecal[];
  campaign?: LevelCampaignMeta;
}

export interface BuiltLevel {
  def: LevelDefinition;
  net: Network;
  map: string;
  shots: Record<string, LevelShot>;
  decals: LevelDecal[];
  names: LevelNames;
}

export interface LevelNames {
  nodes: Map<string, NodeId>;
  segments: Map<string, SegId[]>;
}

export interface LevelValidation {
  errors: string[];
  warnings: string[];
  stats: {
    nodes: number;
    segments: number;
    lanes: number;
    connectors: number;
    gates: number;
    junctions: number;
  };
}

interface RoadOptions {
  type?: string;
}

interface GateOptions {
  rate?: number;
  industrial?: boolean;
}

interface AutoSignalOptions {
  protectedLefts?: boolean;
  yellow?: number;
}

const ROAD_TYPE_IDS = new Set(ROAD_TYPES.map(rt => rt.id));
const MIN_ANGLE = 0.52;
const MIN_SEG = 7;

export function defineLevel(def: LevelDefinition): LevelDefinition {
  return def;
}

export function buildLevel(def: LevelDefinition): BuiltLevel {
  const net = new Network();
  const ctx = new LevelBuilder(net, def.map);
  def.build(ctx);
  net.rebuild();
  return { def, net, map: def.map, shots: { ...(def.shots ?? {}), ...ctx.shots }, decals: def.decals ?? [], names: ctx.names };
}

export class LevelBuilder {
  readonly names: LevelNames = { nodes: new Map(), segments: new Map() };
  readonly shots: Record<string, LevelShot> = {};

  readonly grid = {
    size: 16,
    point: (x: number, y: number): PointTuple => [x * this.grid.size, y * this.grid.size],
    snap: (p: PointTuple): PointTuple => [
      Math.round(p[0] / this.grid.size) * this.grid.size,
      Math.round(p[1] / this.grid.size) * this.grid.size,
    ],
  };

  readonly road = {
    between: (name: string, a: PointRef, b: PointRef, opts: RoadOptions = {}) => this.addRoad(name, a, b, opts),
    polyline: (name: string, pts: PointRef[], opts: RoadOptions = {}) => this.addPolyline(name, pts, opts),
    curve: (name: string, start: PointRef, control: PointRef, end: PointRef, opts: RoadOptions & { pieces?: number } = {}) =>
      this.addCurve(name, start, control, end, opts),
    speed: (name: string, speed: number) => this.forSegments(name, seg => { seg.speedLimit = speed; }),
    ban: (name: string, kinds: VehicleKind | VehicleKind[]) => {
      const bans = Array.isArray(kinds) ? kinds : [kinds];
      this.forSegments(name, seg => {
        for (const kind of bans) if (!seg.bans.includes(kind)) seg.bans.push(kind);
      });
    },
  };

  readonly gate = {
    atNode: (node: string, opts: GateOptions = {}) => {
      const n = this.net.nodes.get(this.nodeId(node));
      if (!n) throw new Error(`Unknown node: ${node}`);
      n.gate = { rate: opts.rate ?? 12, industrial: opts.industrial || undefined };
    },
  };

  readonly signal = {
    auto: (node: string, opts: AutoSignalOptions = {}) => {
      const n = this.net.nodes.get(this.nodeId(node));
      if (!n) throw new Error(`Unknown node: ${node}`);
      this.net.rebuild();
      n.control = { kind: 'lights', phases: autoPhases(n, !!opts.protectedLefts), yellow: opts.yellow ?? 3 };
      this.net.rebuild();
    },
    signs: (node: string, signsBySegment: Record<string, SignKind>) => {
      const n = this.net.nodes.get(this.nodeId(node));
      if (!n) throw new Error(`Unknown node: ${node}`);
      this.net.rebuild();
      const signs: Record<number, SignKind> = {};
      for (const sid of n.segs) signs[sid] = 'none';
      for (const [segName, sign] of Object.entries(signsBySegment)) {
        const ids = this.names.segments.get(segName);
        if (!ids?.length) throw new Error(`Unknown segment name: ${segName}`);
        for (const sid of ids) {
          if (n.segs.includes(sid)) signs[sid] = sign;
        }
      }
      n.control = { kind: 'signs', signs };
    },
    set: (node: string, control: Control) => {
      const n = this.net.nodes.get(this.nodeId(node));
      if (!n) throw new Error(`Unknown node: ${node}`);
      n.control = control;
    },
  };

  constructor(
    readonly net: Network,
    readonly map: string,
  ) {}

  node(name: string, point: PointTuple): NodeId {
    if (this.names.nodes.has(name)) throw new Error(`Duplicate node name: ${name}`);
    const n = this.net.addNode({ x: point[0], y: point[1] });
    this.names.nodes.set(name, n.id);
    return n.id;
  }

  shot(name: string, shot: LevelShot) {
    this.shots[name] = shot;
  }

  private addRoad(name: string, a: PointRef, b: PointRef, opts: RoadOptions): SegId {
    const aId = this.resolveNode(a, `${name}.a`);
    const bId = this.resolveNode(b, `${name}.b`);
    const type = opts.type ?? '2w1';
    this.assertRoadType(type);
    const seg = this.net.addSegment(aId, bId, type);
    if (!seg) throw new Error(`Could not add road ${name}; duplicate or degenerate segment.`);
    this.names.segments.set(name, [seg.id]);
    return seg.id;
  }

  private addPolyline(name: string, pts: PointRef[], opts: RoadOptions): SegId[] {
    if (pts.length < 2) throw new Error(`Polyline ${name} needs at least two points.`);
    const ids = pts.map((p, i) => this.resolveNode(p, `${name}.${i}`));
    const segs: SegId[] = [];
    const type = opts.type ?? '2w1';
    this.assertRoadType(type);
    for (let i = 1; i < ids.length; i++) {
      const seg = this.net.addSegment(ids[i - 1], ids[i], type);
      if (!seg) throw new Error(`Could not add polyline segment ${name}:${i - 1}.`);
      segs.push(seg.id);
      this.names.segments.set(`${name}:${i - 1}`, [seg.id]);
    }
    this.names.segments.set(name, segs);
    return segs;
  }

  private addCurve(
    name: string,
    start: PointRef,
    control: PointRef,
    end: PointRef,
    opts: RoadOptions & { pieces?: number },
  ): SegId[] {
    const p0 = this.resolvePoint(start);
    const pc = this.resolvePoint(control);
    const p1 = this.resolvePoint(end);
    const pieces = Math.max(2, opts.pieces ?? 8);
    const pts: PointRef[] = [start];
    for (let i = 1; i < pieces; i++) {
      const t = i / pieces;
      const u = 1 - t;
      pts.push([
        u * u * p0.x + 2 * u * t * pc.x + t * t * p1.x,
        u * u * p0.y + 2 * u * t * pc.y + t * t * p1.y,
      ]);
    }
    pts.push(end);
    return this.addPolyline(name, pts, opts);
  }

  private resolveNode(ref: PointRef, autoName: string): NodeId {
    if (typeof ref === 'string') return this.nodeId(ref);
    const p = Array.isArray(ref) ? { x: ref[0], y: ref[1] } : ref;
    const n = this.net.addNode(p);
    this.names.nodes.set(autoName, n.id);
    return n.id;
  }

  private resolvePoint(ref: PointRef): V {
    if (typeof ref === 'string') {
      const n = this.net.nodes.get(this.nodeId(ref));
      if (!n) throw new Error(`Unknown node: ${ref}`);
      return n.pos;
    }
    return Array.isArray(ref) ? { x: ref[0], y: ref[1] } : ref;
  }

  private nodeId(name: string): NodeId {
    const id = this.names.nodes.get(name);
    if (id === undefined) throw new Error(`Unknown node name: ${name}`);
    return id;
  }

  private forSegments(name: string, fn: (seg: Segment) => void) {
    const ids = this.names.segments.get(name);
    if (!ids?.length) throw new Error(`Unknown road name: ${name}`);
    for (const id of ids) {
      const seg = this.net.segs.get(id);
      if (seg) fn(seg);
    }
    this.net.rebuild();
  }

  private assertRoadType(type: string) {
    if (!ROAD_TYPE_IDS.has(type)) throw new Error(`Unknown road type: ${type}`);
  }
}

export function validateLevel(net: Network): LevelValidation {
  net.rebuild();
  const errors: string[] = [];
  const warnings: string[] = [];

  const pairKeys = new Set<string>();
  for (const seg of net.segs.values()) {
    if (!ROAD_TYPE_IDS.has(seg.type)) errors.push(`Segment ${seg.id} has unknown road type ${seg.type}.`);
    if (!net.nodes.has(seg.a)) errors.push(`Segment ${seg.id} is missing node ${seg.a}.`);
    if (!net.nodes.has(seg.b)) errors.push(`Segment ${seg.id} is missing node ${seg.b}.`);
    const key = seg.a < seg.b ? `${seg.a}:${seg.b}` : `${seg.b}:${seg.a}`;
    if (pairKeys.has(key)) errors.push(`Duplicate road between nodes ${seg.a} and ${seg.b}.`);
    pairKeys.add(key);
    if (seg.poly.len < MIN_SEG) warnings.push(`Segment ${seg.id} is very short (${seg.poly.len.toFixed(1)}).`);
  }

  for (const node of net.nodes.values()) {
    if (node.segs.length < 3 && node.control.kind !== 'open') {
      warnings.push(`Node ${node.id} has traffic control but is not a junction.`);
    }
    if (node.segs.length >= 2) {
      const dirs = node.segs.map(sid => {
        const seg = net.segs.get(sid)!;
        const other = net.nodes.get(seg.a === node.id ? seg.b : seg.a)!;
        return norm(sub(other.pos, node.pos));
      });
      for (let i = 0; i < dirs.length; i++) {
        for (let j = i + 1; j < dirs.length; j++) {
          if (Math.abs(signedAngle(dirs[i], dirs[j])) < MIN_ANGLE) {
            warnings.push(`Node ${node.id} has a very sharp approach angle.`);
          }
        }
      }
    }
    if (node.control.kind === 'lights') {
      const movements = new Set(node.conns.map(c => c.movement));
      node.control.phases.forEach((phase, i) => {
        if (phase.green.length === 0) warnings.push(`Node ${node.id} signal phase ${i + 1} has no green movements.`);
        for (const movement of phase.green) {
          if (!movements.has(movement)) errors.push(`Node ${node.id} signal references invalid movement ${movement}.`);
        }
      });
    }
  }

  validateGateRouting(net, errors, warnings);

  return {
    errors,
    warnings: [...new Set(warnings)],
    stats: {
      nodes: net.nodes.size,
      segments: net.segs.size,
      lanes: net.lanesById.size,
      connectors: net.connsById.size,
      gates: net.gates().length,
      junctions: [...net.nodes.values()].filter(n => n.isJunction).length,
    },
  };
}

function validateGateRouting(net: Network, errors: string[], warnings: string[]) {
  const gates = net.gates();
  if (gates.length === 0) {
    warnings.push('Level has no gates.');
    return;
  }
  if (gates.length === 1) {
    warnings.push('Level has only one gate; cars need at least two gates for trips.');
    return;
  }

  const router = new Router(net, () => 0);
  let anyRoute = false;
  for (const from of gates) {
    const seg = net.segs.get(from.segs[0]);
    if (!seg) continue;
    const starts = seg.lanes.filter(l => l.def.kind === 'drive' && (l.def.dir === 1 ? seg.a : seg.b) === from.id);
    for (const to of gates) {
      if (to.id === from.id) continue;
      const routed = starts.some(lane => router.findRoute(lane.id, to.id) !== null);
      if (routed) anyRoute = true;
      else warnings.push(`No route from gate ${from.id} to gate ${to.id}.`);
    }
  }
  if (!anyRoute) errors.push('No route exists between gates.');
}

export function nearestNodeName(names: LevelNames, id: NodeId): string | null {
  for (const [name, nodeId] of names.nodes) if (nodeId === id) return name;
  return null;
}

export function levelBounds(net: Network): { center: PointTuple; size: PointTuple } {
  if (net.nodes.size === 0) return { center: [320, 200], size: [640, 400] };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const node of net.nodes.values()) {
    x0 = Math.min(x0, node.pos.x);
    y0 = Math.min(y0, node.pos.y);
    x1 = Math.max(x1, node.pos.x);
    y1 = Math.max(y1, node.pos.y);
  }
  return { center: [(x0 + x1) / 2, (y0 + y1) / 2], size: [Math.max(1, x1 - x0), Math.max(1, y1 - y0)] };
}

export function distanceBetweenNamedNodes(level: BuiltLevel, a: string, b: string): number {
  const na = level.net.nodes.get(level.names.nodes.get(a) ?? -1);
  const nb = level.net.nodes.get(level.names.nodes.get(b) ?? -1);
  if (!na || !nb) throw new Error(`Unknown node pair: ${a}, ${b}`);
  return dist(na.pos, nb.pos);
}
