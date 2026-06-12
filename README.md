# GRIDLOCK — Traffic Operations

A top-down 2D traffic management sandbox. Draw road networks with smooth,
node-based splines (Cities: Skylines style), place spawn gates, and keep the
cars moving with signs and fully programmable traffic signals.

## Run it

```bash
npm install
npm run dev
```

Then open the printed localhost URL. `npm run build` produces a static bundle
in `dist/`.

## How to play

1. **Build road (R)** — click to place points; click an existing road to
   connect or draw straight across one to auto-create an intersection.
   **Grid** placement snaps to the street grid, **Free** places anywhere
   (still physical — it quietly snaps to a fine grid). Esc/right-click ends
   the chain.
2. **Spawn gate (G)** — click a dead-end road tip. Cars spawn there and pick
   a random other gate as their destination. Tune the rate per gate.
3. **Edit nodes (E)** — drag any node and the road curves smoothly through
   it. Click a road to insert a node. Del dissolves/removes.
4. **Inspect (V)** — click an intersection to choose control:
   - **Right of way** — common-sense rules (straight beats turns, lefts
     yield, tie goes to the right).
   - **Signs** — per-approach Stop / Yield / blinking beacons.
   - **Signals** — programmable phases. Click the movement arrows in each
     phase diagram to toggle green; dashed green = permissive (still yields).
     Auto presets for simple two-phase or protected lefts.
   Clicking a road section with a road type selected converts it.
5. **Bulldoze (X)** — remove roads and intersections.

Districts (top bar) offer different terrain — roads drawn over water become
bridges automatically. The Heatmap button overlays live congestion.

## Road types

| Type | Lanes |
| --- | --- |
| One-way street | 1, single direction |
| Two-way street | 1 + 1 |
| Turn-lane road | 1 + 1 with a center left-turn pocket |
| Avenue | 2 + 2 |
| Boulevard | 3 + 3 |

## The cars are not stupid

Each car has a destination and routes over the *lane* graph with A*,
factoring in live congestion, then re-routes around jams. They follow IDM
car-following physics (smooth acceleration, comfortable braking, headway
keeping), pick the correct lane for their next turn, merge into center turn
pockets, accept gaps at unsignalized junctions, yield on permissive lefts,
refuse to block the box, and creep through if a junction starves them too
long. Brake lights and turn signals included.

## Tech

TypeScript + Vite, HTML5 Canvas, zero runtime dependencies. Roads are a graph
of nodes and segments rendered as Catmull-Rom-continuous Béziers; lanes,
junction geometry, turn connectors and conflict points are derived from the
graph on every edit. State autosaves to localStorage.
