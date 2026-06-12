// Traffic simulation: cars with IDM car-following, lane-level routing,
// mandatory lane changes, junction right-of-way / signs / signals, and
// congestion tracking.

import { Network, Lane, Connector, RNode } from './network';
import { VehicleKind } from './roadTypes';
import { Router, RouteStep } from './router';
import { SignalSystem, hasPriority } from './signals';
import { V, polyPoint, polyTangent, clamp } from './vec';
import { MathRng, Rng } from './rng';

/* ---------------- tuning ---------------- */

const A_MAX = 2.4;          // max accel (sedan baseline)
const B_COMF = 2.9;         // comfortable decel
const S0 = 2.0;             // standstill gap
const T_HW = 1.15;          // time headway
const CAR_LEN = 4.4;
const LOOK_AHEAD = 90;
const CHECK_DIST = 32;      // junction logic activates within this of the line
const GAP_TIME = 3.1;       // accepted gap (s) vs priority traffic
const REROUTE_EVERY = 9;

export type { VehicleKind };

export interface VehicleSpec {
  len: number;
  width: number;
  v0f: number;     // fraction of the road's speed limit this vehicle drives
  aMax: number;
  bComf: number;
}

export const VEHICLES: Record<VehicleKind, VehicleSpec> = {
  sedan:  { len: 4.4,  width: 2.0,  v0f: 1.0,  aMax: 2.4, bComf: 2.9 },
  suv:    { len: 5.0,  width: 2.15, v0f: 0.97, aMax: 2.2, bComf: 2.8 },
  pickup: { len: 5.5,  width: 2.2,  v0f: 0.95, aMax: 2.0, bComf: 2.7 },
  semi:   { len: 13.5, width: 2.45, v0f: 0.78, aMax: 1.1, bComf: 2.2 },
};

export interface PathPiece { kind: 'lane' | 'conn'; id: string; }

let nextCarId = 1;

export class Car {
  id = nextCarId++;
  pieces: PathPiece[] = [];
  pi = 0;
  s = 0;
  v = 0;
  goal: number;
  colorIdx: number;
  kind: VehicleKind;
  len: number;
  width: number;
  spec: VehicleSpec;
  lcCooldown = 0;
  /** trailing heading for articulated trailers */
  rearHdg: V = { x: 1, y: 0 };
  waitTime = 0;
  totalWait = 0;
  stoppedAtLine = false;
  ticket = -1;
  rerouteIn: number;
  forceReroute = false;
  spawnTime: number;
  braking = false;
  blinker: 'L' | 'R' | null = null;
  // lane-change visual offset
  lcVec: V | null = null;
  lcT = 1;
  // cached world pose (render)
  pos: V = { x: 0, y: 0 };
  hdg: V = { x: 1, y: 0 };

  constructor(goal: number, now: number, kind: VehicleKind = 'sedan', rng: Rng = new MathRng()) {
    this.goal = goal;
    this.kind = kind;
    this.spec = VEHICLES[kind];
    this.len = this.spec.len;
    this.width = this.spec.width;
    this.colorIdx = Math.floor(rng.next() * 10);
    this.spawnTime = now;
    this.rerouteIn = REROUTE_EVERY * (0.7 + rng.next() * 0.6);
  }

  cur(): PathPiece | undefined { return this.pieces[this.pi]; }
  next(): PathPiece | undefined { return this.pieces[this.pi + 1]; }
}

interface Obstacle { gap: number; v: number; }

export interface SimStats {
  carCount: number;
  arrived: number;
  flowPerMin: number;
  avgTrip: number;
  gridlocked: boolean;
}

export class Sim {
  cars: Car[] = [];
  signals: SignalSystem;
  router: Router;
  time = 0;
  paused = false;
  speed = 1;
  arrived = 0;
  private arrivals: { t: number; trip: number }[] = [];
  private occupants = new Map<string, Car[]>();
  private occEMA = new Map<string, number>();
  private gateCooldown = new Map<number, number>();
  private tickets = new Map<number, number>();
  private netVersion = -1;

  constructor(public net: Network, private rng: Rng = new MathRng()) {
    this.signals = new SignalSystem(net);
    this.router = new Router(net, id => this.occEMA.get(id) ?? 0);
  }

  /* ---------------- piece helpers ---------------- */

