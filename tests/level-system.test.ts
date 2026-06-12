import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { exportNetwork, importNetwork } from '../src/levelData';
import { buildLevel, defineLevel, validateLevel } from '../src/levelKit';
import { Network } from '../src/network';
import { createObjectiveRun, resetObjectiveRun, updateObjectiveRun } from '../src/objective';
import { SeededRng } from '../src/rng';
import { Sim, SimStats } from '../src/sim';
import { CAMPAIGN_LEVELS } from '../levels';
import simpleTwoGate from '../levels/simple-two-gate';
import fourWaySignal from '../levels/four-way-signal';
import tightCurveStress from '../levels/tight-curve-stress';

test('level data round-trips through portable JSON shape', () => {
  const built = buildLevel(fourWaySignal);
  const data = exportNetwork(built.net, built.map);
  const imported = new Network();
  const map = importNetwork(imported, JSON.parse(JSON.stringify(data)));

  assert.equal(map, 'plains');
  assert.equal(imported.nodes.size, built.net.nodes.size);
  assert.equal(imported.segs.size, built.net.segs.size);
  assert.equal(imported.lanesById.size, built.net.lanesById.size);
  assert.equal(imported.connsById.size, built.net.connsById.size);
  assert.deepEqual(validateLevel(imported).errors, []);
});

test('builder creates roads, curves, gates, signs, and clean validation', () => {
  const built = buildLevel(tightCurveStress);
  const validation = validateLevel(built.net);

  assert.deepEqual(validation.errors, []);
  assert.deepEqual(validation.warnings, []);
  assert.equal(validation.stats.gates, 3);
  assert.ok(built.names.nodes.has('tight-bend.4'));
  assert.ok(built.names.segments.has('side-spur'));
});

test('validation reports invalid signal movements', () => {
  const bad = defineLevel({
    id: 'bad-signal',
    name: 'Bad Signal',
    map: 'plains',
    build(ctx) {
      ctx.node('center', [320, 200]);
      ctx.node('west', [120, 200]);
      ctx.node('east', [520, 200]);
      ctx.node('north', [320, 80]);
      ctx.road.between('west-leg', 'west', 'center');
      ctx.road.between('east-leg', 'center', 'east');
      ctx.road.between('north-leg', 'north', 'center');
      ctx.signal.set('center', { kind: 'lights', yellow: 3, phases: [{ dur: 10, green: ['999|L'] }] });
    },
  });

  const validation = validateLevel(buildLevel(bad).net);
  assert.ok(validation.errors.some(err => err.includes('invalid movement 999|L')));
});

test('seeded simulation is deterministic for the same level and seed', () => {
  const run = () => {
    const built = buildLevel(simpleTwoGate);
    const sim = new Sim(built.net, new SeededRng(1234));
    for (let i = 0; i < 60 * 20; i++) sim.step(1 / 60);
    return sim.stats();
  };

  assert.deepEqual(run(), run());
});

test('campaign levels are ordered, objective-backed, and validate cleanly', () => {
  const targets = [25, 40, 55, 70, 85, 100, 120, 145, 170, 220];

  assert.equal(CAMPAIGN_LEVELS.length, 10);
  CAMPAIGN_LEVELS.forEach((level, i) => {
    assert.equal(level.campaign?.difficulty, i + 1);
    assert.equal(level.campaign?.objective.targetArrivals, targets[i]);
    assert.equal(level.campaign?.objective.maxGridlockEvents, 0);

    const built = buildLevel(level);
    const validation = validateLevel(built.net);
    assert.deepEqual(validation.errors, [], level.id);
    assert.deepEqual(validation.warnings, [], level.id);
    assert.ok(validation.stats.gates >= 2, level.id);
  });
});

test('objective runs track progress, wins, failures, and resets', () => {
  const level = CAMPAIGN_LEVELS[0];
  const stats = (arrived: number, gridlocked = false): SimStats => ({
    carCount: gridlocked ? 18 : 4,
    arrived,
    flowPerMin: 0,
    avgTrip: 0,
    gridlocked,
  });

  assert.equal(createObjectiveRun(null).status, 'custom');

  let run = createObjectiveRun(level, 10);
  assert.equal(run.status, 'running');
  assert.equal(run.progress, 0);

  run = updateObjectiveRun(run, stats(24));
  assert.equal(run.progress, 14);
  assert.equal(run.status, 'running');

  run = updateObjectiveRun(run, stats(35));
  assert.equal(run.progress, 25);
  assert.equal(run.status, 'won');

  run = resetObjectiveRun(run, 40);
  assert.equal(run.progress, 0);
  assert.equal(run.status, 'running');

  run = updateObjectiveRun(run, stats(41, true));
  assert.equal(run.gridlockEvents, 1);
  assert.equal(run.status, 'failed');

  run = updateObjectiveRun(run, stats(80, false));
  assert.equal(run.status, 'failed');
});

test('headless render CLI writes a non-empty exact-size PNG', async () => {
  const out = 'artifacts/level-renders/test-smoke.png';
  execFileSync('npm', [
    'run',
    'level:render',
    '--',
    '--level',
    'simple-two-gate',
    '--center',
    '320,200',
    '--zoom',
    '4',
    '--size',
    '640x360',
    '--ids',
    'all',
    '--grid',
    '--out',
    out,
  ], { stdio: 'pipe' });

  assert.ok(existsSync(out));
  assert.ok(existsSync(out.replace(/\.png$/, '.json')));

  const img = await loadImage(out);
  assert.equal(img.width, 640);
  assert.equal(img.height, 360);

  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const pixels = ctx.getImageData(260, 150, 120, 60).data;
  let nonBackground = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const [r, g, b, a] = [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]];
    if (a > 0 && !(r > 105 && r < 140 && g > 140 && g < 175 && b > 80 && b < 110)) nonBackground++;
  }
  assert.ok(nonBackground > 500, `expected visible road/debug pixels, got ${nonBackground}`);
});
