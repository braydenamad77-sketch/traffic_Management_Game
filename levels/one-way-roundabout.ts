import { defineLevel } from '../src/levelKit';

const cx = 320;
const cy = 200;
const ringR = 64;

const ringPoint = (deg: number): [number, number] => {
  const a = (deg * Math.PI) / 180;
  return [cx + Math.cos(a) * ringR, cy + Math.sin(a) * ringR];
};

const rnode = (deg: number) => `r${String(deg).replace('-', 'm')}`;

export default defineLevel({
  id: 'one-way-roundabout',
  name: 'One-Way Roundabout',
  map: 'plains',
  decals: [
    { kind: 'circle', center: [cx, cy], radius: 35, fill: '#f2efe5', stroke: '#fffaf0', lineWidth: 1.0 },
    { kind: 'circle', center: [cx, cy], radius: 19, fill: '#7ba05f', stroke: '#d8d3c2', lineWidth: 0.55 },
    { kind: 'circle', center: [cx - 5, cy - 3], radius: 2.2, fill: '#6f9355' },
    { kind: 'circle', center: [cx + 4, cy + 4], radius: 1.9, fill: '#6f9355' },
    { kind: 'circle', center: [cx + 1, cy - 8], radius: 1.6, fill: '#6f9355' },

    // Concrete splitter islands, shaped like the aerial reference.
    { kind: 'poly', points: [[304, 82], [336, 82], [342, 130], [320, 164], [298, 130]], fill: '#e8e4d9', stroke: '#faf7ef', lineWidth: 0.6 },
    { kind: 'poly', points: [[538, 184], [538, 216], [490, 221], [456, 200], [490, 179]], fill: '#e8e4d9', stroke: '#faf7ef', lineWidth: 0.6 },
    { kind: 'poly', points: [[336, 318], [304, 318], [298, 270], [320, 236], [342, 270]], fill: '#e8e4d9', stroke: '#faf7ef', lineWidth: 0.6 },
    { kind: 'poly', points: [[102, 216], [102, 184], [150, 179], [184, 200], [150, 221]], fill: '#e8e4d9', stroke: '#faf7ef', lineWidth: 0.6 },
  ],
  build(ctx) {
    const ringAngles = [-160, -135, -115, -90, -65, -45, -20, 0, 20, 45, 65, 90, 115, 135, 160, 180];
    for (const deg of ringAngles) ctx.node(rnode(deg), ringPoint(deg));
    for (let i = 0; i < ringAngles.length; i++) {
      ctx.road.between(`circulating-${i}`, rnode(ringAngles[i]), rnode(ringAngles[(i + 1) % ringAngles.length]), { type: '1w1' });
    }

    // Approach trunks are normal two-way roads; each splits into a one-way
    // entrance and one-way exit at the splitter island.
    ctx.node('north-far', [320, 26]);
    ctx.node('north-split', [320, 82]);
    ctx.node('east-far', [614, 200]);
    ctx.node('east-split', [538, 200]);
    ctx.node('south-far', [320, 374]);
    ctx.node('south-split', [320, 318]);
    ctx.node('west-far', [26, 200]);
    ctx.node('west-split', [102, 200]);

    ctx.road.between('north-trunk', 'north-far', 'north-split', { type: '2w1' });
    ctx.road.between('east-trunk', 'east-split', 'east-far', { type: '2w1' });
    ctx.road.between('south-trunk', 'south-split', 'south-far', { type: '2w1' });
    ctx.road.between('west-trunk', 'west-far', 'west-split', { type: '2w1' });

    ctx.road.curve('north-entrance', 'north-split', [287, 108], rnode(-115), { type: '1w1', pieces: 5 });
    ctx.road.curve('north-exit', rnode(-65), [353, 108], 'north-split', { type: '1w1', pieces: 5 });

    ctx.road.curve('east-entrance', 'east-split', [494, 164], rnode(-20), { type: '1w1', pieces: 5 });
    ctx.road.curve('east-exit', rnode(20), [494, 236], 'east-split', { type: '1w1', pieces: 5 });

    ctx.road.curve('south-entrance', 'south-split', [353, 292], rnode(65), { type: '1w1', pieces: 5 });
    ctx.road.curve('south-exit', rnode(115), [287, 292], 'south-split', { type: '1w1', pieces: 5 });

    ctx.road.curve('west-entrance', 'west-split', [146, 236], rnode(160), { type: '1w1', pieces: 5 });
    ctx.road.curve('west-exit', rnode(-160), [146, 164], 'west-split', { type: '1w1', pieces: 5 });

    ctx.shot('overview', { center: [320, 200], zoom: 2.65, size: [1280, 800] });
    ctx.shot('close', { center: [320, 200], zoom: 4.2, size: [1280, 800] });
    ctx.shot('debug', { center: [320, 200], zoom: 4.1, size: [1280, 800], overlays: ['ids:segments', 'grid'] });
  },
});
