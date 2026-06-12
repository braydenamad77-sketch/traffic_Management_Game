// localStorage persistence for the road network + map choice.

import { Network, Control } from './network';

const KEY = 'gridlock-save-v1';

interface SaveData {
  v: number;
  map: string;
  nodes: { id: number; x: number; y: number; control: Control; gate: { rate: number; industrial?: boolean } | null; showTurnHelpers?: boolean }[];
  segs: { id: number; a: number; b: number; type: string; spd?: number | null; bans?: string[] }[];
}

export function save(net: Network, mapId: string) {
  const data: SaveData = {
    v: 1,
    map: mapId,
    nodes: [...net.nodes.values()].map(n => ({
      id: n.id, x: n.pos.x, y: n.pos.y, control: n.control, gate: n.gate,
      showTurnHelpers: n.showTurnHelpers || undefined,
    })),
    segs: [...net.segs.values()].map(s => ({
      id: s.id, a: s.a, b: s.b, type: s.type,
      spd: s.speedLimit, bans: s.bans.length ? s.bans : undefined,
    })),
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch { /* storage full or denied — ignore */ }
}

export function load(net: Network): string | null {
  let data: SaveData;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || data.v !== 1) return null;
  try {
    for (const n of data.nodes) {
      const node = net.addNode({ x: n.x, y: n.y }, n.id);
      node.control = n.control ?? { kind: 'open' };
      node.gate = n.gate ?? null;
      node.showTurnHelpers = !!n.showTurnHelpers;
    }
    for (const s of data.segs) {
      const seg = net.addSegment(s.a, s.b, s.type, s.id);
      if (seg) {
        seg.speedLimit = s.spd ?? null;
        seg.bans = (s.bans as typeof seg.bans) ?? [];
      }
    }
    net.rebuild();
    return data.map ?? 'plains';
  } catch {
    return null;
  }
}

export function clearSave() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}
