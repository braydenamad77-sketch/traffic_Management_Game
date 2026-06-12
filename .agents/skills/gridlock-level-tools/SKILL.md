---
name: gridlock-level-tools
description: Build, validate, export, import, and render GRIDLOCK traffic-management levels and diagnostic scenes with the project-local TypeScript level kit. Use when working in the traffic_Management_Game repo on level authoring, road graph fixtures, scripted scene creation, exact camera screenshots, no-browser visual debugging, graphical diagnostics, reproducing rendering issues at specific coordinates/zooms, seeded simulation renders, or tests around level topology/rendering.
---

# GRIDLOCK Level Tools

Use the checked-in TypeScript level kit instead of hand-editing saved localStorage data or manually clicking roads in the UI. The source of truth is scene scripts under `levels/`; generated PNGs and sidecar JSON belong under `artifacts/level-renders/`.

## Core Workflow

1. Inspect existing examples in `levels/`, especially `simple-two-gate.ts`, `four-way-signal.ts`, and `multi-lane-merge.ts`.
2. Create or edit a scene script with `defineLevel({ id, name, map, build })`.
3. Build roads through the `LevelBuilder` helpers in `levelKit.ts`.
4. Run validation before rendering:
   ```bash
   npm run level:validate -- --level <level-id>
   ```
5. Render exact shots for visual inspection:
   ```bash
   npm run level:render -- --level <level-id> --center 320,200 --zoom 4 --size 1280x800 --out artifacts/level-renders/<name>.png
   ```
6. Open/read the generated PNG and inspect the sibling `.json` sidecar for camera, validation, sim stats, and selected-object details.

## Scene Script Pattern

Use this shape:

```ts
import { defineLevel } from '../src/levelKit';

export default defineLevel({
  id: 'my-level',
  name: 'My Level',
  map: 'plains',
  build(ctx) {
    ctx.node('west', [120, 200]);
    ctx.node('center', [320, 200]);
    ctx.node('east', [520, 200]);

    ctx.road.between('west-leg', 'west', 'center', { type: '2w2' });
    ctx.road.between('east-leg', 'center', 'east', { type: '2w2' });
    ctx.gate.atNode('west', { rate: 12 });
    ctx.gate.atNode('east', { rate: 12 });

    ctx.shot('overview', { center: [320, 200], zoom: 3, size: [1280, 720] });
  },
});
```

After adding a new level file, register it in `levels/index.ts`.

## Builder Helpers

- `ctx.node(name, [x, y])`: create a named node.
- `ctx.road.between(name, from, to, { type })`: connect two named nodes or points.
- `ctx.road.polyline(name, points, { type })`: create a multi-segment road; generated segment aliases include `name:0`, `name:1`, etc.
- `ctx.road.curve(name, start, control, end, { type, pieces })`: approximate a quadratic curve with editable nodes; generated node aliases include `name.1`, `name.2`, etc.
- `ctx.road.speed(name, speed)`: set speed override on all segments in a named road.
- `ctx.road.ban(name, kindOrKinds)`: ban vehicle kinds such as `semi`.
- `ctx.gate.atNode(name, { rate, industrial })`: add a spawn/exit gate. Gates are bidirectional trip endpoints, so avoid one-way-only dead ends unless the missing return route is intentional.
- `ctx.signal.auto(node, { protectedLefts })`: add generated signal phases after the connected roads exist.
- `ctx.signal.signs(node, { roadName: 'stop' })`: set approach signs by named road.
- `ctx.shot(name, shot)`: define reusable camera presets.

Road types are `1w1`, `2w1`, `2wT`, `2w2`, and `2w3`.

## Rendering And Debugging

Use command flags for exact no-browser screenshots:

```bash
npm run level:render -- --level four-way-signal --shot junction-close
npm run level:render -- --level bridge-river --center 320,200 --zoom 3 --size 800x500 --ids segments
npm run level:render -- --level multi-lane-merge --shot heatmap --sim-seconds 45 --seed 42 --heatmap
```

Useful render flags:

- `--center x,y`, `--zoom n`, `--size WxH`, `--out file.png`
- `--grid`
- `--ids nodes|segments|lanes|all`
- `--selection node:<id>|seg:<id>`
- `--heatmap`
- `--sim-seconds n`
- `--seed n`

For portable data:

```bash
npm run level:export -- --level <level-id> --out artifacts/level-renders/<level-id>.json
npm run level:load-json -- --file artifacts/level-renders/<level-id>.json --out artifacts/level-renders/from-json.png
```

## Validation And Tests

Treat validation errors as blockers. Validation checks unknown road types, broken references, duplicate roads, invalid signal movements, and missing route coverage between gates. Warnings are usually worth fixing for starter fixtures, especially no gates, single gate, very short segments, controls on non-junctions, empty signal phases, and unreachable gate pairs.

Run:

```bash
npm test
npm run build
```

Use `levelData.ts` for JSON round-trips, `levelKit.ts` for builder/validation APIs, `rng.ts` for seeded simulation, and `level-cli.ts` for CLI behavior. Keep generated render outputs in `artifacts/level-renders/`; that path is gitignored.