  pieceObj(p: PathPiece): Lane | Connector | undefined {
    return p.kind === 'lane' ? this.net.lane(p.id) : this.net.conn(p.id);
  }
  pieceLen(p: PathPiece): number { return this.pieceObj(p)?.poly.len ?? 0; }
  pieceSpeed(p: PathPiece): number {
    const o = this.pieceObj(p);
    return o ? ('speed' in o ? o.speed : 13) : 13;
  }

  carsOn(pieceId: string): Car[] { return this.occupants.get(pieceId) ?? []; }
  occOf(id: string): number { return this.occEMA.get(id) ?? 0; }

  /* ---------------- public controls ---------------- */

  resetCars() {
    this.cars = [];
    this.occupants.clear();
    this.arrivals = [];
  }

  resetRun() {
    this.resetCars();
    this.occEMA.clear();
    this.gateCooldown.clear();
    this.tickets.clear();
    this.time = 0;
    this.arrived = 0;
    this.netVersion = -1;
    this.signals = new SignalSystem(this.net);
    this.router = new Router(this.net, id => this.occEMA.get(id) ?? 0);
  }

  onNetworkChange() {
    this.netVersion = this.net.version;
    this.cars = this.cars.filter(car => {
      const cur = car.cur();
      if (!cur || !this.pieceObj(cur)) return false;
      // clamp s to (possibly reshaped) piece
      car.s = clamp(car.s, 0, this.pieceLen(cur));
      // truncate route at first missing piece
      for (let i = car.pi + 1; i < car.pieces.length; i++) {
        if (!this.pieceObj(car.pieces[i])) {
          car.pieces = car.pieces.slice(0, i);
          car.forceReroute = true;
          break;
        }
      }
      if (!this.net.nodes.get(car.goal)?.gate) {
        // destination gate removed
        return this.net.gates().length > 0 ? (car.goal = this.pickGoal(-1), car.forceReroute = true, true) : false;
      }
      return true;
    });
  }

  stats(): SimStats {
    const cutoff = this.time - 60;
    this.arrivals = this.arrivals.filter(a => a.t > cutoff);
    const trips = this.arrivals.map(a => a.trip);
    const stuck = this.cars.filter(c => c.waitTime > 35).length;
    return {
      carCount: this.cars.length,
      arrived: this.arrived,
      flowPerMin: this.arrivals.length,
      avgTrip: trips.length ? trips.reduce((a, b) => a + b, 0) / trips.length : 0,
      gridlocked: this.cars.length > 8 && stuck / this.cars.length > 0.25,
    };
  }

  /* ---------------- main step ---------------- */

  step(dt: number) {
    if (this.net.version !== this.netVersion) this.onNetworkChange();
    this.time += dt;
    this.signals.step(dt);
    this.spawn(dt);
    this.indexOccupants();
    this.updateOccupancyEMA(dt);

    for (const car of this.cars) this.updateCar(car, dt);

    // remove arrived
    this.cars = this.cars.filter(c => {
      if (c.pi >= c.pieces.length) {
        this.arrived++;
        this.arrivals.push({ t: this.time, trip: this.time - c.spawnTime });
        return false;
      }
      return true;
    });
  }

  private indexOccupants() {
    this.occupants.clear();
    for (const car of this.cars) {
      const p = car.cur();
      if (!p) continue;
      const arr = this.occupants.get(p.id);
      if (arr) arr.push(car); else this.occupants.set(p.id, [car]);
    }
    for (const arr of this.occupants.values()) arr.sort((a, b) => a.s - b.s);
  }

  private updateOccupancyEMA(dt: number) {
    const k = clamp(dt / 4, 0, 1);  // ~4s time constant
    for (const [id, ema] of this.occEMA) {
      if (!(this.occupants.get(id)?.length)) {
        const nv = ema * (1 - k);
        if (nv < 0.01) this.occEMA.delete(id); else this.occEMA.set(id, nv);
      }
    }
    for (const [id, cars] of this.occupants) {
      const lane = this.net.lane(id) ?? this.net.conn(id);
      if (!lane) continue;
      const used = cars.reduce((a, c) => a + c.len + S0, 0);
      const occ = clamp(used / Math.max(8, lane.poly.len), 0, 1);
      const prev = this.occEMA.get(id) ?? 0;
      this.occEMA.set(id, prev + (occ - prev) * k);
    }
  }

  /* ---------------- spawning ---------------- */

