import { defineLevel, LevelCampaignMeta } from '../src/levelKit';

function campaign(difficulty: LevelCampaignMeta['difficulty'], title: string, subtitle: string, targetArrivals: number): LevelCampaignMeta {
  return {
    difficulty,
    title,
    subtitle,
    objective: { targetArrivals, maxGridlockEvents: 0 },
  };
}

export const campaign01StraightShot = defineLevel({
  id: 'campaign-01-straight-shot',
  name: 'Straight Shot',
  map: 'plains',
  campaign: campaign(1, 'Straight Shot', 'A calm two-gate corridor with room to learn flow.', 25),
  build(ctx) {
    ctx.node('west', [88, 212]);
    ctx.node('town', [320, 212]);
    ctx.node('east', [552, 212]);
    ctx.node('service', [320, 310]);

    ctx.road.between('west-main', 'west', 'town', { type: '2w1' });
    ctx.road.between('east-main', 'town', 'east', { type: '2w1' });
    ctx.road.between('service-road', 'service', 'town', { type: '2w1' });

    ctx.gate.atNode('west', { rate: 9 });
    ctx.gate.atNode('east', { rate: 9 });
    ctx.gate.atNode('service', { rate: 3 });
    ctx.signal.signs('town', { 'service-road': 'stop' });

    ctx.shot('overview', { center: [320, 215], zoom: 2.45, size: [1280, 720] });
    ctx.shot('heatmap', { center: [320, 215], zoom: 2.45, size: [1280, 720], overlays: ['heatmap'], simSeconds: 60, seed: 101 });
  },
});

export const campaign02MainStreetCrossing = defineLevel({
  id: 'campaign-02-main-street-crossing',
  name: 'Main Street Crossing',
  map: 'plains',
  campaign: campaign(2, 'Main Street Crossing', 'A first signalized cross-town intersection.', 40),
  build(ctx) {
    ctx.node('center', [320, 200]);
    ctx.node('west', [82, 200]);
    ctx.node('east', [558, 200]);
    ctx.node('north', [320, 58]);
    ctx.node('south', [320, 342]);

    ctx.road.between('west-leg', 'west', 'center', { type: '2w2' });
    ctx.road.between('east-leg', 'center', 'east', { type: '2w2' });
    ctx.road.between('north-leg', 'north', 'center', { type: '2w1' });
    ctx.road.between('south-leg', 'center', 'south', { type: '2w1' });

    ctx.gate.atNode('west', { rate: 14 });
    ctx.gate.atNode('east', { rate: 14 });
    ctx.gate.atNode('north', { rate: 6 });
    ctx.gate.atNode('south', { rate: 6 });
    ctx.signal.auto('center', { protectedLefts: false });

    ctx.shot('overview', { center: [320, 200], zoom: 2.7, size: [1280, 800] });
    ctx.shot('heatmap', { center: [320, 200], zoom: 2.7, size: [1280, 800], overlays: ['heatmap'], simSeconds: 75, seed: 102 });
  },
});

export const campaign03SchoolRun = defineLevel({
  id: 'campaign-03-school-run',
  name: 'School Run',
  map: 'plains',
  campaign: campaign(3, 'School Run', 'Offset side streets create short local conflicts.', 55),
  build(ctx) {
    ctx.node('west', [70, 220]);
    ctx.node('first', [230, 220]);
    ctx.node('second', [408, 220]);
    ctx.node('east', [570, 220]);
    ctx.node('north-neighborhood', [230, 78]);
    ctx.node('south-school', [408, 342]);
    ctx.node('north-park', [408, 84]);

    ctx.road.polyline('main-street', ['west', 'first', 'second', 'east'], { type: '2w1' });
    ctx.road.between('north-neighborhood-road', 'north-neighborhood', 'first', { type: '2w1' });
    ctx.road.between('south-school-road', 'second', 'south-school', { type: '2w1' });
    ctx.road.between('north-park-road', 'north-park', 'second', { type: '2w1' });

    ctx.gate.atNode('west', { rate: 12 });
    ctx.gate.atNode('east', { rate: 12 });
    ctx.gate.atNode('north-neighborhood', { rate: 8 });
    ctx.gate.atNode('south-school', { rate: 8 });
    ctx.gate.atNode('north-park', { rate: 5 });
    ctx.signal.signs('first', { 'north-neighborhood-road': 'stop' });
    ctx.signal.auto('second', { protectedLefts: false });

    ctx.shot('overview', { center: [320, 210], zoom: 2.35, size: [1280, 800] });
    ctx.shot('heatmap', { center: [320, 210], zoom: 2.35, size: [1280, 800], overlays: ['heatmap'], simSeconds: 80, seed: 103 });
  },
});

