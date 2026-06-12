// localStorage persistence for the road network + map choice.

import { Network } from './network';
import { LevelData, exportNetwork, importNetwork } from './levelData';

const KEY = 'gridlock-save-v1';

export function save(net: Network, mapId: string) {
  const data = exportNetwork(net, mapId);
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch { /* storage full or denied — ignore */ }
}

export function load(net: Network): string | null {
  let data: LevelData;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || data.v !== 1) return null;
  try {
    return importNetwork(net, data);
  } catch {
    return null;
  }
}

export function clearSave() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}