  private pickGoal(excludeNode: number): number {
    const gates = this.net.gates().filter(g => g.id !== excludeNode);
    return gates.length ? gates[Math.floor(this.rng.next() * gates.length)].id : -1;
  }

  private spawn(dt: number) {
    for (const gate of this.net.gates()) {
      const rate = gate.gate!.rate;
      if (rate <= 0) continue;
      let cd = (this.gateCooldown.get(gate.id) ?? 0) - dt;
      if (cd <= 0) {
        cd = (60 / rate) * (0.65 + this.rng.next() * 0.7);
        this.trySpawnAt(gate);
      }
      this.gateCooldown.set(gate.id, cd);
    }
  }

  private trySpawnAt(gate: RNode) {
    if (this.cars.length > 650) return;
    const seg = this.net.segs.get(gate.segs[0]);
    if (!seg) return;
    const outLanes = seg.lanes.filter(l =>
      l.def.kind === 'drive' && (l.def.dir === 1 ? seg.a : seg.b) === gate.id);
    if (!outLanes.length) return;
    const goal = this.pickGoal(gate.id);
    if (goal < 0) return;
    // vehicle mix: industrial gates dispatch semis, normal gates city traffic
    const roll = this.rng.next();
    const kind: VehicleKind = gate.gate!.industrial
      ? (roll < 0.72 ? 'semi' : 'pickup')
      : (roll < 0.52 ? 'sedan' : roll < 0.78 ? 'suv' : 'pickup');
    // emptiest lane with headroom
    const lane = [...outLanes].sort((a, b) => this.carsOn(a.id).length - this.carsOn(b.id).length)[0];
    const first = this.carsOn(lane.id)[0];
    if (first && first.s - first.len < VEHICLES[kind].len + S0 + 2) return;
    const route = this.router.findRoute(lane.id, goal, kind);
    if (!route) return;
    const car = new Car(goal, this.time, kind, this.rng);
    car.pieces = route.map(r => ({ kind: r.kind, id: r.id }));
    car.s = 0.5;
    car.v = Math.min(lane.speed * 0.5, 8);
    this.cars.push(car);
    const arr = this.occupants.get(lane.id);
    if (arr) { arr.push(car); arr.sort((a, b) => a.s - b.s); }
    else this.occupants.set(lane.id, [car]);
  }

  /* ---------------- per-car update ---------------- */