export const campaign04RiverChoke = defineLevel({
  id: 'campaign-04-river-choke',
  name: 'River Choke',
  map: 'river',
  campaign: campaign(4, 'River Choke', 'One bridge carries most of the city.', 70),
  build(ctx) {
    ctx.node('west', [58, 208]);
    ctx.node('west-bank', [232, 206]);
    ctx.node('east-bank', [406, 202]);
    ctx.node('east', [582, 196]);
    ctx.node('north-west', [220, 70]);
    ctx.node('south-east', [420, 336]);
    ctx.node('south-west', [130, 322]);

    ctx.road.polyline('bridge-main', ['west', 'west-bank', 'east-bank', 'east'], { type: '2w2' });
    ctx.road.between('north-west-road', 'north-west', 'west-bank', { type: '2w1' });
    ctx.road.between('south-east-road', 'east-bank', 'south-east', { type: '2w1' });
    ctx.road.between('south-west-road', 'south-west', 'west-bank', { type: '2w1' });
    ctx.road.speed('bridge-main', 14);

    ctx.gate.atNode('west', { rate: 15 });
    ctx.gate.atNode('east', { rate: 15 });
    ctx.gate.atNode('north-west', { rate: 7 });
    ctx.gate.atNode('south-east', { rate: 7 });
    ctx.gate.atNode('south-west', { rate: 4 });
    ctx.signal.signs('west-bank', { 'north-west-road': 'stop', 'south-west-road': 'yield' });
    ctx.signal.signs('east-bank', { 'south-east-road': 'stop' });

    ctx.shot('overview', { center: [320, 204], zoom: 2.25, size: [1280, 760] });
    ctx.shot('heatmap', { center: [320, 204], zoom: 2.25, size: [1280, 760], overlays: ['heatmap'], simSeconds: 90, seed: 104 });
  },
});

export const campaign05IndustrialSpur = defineLevel({
  id: 'campaign-05-industrial-spur',
  name: 'Industrial Spur',
  map: 'plains',
  campaign: campaign(5, 'Industrial Spur', 'Semis join commuter traffic near a busy merge.', 85),
  build(ctx) {
    ctx.node('west', [54, 210]);
    ctx.node('merge', [258, 210]);
    ctx.node('split', [410, 210]);
    ctx.node('east', [586, 210]);
    ctx.node('industrial', [258, 70]);
    ctx.node('south-yard', [420, 340]);
    ctx.node('north-town', [474, 82]);

    ctx.road.polyline('main', ['west', 'merge', 'split', 'east'], { type: '2w2' });
    ctx.road.between('industrial-spur', 'industrial', 'merge', { type: '2w1' });
    ctx.road.between('south-yard-road', 'split', 'south-yard', { type: '2w1' });
    ctx.road.between('north-town-road', 'north-town', 'split', { type: '2w1' });
    ctx.road.ban('main:2', 'semi');

    ctx.gate.atNode('west', { rate: 16 });
    ctx.gate.atNode('east', { rate: 14 });
    ctx.gate.atNode('industrial', { rate: 10, industrial: true });
    ctx.gate.atNode('south-yard', { rate: 7, industrial: true });
    ctx.gate.atNode('north-town', { rate: 7 });
    ctx.signal.auto('merge', { protectedLefts: true });
    ctx.signal.auto('split', { protectedLefts: false });

    ctx.shot('overview', { center: [320, 210], zoom: 2.35, size: [1280, 800] });
    ctx.shot('heatmap', { center: [320, 210], zoom: 2.35, size: [1280, 800], overlays: ['heatmap'], simSeconds: 100, seed: 105 });
  },
});

