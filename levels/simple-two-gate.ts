import { defineLevel } from '../src/levelKit';

export default defineLevel({
  id: 'simple-two-gate',
  name: 'Simple Two-Gate Road',
  map: 'plains',
  build(ctx) {
    ctx.node('west', [120, 200]);
    ctx.node('mid', [320, 200]);
    ctx.node('east', [520, 200]);
    ctx.road.between('west-main', 'west', 'mid', { type: '2w1' });
    ctx.road.between('east-main', 'mid', 'east', { type: '2w1' });
    ctx.gate.atNode('west', { rate: 12 });
    ctx.gate.atNode('east', { rate: 12 });
    ctx.shot('overview', { center: [320, 200], zoom: 2.6, size: [1280, 720] });
    ctx.shot('ids', { center: [320, 200], zoom: 4.2, size: [1280, 720], overlays: ['ids:all', 'grid'] });
  },
});

