// Traffic signal runtime + auto-phase presets + priority rules between
// conflicting movements at a junction.

import { Network, RNode, Phase, Connector, SignKind, Turn } from './network';
import { signedAngle } from './vec';

export type LightState = 'green' | 'yellow' | 'red';

interface JunctionSignal {
  phaseIdx: number;
  t: number;            // time into current stage
  stage: 'green' | 'yellow' | 'allred';
}

const ALL_RED = 1.2;

export class SignalSystem {
  private states = new Map<number, JunctionSignal>();

  constructor(private net: Network) {}

  step(dt: number) {
    for (const node of this.net.nodes.values()) {
      if (node.control.kind !== 'lights' || node.control.phases.length === 0) {
        this.states.delete(node.id);
        continue;
      }
      let st = this.states.get(node.id);
      if (!st || st.phaseIdx >= node.control.phases.length) {
        st = { phaseIdx: 0, t: 0, stage: 'green' };
        this.states.set(node.id, st);
      }
      st.t += dt;
      const phases = node.control.phases;
      const yellow = node.control.yellow;
      if (st.stage === 'green' && st.t >= phases[st.phaseIdx].dur) {
        st.stage = 'yellow'; st.t = 0;
      } else if (st.stage === 'yellow' && st.t >= yellow) {
        st.stage = 'allred'; st.t = 0;
      } else if (st.stage === 'allred' && st.t >= ALL_RED) {
        st.stage = 'green'; st.t = 0;
        st.phaseIdx = (st.phaseIdx + 1) % phases.length;
      }
    }
  }

  /** Light shown to a movement (connector) at a signalized junction. */
  lightFor(node: RNode, conn: Connector): LightState {
    if (node.control.kind !== 'lights') return 'green';
    const st = this.states.get(node.id);
    if (!st) return 'green';
    if (st.stage === 'allred') return 'red';
    const green = node.control.phases[st.phaseIdx]?.green ?? [];
    if (!green.includes(conn.movement)) return 'red';
    return st.stage === 'yellow' ? 'yellow' : 'green';
  }

  /** Worst-case light across an approach (for rendering signal heads). */
  lightForApproach(node: RNode, segId: number): LightState {
    if (node.control.kind !== 'lights') return 'green';
    const st = this.states.get(node.id);
    if (!st) return 'green';
    if (st.stage === 'allred') return 'red';
    const green = node.control.phases[st.phaseIdx]?.green ?? [];
    const mine = node.conns.filter(c => c.fromSeg === segId);
    if (mine.length === 0) return 'red';
    const anyGreen = mine.some(c => green.includes(c.movement));
    if (!anyGreen) return 'red';
    return st.stage === 'yellow' ? 'yellow' : 'green';
  }

  currentPhase(node: RNode): number {
    return this.states.get(node.id)?.phaseIdx ?? 0;
  }

  resetJunction(nodeId: number) {
    this.states.delete(nodeId);
  }
}

/* ---------------- priority rules ---------------- */

const SIGN_RANK: Record<SignKind, number> = { none: 3, blinkY: 3, yield: 2, blinkR: 1, stop: 1 };
const TURN_RANK: Record<Turn, number> = { S: 3, R: 2, L: 1 };

/**
 * Does movement `a` have priority over conflicting movement `b` at this node?
 * Both are assumed currently *permitted* (green or unsignalized).
 * Cascade: sign rank > turn class > right-hand rule.
 */
export function hasPriority(net: Network, node: RNode, a: Connector, b: Connector): boolean {
  if (node.control.kind === 'signs') {
    const ra = SIGN_RANK[net.signFor(node, a.fromSeg)];
    const rb = SIGN_RANK[net.signFor(node, b.fromSeg)];
    if (ra !== rb) return ra > rb;
  }
  if (TURN_RANK[a.turn] !== TURN_RANK[b.turn]) return TURN_RANK[a.turn] > TURN_RANK[b.turn];
  // right-hand rule: priority to the vehicle coming from the other's right.
  const ha = node.approaches.find(ap => ap.seg === a.fromSeg)?.heading;
  const hb = node.approaches.find(ap => ap.seg === b.fromSeg)?.heading;
  if (ha && hb) {
    const ang = signedAngle(hb, ha); // positive: a arrives from b's right-ish
    if (Math.abs(ang) > 0.3) return ang > 0;
  }
  return a.id < b.id; // deterministic tiebreak
}

/* ---------------- auto presets ---------------- */

/** Group approaches into two axes by heading, returns phase sets. */
export function autoPhases(node: RNode, protectedLefts: boolean): Phase[] {
  const aps = node.approaches;
  if (aps.length < 3) return [];
  // cluster approaches: same axis if |angle between headings| close to 0 or PI
  const groups: number[][] = [];
  const used = new Set<number>();
  for (let i = 0; i < aps.length; i++) {
    if (used.has(i)) continue;
    const g = [i];
    used.add(i);
    for (let j = i + 1; j < aps.length; j++) {
      if (used.has(j)) continue;
      const ang = Math.abs(signedAngle(aps[i].heading, aps[j].heading));
      if (ang > Math.PI * 0.7) { g.push(j); used.add(j); }
    }
    groups.push(g);
  }

  const movesOf = (idx: number[], turns: Turn[]): string[] => {
    const out: string[] = [];
    for (const i of idx) {
      for (const t of turns) {
        if (aps[i].turns[t]?.length) out.push(`${aps[i].seg}|${t}`);
      }
    }
    return out;
  };

  const phases: Phase[] = [];
  for (const g of groups) {
    if (protectedLefts) {
      const lefts = movesOf(g, ['L']);
      const thru = movesOf(g, ['S', 'R']);
      if (lefts.length) phases.push({ dur: 8, green: lefts });
      if (thru.length) phases.push({ dur: 16, green: thru });
    } else {
      const all = movesOf(g, ['L', 'S', 'R']);
      if (all.length) phases.push({ dur: 18, green: all });
    }
  }
  return phases.length >= 2 ? phases : [];
}

/** Is a left movement permissive (conflicting oncoming green in same phase)? */
export function isPermissiveLeft(node: RNode, movement: string, phase: Phase): boolean {
  const [segStr, turn] = movement.split('|');
  if (turn !== 'L') return false;
  const conns = node.conns.filter(c => c.movement === movement);
  for (const c of conns) {
    for (const cf of c.conflicts) {
      const other = node.conns.find(x => x.id === cf.other);
      if (other && other.turn !== 'L' && phase.green.includes(other.movement)) return true;
    }
  }
  return false;
}