export const campaign06LakesideDetour = defineLevel({
  id: 'campaign-06-lakeside-detour',
  name: 'Lakeside Detour',
  map: 'lakes',
  campaign: campaign(6, 'Lakeside Detour', 'Two lakefront routes split uneven demand.', 100),
  build(ctx) {
    ctx.node('west', [46, 206]);
    ctx.node('west-hub', [170, 206]);
    ctx.node('north-mid', [318, 92]);
    ctx.node('south-mid', [330, 308]);
    ctx.node('east-hub', [478, 206]);
    ctx.node('east', [594, 206]);
    ctx.node('north-resort', [454, 64]);
    ctx.node('south-marina', [190, 340]);

    ctx.road.between('west-approach', 'west', 'west-hub', { type: '2w2' });
    ctx.road.between('east-approach', 'east-hub', 'east', { type: '2w2' });
    ctx.road.polyline('north-route', ['west-hub', 'north-mid', 'east-hub'], { type: '2w1' });
    ctx.road.polyline('south-route', ['west-hub', 'south-mid', 'east-hub'], { type: '2w2' });
    ctx.road.between('resort-road', 'north-resort', 'north-mid', { type: '2w1' });
    ctx.road.between('marina-road', 'south-marina', 'south-mid', { type: '2w1' });
    ctx.road.speed('north-route', 12);

    ctx.gate.atNode('west', { rate: 17 });
    ctx.gate.atNode('east', { rate: 17 });
    ctx.gate.atNode('north-resort', { rate: 8 });
    ctx.gate.atNode('south-marina', { rate: 10 });
    ctx.signal.signs('north-mid', { 'resort-road': 'stop' });
    ctx.signal.auto('south-mid', { protectedLefts: false });
    ctx.signal.auto('west-hub', { protectedLefts: false });
    ctx.signal.auto('east-hub', { protectedLefts: false });

    ctx.shot('overview', { center: [320, 205], zoom: 2.15, size: [1280, 800] });
    ctx.shot('heatmap', { center: [320, 205], zoom: 2.15, size: [1280, 800], overlays: ['heatmap'], simSeconds: 110, seed: 106 });
  },
});

export const campaign07DowntownGrid = defineLevel({
  id: 'campaign-07-downtown-grid',
  name: 'Downtown Grid',
  map: 'plains',
  campaign: campaign(7, 'Downtown Grid', 'A compact grid with many useful reroutes.', 120),
  build(ctx) {
    for (const x of [170, 320, 470]) {
      for (const y of [110, 220, 330]) ctx.node(`n${x}-${y}`, [x, y]);
    }
    ctx.node('west-main', [54, 220]);
    ctx.node('east-main', [586, 220]);
    ctx.node('north-main', [320, 34]);
    ctx.node('south-main', [320, 384]);
    ctx.node('northwest', [170, 34]);
    ctx.node('southeast', [470, 384]);

    ctx.road.polyline('main-ew', ['west-main', 'n170-220', 'n320-220', 'n470-220', 'east-main'], { type: '2w2' });
    ctx.road.polyline('north-ew', ['n170-110', 'n320-110', 'n470-110'], { type: '2w1' });
    ctx.road.polyline('south-ew', ['n170-330', 'n320-330', 'n470-330'], { type: '2w1' });
    ctx.road.polyline('main-ns', ['north-main', 'n320-110', 'n320-220', 'n320-330', 'south-main'], { type: '2w2' });
    ctx.road.polyline('west-ns', ['northwest', 'n170-110', 'n170-220', 'n170-330'], { type: '2w1' });
    ctx.road.polyline('east-ns', ['n470-110', 'n470-220', 'n470-330', 'southeast'], { type: '2w1' });

    ctx.gate.atNode('west-main', { rate: 18 });
    ctx.gate.atNode('east-main', { rate: 18 });
    ctx.gate.atNode('north-main', { rate: 12 });
    ctx.gate.atNode('south-main', { rate: 12 });
    ctx.gate.atNode('northwest', { rate: 7 });
    ctx.gate.atNode('southeast', { rate: 7 });
    for (const node of ['n170-220', 'n320-220', 'n470-220', 'n320-110', 'n320-330']) {
      ctx.signal.auto(node, { protectedLefts: node === 'n320-220' });
    }

    ctx.shot('overview', { center: [320, 210], zoom: 1.95, size: [1280, 820] });
    ctx.shot('heatmap', { center: [320, 210], zoom: 1.95, size: [1280, 820], overlays: ['heatmap'], simSeconds: 120, seed: 107 });
  },
});