  private updateCar(car: Car, dt: number) {
    const cur = car.cur();
    if (!cur) return;
    const obj = this.pieceObj(cur);
    if (!obj) { car.pi = car.pieces.length; return; }

    // periodic rerouting (only while on a lane)
    car.rerouteIn -= dt;
    if ((car.rerouteIn <= 0 || car.forceReroute) && cur.kind === 'lane') {
      car.rerouteIn = REROUTE_EVERY * (0.7 + this.rng.next() * 0.6);
      const stuckLong = car.waitTime > 12;
      if (car.forceReroute || stuckLong || this.rng.next() < 0.5) {
        const route = this.router.findRoute(cur.id, car.goal, car.kind);
        if (route) {
          car.pieces = route.map(r => ({ kind: r.kind, id: r.id }));
          car.pi = 0;
          car.forceReroute = false;
        }
      }
    }

    // pending lane change?
    const nxt = car.next();
    if (cur.kind === 'lane' && nxt?.kind === 'lane') {
      this.tryLaneChange(car, obj as Lane, dt);
    }

    // gather obstacles
    const obstacles: Obstacle[] = [];
    const leader = this.findLeader(car);
    if (leader) obstacles.push(leader);
    this.junctionLogic(car, obstacles, dt);

    // stuck behind something slow? look for a faster lane
    car.lcCooldown -= dt;
    if (leader && cur.kind === 'lane' && car.next()?.kind !== 'lane') {
      this.considerOvertake(car, leader);
    }

    // speed adaptation for slower piece ahead
    const { aMax, bComf, v0f } = car.spec;
    let v0 = this.pieceSpeed(cur) * v0f;
    const here = car.s;
    const remain = this.pieceLen(cur) - here;
    const nx = car.next();
    if (nx && remain < 40) {
      const vn = this.pieceSpeed(nx) * v0f;
      if (vn < v0) v0 = Math.min(v0, Math.sqrt(vn * vn + 2 * bComf * Math.max(0.1, remain)));
    }

    // IDM
    let acc = aMax * (1 - Math.pow(car.v / Math.max(v0, 0.5), 4));
    for (const ob of obstacles) {
      const dv = car.v - ob.v;
      const gap = Math.max(0.12, ob.gap);
      const sStar = S0 + Math.max(0, car.v * T_HW + (car.v * dv) / (2 * Math.sqrt(aMax * bComf)));
      const a2 = aMax * (1 - Math.pow(car.v / Math.max(v0, 0.5), 4) - (sStar / gap) * (sStar / gap));
      acc = Math.min(acc, a2);
    }
    acc = clamp(acc, -8, aMax);
    car.braking = acc < -0.8;
    car.v = Math.max(0, car.v + acc * dt);
    car.s += car.v * dt;

    // wait tracking
    if (car.v < 0.3) { car.waitTime += dt; car.totalWait += dt; }
    else car.waitTime = 0;

    // piece transitions
    let guard = 0;
    while (guard++ < 4) {
      const c = car.cur();
      if (!c) break;
      const len = this.pieceLen(c);
      if (car.s < len) break;
      const n = car.next();
      if (!n) {
        // arrived at destination gate
        car.pi = car.pieces.length;
        break;
      }
      if (c.kind === 'lane' && n.kind === 'lane') {
        // mandatory lane change we never completed; stop at end and wait
        car.s = Math.max(0, len - 0.05);
        car.v = 0;
        this.failedLaneChange(car, dt);
        break;
      }
      car.s -= len;
      car.pi++;
      car.stoppedAtLine = false;
      car.ticket = -1;
    }

    // pose for rendering + blinker
    const p = car.cur();
    if (p) {
      const o = this.pieceObj(p);
      if (o) {
        car.pos = polyPoint(o.poly, car.s);
        car.hdg = polyTangent(o.poly, car.s);
        if (car.kind === 'semi') {
          // trailer follows the path: heading sampled where the trailer rides
          car.rearHdg = polyTangent(o.poly, Math.max(0, car.s - car.len * 0.55));
        }
        if (car.lcVec && car.lcT < 1) {
          car.lcT = Math.min(1, car.lcT + dt * 1.4);
          const k = 1 - car.lcT;
          const e = k * k * (3 - 2 * k);
          car.pos = { x: car.pos.x + car.lcVec.x * e, y: car.pos.y + car.lcVec.y * e };
        }
      }
      car.blinker = this.blinkerFor(car);
    }
  }

  private blinkerFor(car: Car): 'L' | 'R' | null {
    const cur = car.cur();
    if (!cur) return null;
    if (cur.kind === 'conn') {
      const c = this.net.conn(cur.id);
      return c && c.turn !== 'S' ? (c.turn as 'L' | 'R') : null;
    }
    const nxt = car.next();
    if (!nxt) return null;
    const remain = this.pieceLen(cur) - car.s;
    if (remain > 28) return null;
    if (nxt.kind === 'conn') {
      const c = this.net.conn(nxt.id);
      return c && c.turn !== 'S' ? (c.turn as 'L' | 'R') : null;
    }
    // lane change pending
    const a = this.net.lane(cur.id), b = this.net.lane(nxt.id);
    if (a && b) return b.offTravel < a.offTravel ? 'L' : 'R';
    return null;
  }

  /* ---------------- leader search ---------------- */

  private findLeader(car: Car): Obstacle | null {
    let dist = -car.s;
    for (let i = car.pi; i < car.pieces.length && dist < LOOK_AHEAD; i++) {
      const p = car.pieces[i];
      const obj = this.pieceObj(p);
      if (!obj) break;
      // skip future lane-change duplicates of the same segment: a lane following
      // a lane means "same stretch, other lane" — look in BOTH for safety only
      // for the current piece; for lookahead just use the chain as planned.
      const minS = i === car.pi ? car.s : 0;
      for (const other of this.carsOn(p.id)) {
        if (other === car) continue;
        if (other.s > minS + 1e-6 || (i > car.pi && other.s >= minS)) {
          const gap = dist + (other.s - other.len);
          if (gap < LOOK_AHEAD) {
            return { gap: Math.max(0.05, gap), v: other.v };
          }
          break;
        }
      }
      // dist already starts at -car.s, so always advance by the full piece
      dist += obj.poly.len;
      // stop lookahead at a lane->lane (lane change) boundary; the LC logic owns that
      const nx = car.pieces[i + 1];
      if (p.kind === 'lane' && nx?.kind === 'lane') break;
    }
    return null;
  }

