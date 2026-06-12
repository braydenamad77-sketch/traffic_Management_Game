import { defineLevel } from '../src/levelKit';

export default defineLevel({
  id: 'four-way-signal',
  name: 'Four-Way Signal',
  map: 'plains',
  build(ctx) {
    ctx.node('center', [320, 200]);
    ctx.node('north', [320, 72]);
    ctx.node('south', [320, 328]);
    ctx.node('west', [120, 200]);
    ctx.node('east', [520, 200]);

    ctx.road.between('north-leg', 'north', 'center', { type: '2w2' });
    ctx.road.between('south-leg', 'center', 'south', { type: '2w2' });
    ctx.road.between('west-leg', 'west', 'center', { type: '2w2' });
    ctx.road.between('east-leg', 'center', 'east', { type: '2w2' });

    ctx.gate.atNode('north', { rate: 10 });
    ctx.gate.atNode('south', { rate: 10 });
    ctx.gate.atNode('west', { rate: 16 });
    ctx.gate.atNode('east', { rate: 16 });
    ctx.signal.auto('center', { protectedLefts: true });

    ctx.shot('overview', { center: [320, 200], zoom: 2.8, size: [1280, 900] });
    ctx.shot('junction-close', { center: [320, 200], zoom: 7, size: [1280, 800], overlays: ['ids:segments'] });
  },
});