export const campaign08MultiLaneMerge = defineLevel({
  id: 'campaign-08-multi-lane-merge',
  name: 'Multi-Lane Merge',
  map: 'plains',
  campaign: campaign(8, 'Multi-Lane Merge', 'High-speed lanes, ramps, and truck restrictions.', 145),
  build(ctx) {
    ctx.node('west', [44, 214]);
    ctx.node('merge-a', [230, 214]);
    ctx.node('merge-b', [392, 214]);
    ctx.node('east', [602, 214]);
    ctx.node('south-ramp', [130, 342]);
    ctx.node('south-ramp-mid', [210, 304]);
    ctx.node('north-ramp', [508, 80]);
    ctx.node('north-ramp-mid', [430, 122]);
    ctx.node('industrial', [300, 70]);

    ctx.road.polyline('freeway', ['west', 'merge-a', 'merge-b', 'east'], { type: '2w3' });
    ctx.road.curve('south-on-ramp', 'south-ramp', 'south-ramp-mid', 'merge-a', { type: '2w1', pieces: 6 });
    ctx.road.curve('north-on-ramp', 'north-ramp', 'north-ramp-mid', 'merge-b', { type: '2w1', pieces: 6 });
    ctx.road.between('industrial-access', 'industrial', 'merge-a', { type: '2w1' });
    ctx.road.ban('freeway:2', 'semi');

    ctx.gate.atNode('west', { rate: 24 });
    ctx.gate.atNode('east', { rate: 22 });
    ctx.gate.atNode('south-ramp', { rate: 12 });
    ctx.gate.atNode('north-ramp', { rate: 12 });
    ctx.gate.atNode('industrial', { rate: 9, industrial: true });
    ctx.signal.auto('merge-a', { protectedLefts: false });
    ctx.signal.auto('merge-b', { protectedLefts: false });

    ctx.shot('overview', { center: [322, 214], zoom: 2.25, size: [1280, 820] });
    ctx.shot('heatmap', { center: [322, 214], zoom: 2.25, size: [1280, 820], overlays: ['heatmap'], simSeconds: 130, seed: 108 });
  },
});