  /* ---------------- lane changes ---------------- */

  private tryLaneChange(car: Car, fromLane: Lane, dt: number) {
    const nxt = car.next()!;
    const target = this.net.lane(nxt.id);
    if (!target) { car.forceReroute = true; return; }
    // map arc position: both lanes end at the same junction trim
    const sNew = target.poly.len - (fromLane.poly.len - car.s);
    if (sNew < 0.6) return;        // target lane hasn't started yet (turn pockets)
    if (sNew > target.poly.len - 0.6) { this.failedLaneChange(car, dt); return; }

    // gap check in target lane
    let leaderGapOk = true, followerOk = true;
    let leader: Car | null = null, follower: Car | null = null;
    for (const other of this.carsOn(target.id)) {
      if (other.s <= sNew) follower = other;
      else { leader = other; break; }
    }
    if (leader) {
      const gap = leader.s - leader.len - sNew;
      const need = S0 * 0.8 + Math.max(0, (car.v - leader.v)) * 0.9 + 0.5;
      leaderGapOk = gap > need;
    }
    if (follower) {
      const gap = sNew - car.len - follower.s;
      const relaxed = car.v < 1 && follower.v < 1;
      const need = relaxed ? 1.2 : S0 * 0.8 + Math.max(0, (follower.v - car.v)) * 1.1;
      followerOk = gap > need;
    }
    if (!(leaderGapOk && followerOk)) {
      // if running out of room, slow down to find a gap
      const remain = fromLane.poly.len - car.s;
      if (remain < 22) {
        // virtual obstacle near the end of the lane forces deceleration
        car.v = Math.min(car.v, Math.max(1.2, remain * 0.35));
      }
      return;
    }

    // execute
    const oldPos = polyPoint(fromLane.poly, car.s);
    const newPos = polyPoint(target.poly, sNew);
    car.lcVec = { x: oldPos.x - newPos.x, y: oldPos.y - newPos.y };
    car.lcT = 0;
    car.pi++;
    car.s = sNew;
  }

  /** discretionary lane change to get around slow traffic (semis etc.) */
  private considerOvertake(car: Car, leader: Obstacle) {
    if (car.lcCooldown > 0) return;
    car.lcCooldown = 1.4 + this.rng.next() * 0.8;
    const cur = car.cur()!;
    const lane = this.net.lane(cur.id);
    if (!lane) return;
    const myDesired = lane.speed * car.spec.v0f;
    // only worth it when the guy ahead is meaningfully slower and close
    if (leader.gap > 36 || leader.v > myDesired - 1.6) return;
    const remain = lane.poly.len - car.s;
    if (remain < 35) return;            // too close to the junction to dance

    for (const adj of this.net.adjacentLanes(cur.id)) {
      if (adj.def.kind !== 'drive') continue;
      const sNew = adj.poly.len - (lane.poly.len - car.s);
      if (sNew < 1 || sNew > adj.poly.len - 35) continue;

      // target lane must actually be better
      let tLeader: Car | null = null, tFollower: Car | null = null;
      for (const other of this.carsOn(adj.id)) {
        if (other.s <= sNew) tFollower = other;
        else { tLeader = other; break; }
      }
      if (tLeader) {
        const tGap = tLeader.s - tLeader.len - sNew;
        if (tGap < leader.gap + 10 && tLeader.v < leader.v + 2.5) continue; // no gain
        if (tGap < S0 + Math.max(0, car.v - tLeader.v) * 1.2 + 2) continue; // unsafe
      }
      if (tFollower) {
        const fGap = sNew - car.len - tFollower.s;
        if (fGap < S0 + Math.max(0, tFollower.v - car.v) * 1.4 + 2) continue;
      }
      // must still be able to reach the destination from over there
      const route = this.router.findRoute(adj.id, car.goal, car.kind);
      if (!route) continue;

      const oldPos = polyPoint(lane.poly, car.s);
      const newPos = polyPoint(adj.poly, sNew);
      car.lcVec = { x: oldPos.x - newPos.x, y: oldPos.y - newPos.y };
      car.lcT = 0;
      car.pieces = route.map(r => ({ kind: r.kind, id: r.id }));
      car.pi = 0;
      car.s = sNew;
      car.lcCooldown = 6;
      return;
    }
  }

