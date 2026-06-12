import { defineLevel } from '../src/levelKit';

export default defineLevel({
  id: 'bridge-river',
  name: 'River Bridge',
  map: 'river',
  build(ctx) {
    ctx.node('west', [76, 210]);
    ctx.node('west-bank', [246, 198]);
    ctx.node('east-bank', [394, 206]);
    ctx.node('east', [564, 194]);
    ctx.node('north-service', [284, 86]);
    ctx.node('south-service', [356, 324]);

    ctx.road.polyline('bridge-main', ['west', 'west-bank', 'east-bank', 'east'], { type: '2w2' });
    ctx.road.between('north-service-road', 'north-service', 'west-bank', { type: '2w1' });
    ctx.road.between('south-service-road', 'east-bank', 'south-service', { type: '2w1' });
    ctx.road.speed('bridge-main', 14);

    ctx.gate.atNode('west', { rate: 16 });
    ctx.gate.atNode('east', { rate: 16 });
    ctx.gate.atNode('north-service', { rate: 6 });
    ctx.gate.atNode('south-service', { rate: 6, industrial: true });
    ctx.signal.signs('west-bank', { 'north-service-road': 'stop' });
    ctx.signal.signs('east-bank', { 'south-service-road': 'stop' });

    ctx.shot('bridge-close', { center: [320, 202], zoom: 5.5, size: [1280, 800] });
    ctx.shot('overview', { center: [320, 200], zoom: 2.3, size: [1280, 720], overlays: ['grid'] });
  },
});

