import { Control, Network } from './network';
import { ROAD_TYPES, VehicleKind } from './roadTypes';

export interface LevelData {
  v: 1;
  map: string;
  nodes: {
    id: number;
    x: number;
    y: number;
    control: Control;
    gate: { rate: number; industrial?: boolean } | null;
    showTurnHelpers?: boolean;
  }[];
  segs: {
    id: number;
    a: number;
    b: number;
    type: string;
    spd?: number | null;
    bans?: VehicleKind[];
  }[];
}

const ROAD_TYPE_IDS = new Set(ROAD_TYPES.map(rt => rt.id));

export function exportNetwork(net: Network, mapId: string): LevelData {
  return {
    v: 1,
    map: mapId,
    nodes: [...net.nodes.values()].map(n => ({
      id: n.id,
      x: n.pos.x,
      y: n.pos.y,
      control: n.control,
      gate: n.gate,
      showTurnHelpers: n.showTurnHelpers || undefined,
    })),
    segs: [...net.segs.values()].map(s => ({
      id: s.id,
      a: s.a,
      b: s.b,
      type: s.type,
      spd: s.speedLimit,
      bans: s.bans.length ? [...s.bans] : undefined,
    })),
  };
}

export function importNetwork(net: Network, data: LevelData): string {
  if (!data || data.v !== 1) throw new Error('Unsupported level data version.');
  net.clear();

  for (const n of data.nodes) {
    const node = net.addNode({ x: n.x, y: n.y }, n.id);
    node.control = n.control ?? { kind: 'open' };
    node.gate = n.gate ?? null;
    node.showTurnHelpers = !!n.showTurnHelpers;
  }

  for (const s of data.segs) {
    if (!ROAD_TYPE_IDS.has(s.type)) throw new Error(`Unknown road type: ${s.type}`);
    const seg = net.addSegment(s.a, s.b, s.type, s.id);
    if (!seg) throw new Error(`Could not add segment ${s.id} from ${s.a} to ${s.b}.`);
    seg.speedLimit = s.spd ?? null;
    seg.bans = [...(s.bans ?? [])];
  }

  net.rebuild();
  return data.map ?? 'plains';
}

