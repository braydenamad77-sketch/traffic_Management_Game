import { defineLevel } from '../src/levelKit';

export default defineLevel({
  id: 'tight-curve-stress',
  name: 'Tight Curve Stress',
  map: 'plains',
  build(ctx) {
    ctx.node('west', [92, 276]);
    ctx.node('bend-entry', [220, 276]);
    ctx.node('bend-exit', [420, 124]);
    ctx.node('east', [548, 124]);
    ctx.node('spur', [318, 300]);

    ctx.road.between('west-approach', 'west', 'bend-entry', { type: '2w1' });
    ctx.road.curve('tight-bend', 'bend-entry', [300, 60], 'bend-exit', { type: '2w1', pieces: 9 });
    ctx.road.between('east-approach', 'bend-exit', 'east', { type: '2w1' });
    ctx.road.between('side-spur', 'spur', 'tight-bend.4', { type: '2w1' });

    ctx.gate.atNode('west', { rate: 14 });
    ctx.gate.atNode('east', { rate: 14 });
    ctx.gate.atNode('spur', { rate: 6, industrial: true });
    ctx.signal.signs('tight-bend.4', { 'side-spur': 'stop' });

    ctx.shot('curve-close', { center: [310, 190], zoom: 6.8, size: [1280, 800], overlays: ['ids:nodes'] });
    ctx.shot('overview', { center: [320, 200], zoom: 2.5, size: [1280, 720] });
  },
});