  private failedLaneChange(car: Car, dt: number) {
    // stuck at end of lane needing an LC; after a while, bail out via any
    // available connector and replan from there
    if (car.waitTime < 9) return;
    const cur = car.cur()!;
    const conns = this.net.connsFrom(cur.id);
    if (!conns.length) { car.forceReroute = true; return; }
    const pick = conns[Math.floor(this.rng.next() * conns.length)];
    const after = this.net.lane(pick.to);
    if (!after) return;
    const route = this.router.findRoute(pick.to, car.goal, car.kind);
    car.pieces = [
      { kind: 'lane', id: cur.id },
      { kind: 'conn', id: pick.id },
      ...(route ? route.map(r => ({ kind: r.kind, id: r.id } as PathPiece)) : [{ kind: 'lane', id: pick.to } as PathPiece]),
    ];
    car.pi = 0;
    car.waitTime = 0;
  }

  /* ---------------- junction negotiation ---------------- */

  private junctionLogic(car: Car, obstacles: Obstacle[], dt: number) {
    const cur = car.cur();
    if (!cur) return;

    if (cur.kind === 'conn') {
      this.connectorYield(car, this.net.conn(cur.id)!, obstacles);
      return;
    }

    const nxt = car.next();
    if (!nxt || nxt.kind !== 'conn') return;
    const conn = this.net.conn(nxt.id);
    if (!conn) { car.forceReroute = true; return; }
    const lane = this.net.lane(cur.id);
    if (!lane) return;
    const node = this.net.nodes.get(conn.node);
    if (!node) return;

    const distToLine = lane.poly.len - car.s;
    if (distToLine > CHECK_DIST) return;

    const stopAtLine = () => {
      obstacles.push({ gap: Math.max(0.05, distToLine - 0.4), v: 0 });
    };

    // --- traffic lights ---
    if (node.control.kind === 'lights') {
      const light = this.signals.lightFor(node, conn);
      if (light === 'red') { stopAtLine(); return; }
      if (light === 'yellow') {
        const canStop = (car.v * car.v) / (2 * Math.max(0.3, distToLine)) <= 3.4;
        if (canStop) { stopAtLine(); return; }
      }
      // green: still yield on permissive movements (e.g. unprotected lefts)
      if (this.greenConflictBlocked(car, node, conn)) { stopAtLine(); return; }
      if (this.spillbackBlocked(car, conn)) { stopAtLine(); return; }
      return;
    }

    // shape nodes (degree <= 2) have no negotiation — plain car-following
    // handles spacing; gating them causes phantom stops at curve nodes
    if (!node.isJunction) return;

    // --- signs / open junctions ---
    const sign = this.net.signFor(node, conn.fromSeg);
    const mustStop = sign === 'stop' || sign === 'blinkR';

    if (mustStop && !car.stoppedAtLine) {
      if (car.v < 0.25 && distToLine < 3) {
        car.stoppedAtLine = true;
        const tk = (this.tickets.get(node.id) ?? 0) + 1;
        this.tickets.set(node.id, tk);
        car.ticket = tk;
      } else {
        stopAtLine();
        return;
      }
    }

    if (this.entryBlocked(car, node, conn, distToLine)) {
      stopAtLine();
      return;
    }
    if (this.spillbackBlocked(car, conn)) { stopAtLine(); return; }
  }