export const campaign09RingRoad = defineLevel({
  id: 'campaign-09-ring-road',
  name: 'Ring Road',
  map: 'plains',
  campaign: campaign(9, 'Ring Road', 'A ring distributor absorbs high turning demand.', 170),
  decals: [
    { kind: 'circle', center: [320, 205], radius: 52, fill: '#f2efe5', stroke: '#fffaf0', lineWidth: 1 },
    { kind: 'circle', center: [320, 205], radius: 29, fill: '#76985d', stroke: '#d8d3c2', lineWidth: 0.6 },
  ],
  build(ctx) {
    const cx = 320;
    const cy = 205;
    const r = 86;
    const angles = [-165, -135, -105, -75, -45, -15, 15, 45, 75, 105, 135, 165];
    const node = (deg: number) => `r${String(deg).replace('-', 'm')}`;
    for (const deg of angles) {
      const a = deg * Math.PI / 180;
      ctx.node(node(deg), [cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
    for (let i = 0; i < angles.length; i++) {
      ctx.road.between(`ring-${i}`, node(angles[i]), node(angles[(i + 1) % angles.length]), { type: '1w1' });
    }

    ctx.node('west', [42, 205]);
    ctx.node('west-split', [146, 205]);
    ctx.node('east', [598, 205]);
    ctx.node('east-split', [494, 205]);
    ctx.node('north', [320, 30]);
    ctx.node('north-split', [320, 92]);
    ctx.node('south', [320, 380]);
    ctx.node('south-split', [320, 318]);
    ctx.node('industrial', [112, 72]);

    ctx.road.between('west-trunk', 'west', 'west-split', { type: '2w2' });
    ctx.road.between('east-trunk', 'east-split', 'east', { type: '2w2' });
    ctx.road.between('north-trunk', 'north', 'north-split', { type: '2w2' });
    ctx.road.between('south-trunk', 'south-split', 'south', { type: '2w2' });
    ctx.road.between('industrial-road', 'industrial', 'west-split', { type: '2w1' });

    ctx.road.curve('west-entrance', 'west-split', [168, 250], node(165), { type: '1w1', pieces: 4 });
    ctx.road.curve('west-exit', node(-165), [168, 160], 'west-split', { type: '1w1', pieces: 4 });
    ctx.road.curve('east-entrance', 'east-split', [472, 160], node(-15), { type: '1w1', pieces: 4 });
    ctx.road.curve('east-exit', node(15), [472, 250], 'east-split', { type: '1w1', pieces: 4 });
    ctx.road.curve('north-entrance', 'north-split', [276, 112], node(-105), { type: '1w1', pieces: 4 });
    ctx.road.curve('north-exit', node(-75), [364, 112], 'north-split', { type: '1w1', pieces: 4 });
    ctx.road.curve('south-entrance', 'south-split', [364, 298], node(75), { type: '1w1', pieces: 4 });
    ctx.road.curve('south-exit', node(105), [276, 298], 'south-split', { type: '1w1', pieces: 4 });

    ctx.gate.atNode('west', { rate: 22 });
    ctx.gate.atNode('east', { rate: 22 });
    ctx.gate.atNode('north', { rate: 16 });
    ctx.gate.atNode('south', { rate: 16 });
    ctx.gate.atNode('industrial', { rate: 8, industrial: true });
    ctx.signal.signs('west-split', { 'industrial-road': 'stop' });

    ctx.shot('overview', { center: [320, 205], zoom: 2.05, size: [1280, 820] });
    ctx.shot('heatmap', { center: [320, 205], zoom: 2.05, size: [1280, 820], overlays: ['heatmap'], simSeconds: 140, seed: 109 });
  },
});

export const campaign10CityCore = defineLevel({
  id: 'campaign-10-city-core',
  name: 'City Core',
  map: 'lakes',
  campaign: campaign(10, 'City Core', 'The final mixed network: water, trucks, merges, and close junctions.', 220),
  build(ctx) {
    ctx.node('west', [42, 210]);
    ctx.node('west-hub', [156, 210]);
    ctx.node('core-west', [266, 210]);
    ctx.node('core-east', [382, 210]);
    ctx.node('east-hub', [494, 210]);
    ctx.node('east', [604, 210]);
    ctx.node('northwest', [150, 58]);
    ctx.node('north-core', [318, 82]);
    ctx.node('northeast', [500, 62]);
    ctx.node('southwest', [150, 350]);
    ctx.node('south-core', [320, 334]);
    ctx.node('southeast', [496, 350]);
    ctx.node('freight', [62, 330]);
    ctx.node('northwest-gate', [74, 58]);
    ctx.node('northeast-gate', [576, 62]);
    ctx.node('southwest-gate', [154, 394]);
    ctx.node('southeast-gate', [576, 368]);

    ctx.road.polyline('main-corridor', ['west', 'west-hub', 'core-west', 'core-east', 'east-hub', 'east'], { type: '2w2' });
    ctx.road.polyline('north-bypass', ['west-hub', 'northwest', 'north-core', 'northeast', 'east-hub'], { type: '2w1' });
    ctx.road.polyline('south-bypass', ['west-hub', 'southwest', 'south-core', 'southeast', 'east-hub'], { type: '2w2' });
    ctx.road.between('core-vertical', 'north-core', 'core-west', { type: '2w1' });
    ctx.road.between('core-south-link', 'core-east', 'south-core', { type: '2w1' });
    ctx.road.between('freight-road', 'freight', 'southwest', { type: '2w1' });
    ctx.road.between('northwest-gate-road', 'northwest-gate', 'northwest', { type: '2w1' });
    ctx.road.between('northeast-gate-road', 'northeast', 'northeast-gate', { type: '2w1' });
    ctx.road.between('southwest-gate-road', 'southwest-gate', 'southwest', { type: '2w1' });
    ctx.road.between('southeast-gate-road', 'southeast', 'southeast-gate', { type: '2w1' });
    ctx.road.ban('main-corridor:4', 'semi');
    ctx.road.speed('north-bypass', 12);

    ctx.gate.atNode('west', { rate: 25 });
    ctx.gate.atNode('east', { rate: 25 });
    ctx.gate.atNode('northwest-gate', { rate: 10 });
    ctx.gate.atNode('northeast-gate', { rate: 10 });
    ctx.gate.atNode('southwest-gate', { rate: 12 });
    ctx.gate.atNode('southeast-gate', { rate: 12 });
    ctx.gate.atNode('freight', { rate: 12, industrial: true });
    for (const node of ['west-hub', 'core-west', 'core-east', 'east-hub', 'north-core', 'south-core']) {
      ctx.signal.auto(node, { protectedLefts: node === 'core-west' || node === 'core-east' });
    }
    ctx.signal.signs('southwest', { 'freight-road': 'stop' });

    ctx.shot('overview', { center: [322, 210], zoom: 1.85, size: [1280, 840] });
    ctx.shot('heatmap', { center: [322, 210], zoom: 1.85, size: [1280, 840], overlays: ['heatmap'], simSeconds: 150, seed: 110 });
  },
});

export const CAMPAIGN_LEVELS = [
  campaign01StraightShot,
  campaign02MainStreetCrossing,
  campaign03SchoolRun,
  campaign04RiverChoke,
  campaign05IndustrialSpur,
  campaign06LakesideDetour,
  campaign07DowntownGrid,
  campaign08MultiLaneMerge,
  campaign09RingRoad,
  campaign10CityCore,
];
