// Road type catalog. Lane offsets are lateral distances from the segment
// centerline with positive = right of a->b travel. dir 1 = travels a->b.

export const LANE_W = 3.5;

export type VehicleKind = 'sedan' | 'suv' | 'pickup' | 'semi';

/** 1 world unit/s in mph, for UI display */
export const MPH = 2.237;

export interface LaneDef {
  off: number;
  dir: 1 | -1;
  kind: 'drive' | 'turn';
}

export interface RoadType {
  id: string;
  name: string;
  desc: string;
  lanes: LaneDef[];
  speed: number;        // u/s free-flow
  halfWidth: number;    // paved half width
  oneWay: boolean;
  centerTurn: boolean;
}

function rt(id: string, name: string, desc: string, lanes: LaneDef[], speed: number, oneWay = false, centerTurn = false): RoadType {
  const maxOff = Math.max(...lanes.map(l => Math.abs(l.off)));
  return { id, name, desc, lanes, speed, halfWidth: maxOff + LANE_W / 2 + 0.45, oneWay, centerTurn };
}

const L = LANE_W;

export const ROAD_TYPES: RoadType[] = [
  rt('1w1', 'One-way street', '1 lane · one direction', [
    { off: 0, dir: 1, kind: 'drive' },
  ], 13, true),

  rt('2w1', 'Two-way street', '1 + 1 lanes', [
    { off: L / 2, dir: 1, kind: 'drive' },
    { off: -L / 2, dir: -1, kind: 'drive' },
  ], 13),

  rt('2wT', 'Turn-lane road', '1 + 1 with center turn lane', [
    { off: L, dir: 1, kind: 'drive' },
    { off: -L, dir: -1, kind: 'drive' },
    { off: 0, dir: 1, kind: 'turn' },
    { off: 0, dir: -1, kind: 'turn' },
  ], 14),

  rt('2w2', 'Avenue', '2 + 2 lanes', [
    { off: L * 0.5, dir: 1, kind: 'drive' },
    { off: L * 1.5, dir: 1, kind: 'drive' },
    { off: -L * 0.5, dir: -1, kind: 'drive' },
    { off: -L * 1.5, dir: -1, kind: 'drive' },
  ], 16),

  rt('2w3', 'Boulevard', '3 + 3 lanes', [
    { off: L * 0.5, dir: 1, kind: 'drive' },
    { off: L * 1.5, dir: 1, kind: 'drive' },
    { off: L * 2.5, dir: 1, kind: 'drive' },
    { off: -L * 0.5, dir: -1, kind: 'drive' },
    { off: -L * 1.5, dir: -1, kind: 'drive' },
    { off: -L * 2.5, dir: -1, kind: 'drive' },
  ], 19),
];

export const roadType = (id: string): RoadType => ROAD_TYPES.find(r => r.id === id)!;
