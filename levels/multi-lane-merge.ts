import { defineLevel } from '../src/levelKit';

export default defineLevel({
  id: 'multi-lane-merge',
  name: 'Multi-Lane Merge',
  map: 'plains',
  build(ctx) {
    ctx.node('west', [72, 210]);
    ctx.node('merge', [300, 210]);
    ctx.node('east', [568, 210]);
    ctx.node('ramp-start', [142, 330]);
    ctx.node('ramp-mid', [222, 302]);
    ctx.node('north-industrial', [372, 78]);

    ctx.road.between('main-west', 'west', 'merge', { type: '2w3' });
    ctx.road.between('main-east', 'merge', 'east', { type: '2w3' });
    ctx.road.curve('on-ramp', 'ramp-start', 'ramp-mid', 'merge', { type: '2w1', pieces: 6 });
    ctx.road.between('industrial-access', 'north-industrial', 'merge', { type: '2w1' });
    ctx.road.ban('main-east', 'semi');

    ctx.gate.atNode('west', { rate: 24 });
    ctx.gate.atNode('east', { rate: 18 });
    ctx.gate.atNode('ramp-start', { rate: 10 });
    ctx.gate.atNode('north-industrial', { rate: 8, industrial: true });
    ctx.signal.auto('merge', { protectedLefts: false });

    ctx.shot('merge-close', { center: [318, 220], zoom: 6.2, size: [1280, 800], overlays: ['ids:lanes'] });
    ctx.shot('heatmap', { center: [320, 220], zoom: 3.4, size: [1280, 800], overlays: ['heatmap'], simSeconds: 45, seed: 42 });
  },
});