  /** cars physically on conflicting connectors, or priority traffic approaching */
  private entryBlocked(car: Car, node: RNode, conn: Connector, distToLine: number): boolean {
    if (!node.isJunction || conn.conflicts.length === 0) return false;

    // hard rule: never enter while a conflicting connector is occupied ahead of the crossing
    for (const cf of conn.conflicts) {
      for (const other of this.carsOn(cf.other)) {
        if (other.s - other.len < cf.sOther + 0.5) return true;
      }
    }

    if (car.waitTime > 26) return false;  // anti-starvation: creep through

    // approaching priority traffic (gap acceptance)
    const relaxed = car.waitTime > 13;
    if (!relaxed) {
      for (const cf of conn.conflicts) {
        const other = this.net.conn(cf.other);
        if (!other) continue;
        const otherSign = this.net.signFor(node, other.fromSeg);
        const iYield = !hasPriority(this.net, node, conn, other);
        if (!iYield) continue;
        // cars on the other approach lane heading for that connector
        const srcLane = this.net.lane(other.from);
        if (!srcLane) continue;
        for (const oc of this.carsOn(other.from)) {
          const oNext = oc.next();
          if (!oNext || oNext.id !== other.id) continue;
          const d = srcLane.poly.len - oc.s;
          if (d > 42) continue;
          // a stopped car that must itself stop isn't an immediate threat
          if (oc.v < 0.4 && (otherSign === 'stop' || otherSign === 'blinkR') && !oc.stoppedAtLine) continue;
          const tArrive = d / Math.max(oc.v, 2.5);
          const myCross = (distToLine + conn.poly.len) / Math.max(car.v, 3.5);
          if (tArrive < Math.max(GAP_TIME, myCross * 0.8)) {
            // FCFS between mutually stopped cars
            if (car.stoppedAtLine && oc.stoppedAtLine) {
              if (car.ticket >= 0 && oc.ticket >= 0 && car.ticket < oc.ticket) continue;
            }
            return true;
          }
        }
      }
    } else {
      // relaxed: only block on cars about to enter (very close & moving)
      for (const cf of conn.conflicts) {
        const other = this.net.conn(cf.other);
        if (!other) continue;
        const srcLane = this.net.lane(other.from);
        if (!srcLane) continue;
        for (const oc of this.carsOn(other.from)) {
          const oNext = oc.next();
          if (!oNext || oNext.id !== other.id) continue;
          const d = srcLane.poly.len - oc.s;
          if (d < 7 && oc.v > 2) return true;
        }
      }
    }
    return false;
  }

  /** on green: permissive movements still yield to conflicting green traffic */
  private greenConflictBlocked(car: Car, node: RNode, conn: Connector): boolean {
    if (conn.conflicts.length === 0) return false;
    // occupied conflicting connectors always block
    for (const cf of conn.conflicts) {
      for (const other of this.carsOn(cf.other)) {
        if (other.s - other.len < cf.sOther + 0.5) return true;
      }
    }
    if (car.waitTime > 24) return false;
    // approaching green traffic with priority (straight beats left, etc.)
    for (const cf of conn.conflicts) {
      const other = this.net.conn(cf.other);
      if (!other) continue;
      if (this.signals.lightFor(node, other) === 'red') continue;
      if (hasPriority(this.net, node, conn, other)) continue;
      const srcLane = this.net.lane(other.from);
      if (!srcLane) continue;
      for (const oc of this.carsOn(other.from)) {
        const oNext = oc.next();
        if (!oNext || oNext.id !== other.id) continue;
        const d = srcLane.poly.len - oc.s;
        if (d > 45) continue;
        const tArrive = d / Math.max(oc.v, 2.5);
        if (tArrive < GAP_TIME) return true;
      }
    }
    return false;
  }

  /** don't block the box: need room on the connector and the exit lane */
  private spillbackBlocked(car: Car, conn: Connector): boolean {
    const onConn = this.carsOn(conn.id);
    if (onConn.length) {
      const last = onConn[0];
      if (last.s - last.len < car.len + 1.2) return true;
    }
    const exitCars = this.carsOn(conn.to);
    if (exitCars.length) {
      const first = exitCars[0];
      if (first.v < 0.4 && first.s - first.len < car.len + 1.5) return true;
    }
    return false;
  }

  /** while crossing: yield at conflict points to cars that beat us there */
  private connectorYield(car: Car, conn: Connector, obstacles: Obstacle[]) {
    for (const cf of conn.conflicts) {
      if (car.s > cf.sMine - 0.8) continue;   // already past / at the point
      const myDist = cf.sMine - car.s;
      for (const other of this.carsOn(cf.other)) {
        if (other.s - other.len > cf.sOther) continue;  // they passed it
        const theirDist = cf.sOther - other.s;
        const node = this.net.nodes.get(conn.node);
        const otherConn = this.net.conn(cf.other);
        let theyWin: boolean;
        if (cf.merge) theyWin = theirDist < myDist - 0.3;
        else if (Math.abs(theirDist - myDist) < 1.2 && node && otherConn) {
          theyWin = hasPriority(this.net, node, otherConn, conn);
        } else theyWin = theirDist < myDist;
        if (theyWin) {
          obstacles.push({ gap: Math.max(0.1, myDist - 1.6), v: 0 });
          break;
        }
      }
    }
  }
}
