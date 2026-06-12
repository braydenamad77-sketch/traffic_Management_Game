import { V, pointInPolygon } from './vec';

export const WORLD_W = 640;
export const WORLD_H = 400;

export interface TerrainMap {
  id: string;
  name: string;
  water: V[][];      // water polygons
  trees: V[];        // decorative
}

function wavyStrip(cx: number, amp: number, period: number, halfW: number, lean: number): V[] {
  // vertical river strip: left bank down, right bank up
  const left: V[] = [], right: V[] = [];
  for (let y = -30; y <= WORLD_H + 30; y += 14) {
    const x = cx + Math.sin(y / period) * amp + (y - WORLD_H / 2) * lean;
    left.push({ x: x - halfW, y });
    right.push({ x: x + halfW, y });
  }
  return [...left, ...right.reverse()];
}

function blob(cx: number, cy: number, r: number, squish: number, seed: number): V[] {
  const pts: V[] = [];
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2;
    const wobble = 1 + 0.22 * Math.sin(a * 3 + seed) + 0.12 * Math.sin(a * 5 + seed * 2.7);
    pts.push({ x: cx + Math.cos(a) * r * wobble, y: cy + Math.sin(a) * r * squish * wobble });
  }
  return pts;
}

function scatterTrees(seed: number, count: number, water: V[][]): V[] {
  // deterministic pseudo-random scatter avoiding water
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const out: V[] = [];
  let guard = 0;
  while (out.length < count && guard++ < count * 8) {
    const p = { x: rnd() * WORLD_W, y: rnd() * WORLD_H };
    if (!water.some(w => pointInPolygon(p, w))) out.push(p);
  }
  return out;
}

function buildMaps(): TerrainMap[] {
  const riverWater = [wavyStrip(WORLD_W * 0.52, 22, 95, 17, 0.06)];
  const lakesWater = [
    blob(WORLD_W * 0.3, WORLD_H * 0.3, 52, 0.78, 1.7),
    blob(WORLD_W * 0.72, WORLD_H * 0.72, 62, 0.7, 4.2),
  ];
  return [
    { id: 'plains', name: 'Open Plains', water: [], trees: scatterTrees(7, 110, []) },
    { id: 'river', name: 'Riverside', water: riverWater, trees: scatterTrees(13, 100, riverWater) },
    { id: 'lakes', name: 'Twin Lakes', water: lakesWater, trees: scatterTrees(29, 95, lakesWater) },
  ];
}

export const MAPS = buildMaps();

export function getMap(id: string): TerrainMap {
  return MAPS.find(m => m.id === id) ?? MAPS[0];
}

export function inWater(map: TerrainMap, p: V): boolean {
  return map.water.some(w => pointInPolygon(p, w));
}
