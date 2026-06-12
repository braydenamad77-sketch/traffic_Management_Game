import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { Camera } from '../src/camera';
import { importNetwork, exportNetwork, LevelData } from '../src/levelData';
import { buildLevel, BuiltLevel, LevelDecal, LevelShot, validateLevel } from '../src/levelKit';
import { Network } from '../src/network';
import { Renderer, RenderDebugOptions, SelectionRef } from '../src/render';
import { SeededRng } from '../src/rng';
import { Sim } from '../src/sim';
import { getMap } from '../src/terrain';
import { findLevel, LEVELS } from '../levels';

type Command = 'validate' | 'render' | 'export' | 'load-json';

interface RenderRequest {
  net: Network;
  map: string;
  levelId: string;
  shotName?: string;
  shot?: LevelShot;
  decals: LevelDecal[];
  out: string;
  center: [number, number];
  zoom: number;
  size: [number, number];
  debug: RenderDebugOptions;
  heatmap: boolean;
  simSeconds: number;
  seed: number | string;
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    level: { type: 'string' },
    file: { type: 'string' },
    out: { type: 'string' },
    shot: { type: 'string' },
    center: { type: 'string' },
    zoom: { type: 'string' },
    size: { type: 'string' },
    heatmap: { type: 'boolean' },
    grid: { type: 'boolean' },
    ids: { type: 'string' },
    selection: { type: 'string' },
    'sim-seconds': { type: 'string' },
    seed: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

const command = positionals[0] as Command | undefined;

if (values.help || !command) {
  printHelp();
  process.exit(command ? 0 : 1);
}

try {
  if (command === 'validate') await validateCommand();
  else if (command === 'render') await renderCommand();
  else if (command === 'export') await exportCommand();
  else if (command === 'load-json') await loadJsonCommand();
  else throw new Error(`Unknown command: ${command}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

async function validateCommand() {
  const level = loadLevelFromFlag();
  const validation = validateLevel(level.net);
  console.log(JSON.stringify({ level: level.def.id, map: level.map, ...validation }, null, 2));
  if (validation.errors.length) process.exit(1);
}

async function renderCommand() {
  const level = loadLevelFromFlag();
  const req = makeRenderRequest(level.net, level.map, level.def.id, level.shots);
  req.decals = level.decals;
  const result = await renderPng(req);
  console.log(JSON.stringify(result, null, 2));
}

async function exportCommand() {
  const level = loadLevelFromFlag();
  const out = stringValue('out') ?? `artifacts/level-renders/${level.def.id}.json`;
  await ensureParent(out);
  await writeFile(out, `${JSON.stringify(exportNetwork(level.net, level.map), null, 2)}\n`);
  console.log(JSON.stringify({ level: level.def.id, out: resolve(out) }, null, 2));
}

async function loadJsonCommand() {
  const file = requiredString('file');
  const raw = await readFile(file, 'utf8');
  const data = JSON.parse(raw) as LevelData;
  const net = new Network();
  const map = importNetwork(net, data);

  if (stringValue('out')) {
    const req = makeRenderRequest(net, map, file, {});
    const result = await renderPng(req);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const validation = validateLevel(net);
  console.log(JSON.stringify({ file: resolve(file), map, ...validation }, null, 2));
  if (validation.errors.length) process.exit(1);
}

function loadLevelFromFlag(): BuiltLevel {
  const id = requiredString('level');
  const def = findLevel(id);
  if (!def) throw new Error(`Unknown level "${id}". Available: ${LEVELS.map(level => level.id).join(', ')}`);
  return buildLevel(def);
}

function makeRenderRequest(
  net: Network,
  map: string,
  levelId: string,
  shots: Record<string, LevelShot>,
): RenderRequest {
  const shotName = stringValue('shot');
  const shot = shotName ? shots[shotName] : undefined;
  if (shotName && !shot) throw new Error(`Unknown shot "${shotName}". Available: ${Object.keys(shots).join(', ') || '(none)'}`);

  const center = stringValue('center') ? parsePair(stringValue('center')!, 'center') : shot?.center ?? [320, 200];
  const size = stringValue('size') ? parsePair(stringValue('size')!, 'size') : shot?.size ?? [1280, 720];
  const zoom = numberValue('zoom') ?? shot?.zoom ?? 2.6;
  const out = stringValue('out') ?? `artifacts/level-renders/${levelId}${shotName ? `-${shotName}` : ''}.png`;
  const overlaySet = new Set(shot?.overlays ?? []);
  const ids = stringValue('ids') ?? overlayValue(overlaySet, 'ids:');
  const selection = stringValue('selection') ?? shot?.selection;
  const heatmap = !!values.heatmap || overlaySet.has('heatmap');
  const grid = !!values.grid || overlaySet.has('grid');
  const simSeconds = numberValue('sim-seconds') ?? shot?.simSeconds ?? 0;
  const seed = stringValue('seed') ?? shot?.seed ?? 1;

  return {
    net,
    map,
    levelId,
    shotName,
    shot,
    decals: [],
    out,
    center,
    zoom,
    size,
    heatmap,
    simSeconds,
    seed,
    debug: {
      grid,
      ids: parseIds(ids),
      selection: selection ? parseSelection(selection) : null,
    },
  };
}

async function renderPng(req: RenderRequest) {
  const canvas = makeCanvas(req.size[0], req.size[1]);
  const camera = new Camera(canvas);
  camera.x = req.center[0];
  camera.y = req.center[1];
  camera.zoom = req.zoom;

  const sim = new Sim(req.net, new SeededRng(req.seed));
  if (req.simSeconds > 0 || req.heatmap) {
    const dt = 1 / 60;
    const steps = Math.max(0, Math.round(req.simSeconds / dt));
    for (let i = 0; i < steps; i++) sim.step(dt);
  }

  const renderer = new Renderer(canvas, camera, { createCanvas: makeCanvas, devicePixelRatio: 1 });
  renderer.render(req.net, sim, null, getMap(req.map), req.heatmap, sim.time, req.debug);
  drawDecals(canvas.getContext('2d'), req.decals);

  await ensureParent(req.out);
  await writeFile(req.out, canvas.toBuffer('image/png'));

  const validation = validateLevel(req.net);
  const sidecar = {
    level: req.levelId,
    map: req.map,
    shot: req.shotName ?? null,
    camera: { center: req.center, zoom: req.zoom, size: req.size },
    debug: req.debug,
    heatmap: req.heatmap,
    sim: { seconds: req.simSeconds, seed: req.seed, stats: sim.stats() },
    validation,
    selection: selectionDetails(req.net, req.debug.selection ?? null),
    png: resolve(req.out),
  };
  const sidecarPath = req.out.replace(/\.png$/i, '.json');
  await writeFile(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
  return { out: resolve(req.out), sidecar: resolve(sidecarPath), validation };
}

function drawDecals(ctx: CanvasRenderingContext2D, decals: LevelDecal[]) {
  for (const decal of decals) {
    ctx.save();
    ctx.fillStyle = decal.fill;
    ctx.strokeStyle = decal.stroke ?? decal.fill;
    ctx.lineWidth = decal.lineWidth ?? 0.7;
    if (decal.kind === 'circle') {
      ctx.beginPath();
      ctx.arc(decal.center[0], decal.center[1], decal.radius, 0, Math.PI * 2);
      ctx.fill();
      if (decal.stroke) ctx.stroke();
    } else {
      ctx.beginPath();
      decal.points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
      ctx.closePath();
      ctx.fill();
      if (decal.stroke) ctx.stroke();
    }
    ctx.restore();
  }
}

function makeCanvas(width: number, height: number) {
  const canvas = createCanvas(width, height) as any;
  canvas.getBoundingClientRect = () => ({ width, height });
  return canvas;
}

function selectionDetails(net: Network, selection: SelectionRef | null) {
  if (!selection) return null;
  if (selection.kind === 'node') {
    const node = net.nodes.get(selection.id);
    return node ? {
      kind: 'node',
      id: node.id,
      pos: node.pos,
      segments: [...node.segs],
      gate: node.gate,
      control: node.control.kind,
    } : null;
  }
  const seg = net.segs.get(selection.id);
  return seg ? {
    kind: 'seg',
    id: seg.id,
    a: seg.a,
    b: seg.b,
    type: seg.type,
    length: seg.poly.len,
    speedLimit: seg.speedLimit,
    bans: seg.bans,
  } : null;
}

function parseSelection(raw: string): SelectionRef {
  const [kind, idRaw] = raw.split(':');
  const id = Number(idRaw);
  if (!Number.isFinite(id)) throw new Error(`Invalid selection: ${raw}`);
  if (kind === 'node') return { kind: 'node', id };
  if (kind === 'seg') return { kind: 'seg', id };
  throw new Error(`Invalid selection kind: ${kind}`);
}

function parseIds(raw: string | undefined) {
  if (!raw) return null;
  if (raw === 'nodes' || raw === 'segments' || raw === 'lanes' || raw === 'all') return raw;
  throw new Error(`Invalid --ids value: ${raw}`);
}

function overlayValue(overlays: Set<string>, prefix: string): string | undefined {
  for (const overlay of overlays) {
    if (overlay.startsWith(prefix)) return overlay.slice(prefix.length);
  }
  return undefined;
}

function parsePair(raw: string, label: string): [number, number] {
  const parts = raw.includes('x') ? raw.split('x') : raw.split(',');
  if (parts.length !== 2) throw new Error(`Invalid --${label}: ${raw}`);
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error(`Invalid --${label}: ${raw}`);
  return [a, b];
}

function requiredString(name: keyof typeof values): string {
  const val = stringValue(name);
  if (!val) throw new Error(`Missing --${name}.`);
  return val;
}

function stringValue(name: keyof typeof values): string | undefined {
  const val = values[name];
  return typeof val === 'string' ? val : undefined;
}

function numberValue(name: keyof typeof values): number | undefined {
  const raw = stringValue(name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Invalid --${name}: ${raw}`);
  return n;
}

async function ensureParent(path: string) {
  await mkdir(dirname(resolve(path)), { recursive: true });
}

function printHelp() {
  console.log(`GRIDLOCK level tools

Commands:
  validate   --level <id>
  render     --level <id> [--shot name] [--center x,y] [--zoom n] [--size WxH] [--out file.png]
  export     --level <id> [--out file.json]
  load-json  --file file.json [--out file.png] [render flags]

Render flags:
  --grid
  --ids nodes|segments|lanes|all
  --selection node:<id>|seg:<id>
  --heatmap
  --sim-seconds <n>
  --seed <n>
`);
}
