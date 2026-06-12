// Congestion-aware A* over the lane graph. Vertices are lanes; edges are
// junction connectors (turn movements) and same-segment lane changes.

import { Network, Lane } from './network';
import { VehicleKind } from './roadTypes';

export interface RouteStep { kind: 'lane' | 'conn'; id: string; }

const TURN_PENALTY = { L: 4, S: 0, R: 1.5 };
const LC_PENALTY = 2.6;
const MAX_SPEED = 19;

interface QItem { lane: string; f: number; }

class Heap {
  arr: QItem[] = [];
  push(it: QItem) {
    this.arr.push(it);
    let i = this.arr.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.arr[p].f <= this.arr[i].f) break;
      [this.arr[p], this.arr[i]] = [this.arr[i], this.arr[p]];
      i = p;
    }
  }
  pop(): QItem | undefined {
    const n = this.arr.length;
    if (!n) return undefined;
    const top = this.arr[0];
    const last = this.arr.pop()!;
    if (n > 1) {
      this.arr[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < this.arr.length && this.arr[l].f < this.arr[m].f) m = l;
        if (r < this.arr.length && this.arr[r].f < this.arr[m].f) m = r;
        if (m === i) break;
        [this.arr[m], this.arr[i]] = [this.arr[i], this.arr[m]];
        i = m;
      }
    }
    return top;
  }
  get size() { return this.arr.length; }
}

export class Router {
  constructor(
    private net: Network,
    /** occupancy ratio 0..1 for a lane/connector id */
    private occOf: (id: string) => number,
  ) {}

  private laneTime(lane: Lane): number {
    const occ = this.occOf(lane.id);
    return (lane.poly.len / lane.speed) * (1 + 4 * occ * occ);
  }

  private controlPenalty(nodeId: number): number {
    const node = this.net.nodes.get(nodeId);
    if (!node) return 0;
    if (node.control.kind === 'lights') return 7;
    if (node.control.kind === 'signs') return 2.5;
    return node.isJunction ? 1.5 : 0;
  }

  /** is this lane's road section closed to the given vehicle kind? */
  private bannedFor(laneId: string, kind: VehicleKind): boolean {
    const lane = this.net.lane(laneId);
    if (!lane) return false;
    return this.net.segs.get(lane.seg)?.bans.includes(kind) ?? false;
  }

  /**
   * Route from a starting lane to any lane ending at goalNode, honoring
   * per-road vehicle bans. Returns steps beginning with the start lane.
   */
  findRoute(startLane: string, goalNode: number, kind: VehicleKind = 'sedan'): RouteStep[] | null {
    const start = this.net.lane(startLane);
    const goal = this.net.nodes.get(goalNode);
    if (!start || !goal) return null;

    const g = new Map<string, number>();
    // parent edge: how we arrived at lane (via connector or lane change from another lane)
    const parent = new Map<string, { lane: string; conn: string | null }>();
    const open = new Heap();
    const closed = new Set<string>();

    const h = (l: Lane) => {
      const e = l.poly.pts[l.poly.pts.length - 1];
      return Math.hypot(e.x - goal.pos.x, e.y - goal.pos.y) / MAX_SPEED;
    };

    g.set(startLane, 0);
    open.push({ lane: startLane, f: h(start) });
    let guard = 0;

    while (open.size && guard++ < 20000) {
      const cur = open.pop()!;
      if (closed.has(cur.lane)) continue;
      closed.add(cur.lane);
      const lane = this.net.lane(cur.lane);
      if (!lane) continue;

      if (this.net.laneEndNode(cur.lane)?.id === goalNode) {
        return this.reconstruct(cur.lane, parent);
      }

      const gCur = g.get(cur.lane)!;

      // connectors at lane end
      for (const c of this.net.connsFrom(cur.lane)) {
        const next = c.to;
        if (closed.has(next)) continue;
        if (this.bannedFor(next, kind)) continue;
        const nl = this.net.lane(next);
        if (!nl) continue;
        const occ = this.occOf(c.id);
        const cost = this.laneTime(lane)
          + (c.poly.len / c.speed) * (1 + 3 * occ * occ)
          + TURN_PENALTY[c.turn]
          + this.controlPenalty(c.node);
        const ng = gCur + cost;
        if (ng < (g.get(next) ?? Infinity)) {
          g.set(next, ng);
          parent.set(next, { lane: cur.lane, conn: c.id });
          open.push({ lane: next, f: ng + h(nl) });
        }
      }

      // lane changes (same section, so same ban status as the current lane)
      for (const adj of this.net.adjacentLanes(cur.lane)) {
        if (closed.has(adj.id)) continue;
        const ng = gCur + LC_PENALTY;
        if (ng < (g.get(adj.id) ?? Infinity)) {
          g.set(adj.id, ng);
          parent.set(adj.id, { lane: cur.lane, conn: null });
          open.push({ lane: adj.id, f: ng + h(adj) });
        }
      }
    }
    return null;
  }

  private reconstruct(endLane: string, parent: Map<string, { lane: string; conn: string | null }>): RouteStep[] {
    const steps: RouteStep[] = [{ kind: 'lane', id: endLane }];
    let cur = endLane;
    let guard = 0;
    while (parent.has(cur) && guard++ < 5000) {
      const p = parent.get(cur)!;
      if (p.conn) steps.unshift({ kind: 'conn', id: p.conn });
      steps.unshift({ kind: 'lane', id: p.lane });
      cur = p.lane;
    }
    return steps;
  }
}
