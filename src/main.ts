// Boot + game loop + input wiring.

import { Network } from './network';
import { Sim } from './sim';
import { Tools } from './tools';
import { Camera } from './camera';
import { Renderer } from './render';
import { UI } from './ui';
import { getMap, MAPS } from './terrain';
import { save, load } from './save';
import { exportNetwork, importNetwork } from './levelData';
import { buildLevel, LevelDefinition, levelBounds } from './levelKit';
import { createObjectiveRun, ObjectiveRun, resetObjectiveRun, updateObjectiveRun } from './objective';
import { CAMPAIGN_LEVELS, findLevel } from '../levels';

const canvas = document.getElementById('game') as HTMLCanvasElement;

const net = new Network();
const sim = new Sim(net);
const cam = new Camera(canvas);
const renderer = new Renderer(canvas, cam);

let mapId = 'plains';
let heatmap = false;
let saveDirty = false;
let playMode: 'custom' | 'campaign' = 'custom';
let activeLevel: LevelDefinition | null = null;
let objectiveRun: ObjectiveRun = createObjectiveRun(null);

const markDirty = () => {
  if (playMode === 'custom') saveDirty = true;
};

const tools = new Tools(
  net,
  markDirty,
  sel => ui.onSelect(sel),
  msg => ui.toast(msg),
);

const ui = new UI(net, sim, tools, markDirty);

const mapSelect = document.getElementById('map-select') as HTMLSelectElement;
const levelSelect = document.getElementById('level-select') as HTMLSelectElement;
const objectiveCard = document.getElementById('objective-card')!;
const objectiveKicker = document.getElementById('objective-kicker')!;
const objectiveTitle = document.getElementById('objective-title')!;
const objectiveSubtitle = document.getElementById('objective-subtitle')!;
const objectiveArrivals = document.getElementById('objective-arrivals')!;
const objectiveStatus = document.getElementById('objective-status')!;

setupLevelPicker();
loadCustomSandbox();

/* ---------------- input ---------------- */

let panning = false;
let mouseDown = false;
let dragMoved = false;
let lastMouse = { x: 0, y: 0 };

canvas.addEventListener('mousedown', e => {
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
  lastMouse = { x: sx, y: sy };
  if (e.button === 1 || e.button === 2) {
    panning = true;
    canvas.classList.add('panning');
    return;
  }
  if (e.button === 0) {
    mouseDown = true;
    dragMoved = false;
    const world = cam.toWorld(sx, sy);
    if (tools.tool === 'edit') tools.onEditDown(world);
  }
});

window.addEventListener('mousemove', e => {
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
  const dx = sx - lastMouse.x, dy = sy - lastMouse.y;
  if (panning) {
    cam.pan(dx, dy);
    lastMouse = { x: sx, y: sy };
    return;
  }
  if (Math.abs(dx) + Math.abs(dy) > 2) dragMoved = true;
  lastMouse = { x: sx, y: sy };
  const world = cam.toWorld(sx, sy);
  if (mouseDown && tools.draggingNode !== null) {
    tools.onDrag(world);
    return;
  }
  if (mouseDown && tools.tool === 'upgrade' && e.target === canvas) {
    tools.paintUpgrade(world);   // drag-paint conversion
  }
  tools.updateHover(world);
});

window.addEventListener('mouseup', e => {
  if (e.button === 1 || e.button === 2) {
    panning = false;
    canvas.classList.remove('panning');
    return;
  }
  if (e.button !== 0) return;
  const wasDraggingNode = tools.draggingNode !== null;
  tools.onDragEnd();
  if (mouseDown && !wasDraggingNode && e.target === canvas) {
    const rect = canvas.getBoundingClientRect();
    const world = cam.toWorld(e.clientX - rect.left, e.clientY - rect.top);
    if (!dragMoved || tools.tool === 'draw') tools.onClick(world);
  }
  mouseDown = false;
});

canvas.addEventListener('contextmenu', e => {
  e.preventDefault();
  // right-click also cancels a drawing chain
  if (tools.isDrawingChain) tools.cancelChain();
});

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  cam.zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.13 : 1 / 1.13);
}, { passive: false });

const panKeys = new Set<string>();
window.addEventListener('keyup', e => panKeys.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => panKeys.clear());

window.addEventListener('keydown', e => {
  if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') return;
  const k = e.key.toLowerCase();
  if (!e.metaKey && !e.ctrlKey && (k === 'w' || k === 'a' || k === 's' || k === 'd')) {
    panKeys.add(k);
    return;
  }
  switch (k) {
    case 'v': ui.setTool('select'); break;
    case 'r': ui.setTool('draw'); break;
    case 'u': ui.setTool('upgrade'); break;
    case 'e': ui.setTool('edit'); break;
    case 'g':
      if (tools.tool === 'draw') ui.setSnap('grid');
      else ui.setTool('gate');
      break;
    case 'f': if (tools.tool === 'draw') ui.setSnap('free'); break;
    case 'c': if (tools.tool === 'draw') ui.setSnap('curve'); break;
    case 'x': ui.setTool('bulldoze'); break;
    case 'escape':
      if (tools.isDrawingChain) tools.cancelChain();
      else tools.select(null);
      break;
    case 'delete':
    case 'backspace':
      tools.deleteSelected();
      break;
    case ' ':
      e.preventDefault();
      togglePause();
      break;
    case '1': setSpeed(1); break;
    case '2': setSpeed(2); break;
    case '4': setSpeed(4); break;
  }
});

/* ---------------- top bar controls ---------------- */

const pauseBtn = document.getElementById('btn-pause')!;
function togglePause() {
  sim.paused = !sim.paused;
  pauseBtn.classList.toggle('paused', sim.paused);
  (document.getElementById('ic-pause') as HTMLElement).style.display = sim.paused ? 'none' : '';
  (document.getElementById('ic-play') as HTMLElement).style.display = sim.paused ? '' : 'none';
}
pauseBtn.onclick = togglePause;

function setSpeed(s: number) {
  sim.speed = s;
  document.querySelectorAll<HTMLButtonElement>('.speedbtn').forEach(b => {
    b.classList.toggle('active', +b.dataset.speed! === s);
  });
}
document.querySelectorAll<HTMLButtonElement>('.speedbtn').forEach(b => {
  b.onclick = () => setSpeed(+b.dataset.speed!);
});

document.getElementById('btn-resetcars')!.onclick = () => {
  sim.resetRun();
  objectiveRun = resetObjectiveRun(objectiveRun, sim.arrived);
  renderObjectiveUI(sim.stats());
};

const heatBtn = document.getElementById('btn-heat')!;
heatBtn.onclick = () => {
  heatmap = !heatmap;
  heatBtn.classList.toggle('on', heatmap);
};

mapSelect.onchange = e => {
  mapId = (e.target as HTMLSelectElement).value;
  markDirty();
};

document.getElementById('btn-clear')!.onclick = () => {
  if (!confirm('Demolish every road on the map?')) return;
  for (const sid of [...net.segs.keys()]) net.removeSegment(sid);
  net.rebuild();
  sim.resetRun();
  objectiveRun = resetObjectiveRun(objectiveRun, sim.arrived);
  renderObjectiveUI(sim.stats());
  tools.select(null);
  markDirty();
};

/* ---------------- starter road (first run only) ---------------- */

function seedStarterRoad() {
  const a = net.addNode({ x: 160, y: 200 });
  const m = net.addNode({ x: 320, y: 192 });
  const b = net.addNode({ x: 480, y: 200 });
  net.addSegment(a.id, m.id, '2w1');
  net.addSegment(m.id, b.id, '2w1');
  a.gate = { rate: 10 };
  b.gate = { rate: 10 };
  net.rebuild();
}

function setupLevelPicker() {
  for (const level of CAMPAIGN_LEVELS) {
    const opt = document.createElement('option');
    opt.value = level.id;
    opt.textContent = `${level.campaign!.difficulty}. ${level.campaign!.title}`;
    levelSelect.appendChild(opt);
  }

  levelSelect.onchange = () => {
    const id = levelSelect.value;
    if (id === (activeLevel?.id ?? 'custom')) return;
    if (id === 'custom') {
      if (!confirm('Load the Custom Sandbox? This replaces the current city.')) {
        syncLevelSelect();
        return;
      }
      loadCustomSandbox();
      return;
    }

    const level = findLevel(id);
    if (!level) {
      syncLevelSelect();
      return;
    }
    if (!confirm(`Load ${level.name}? This replaces the current city.`)) {
      syncLevelSelect();
      return;
    }
    loadCampaignLevel(level);
  };
}

function syncLevelSelect() {
  levelSelect.value = activeLevel?.id ?? 'custom';
}

function loadCustomSandbox() {
  playMode = 'custom';
  activeLevel = null;
  net.clear();
  const loadedMap = load(net);
  if (loadedMap) {
    mapId = loadedMap;
  } else {
    mapId = 'plains';
    seedStarterRoad();
  }
  mapSelect.value = mapId;
  syncLevelSelect();
  tools.select(null);
  sim.resetRun();
  objectiveRun = createObjectiveRun(null, sim.arrived);
  renderObjectiveUI(sim.stats());
  saveDirty = false;
}

function loadCampaignLevel(level: LevelDefinition) {
  const built = buildLevel(level);
  mapId = importNetwork(net, exportNetwork(built.net, built.map));
  mapSelect.value = mapId;
  playMode = 'campaign';
  activeLevel = level;
  syncLevelSelect();
  tools.select(null);
  sim.resetRun();
  objectiveRun = createObjectiveRun(level, sim.arrived);
  moveCameraToLevel(level);
  renderObjectiveUI(sim.stats());
  saveDirty = false;
}

function moveCameraToLevel(level: LevelDefinition) {
  const shot = buildLevel(level).shots.overview;
  if (shot) {
    cam.x = shot.center[0];
    cam.y = shot.center[1];
    cam.zoom = shot.zoom;
    return;
  }
  const bounds = levelBounds(net);
  cam.x = bounds.center[0];
  cam.y = bounds.center[1];
  cam.zoom = Math.max(1.8, Math.min(2.8, 820 / Math.max(bounds.size[0], bounds.size[1])));
}

function renderObjectiveUI(stats: ReturnType<Sim['stats']>) {
  if (!objectiveRun.objective || !objectiveRun.level?.campaign) {
    objectiveCard.hidden = true;
    return;
  }

  objectiveCard.hidden = false;
  objectiveCard.classList.toggle('won', objectiveRun.status === 'won');
  objectiveCard.classList.toggle('failed', objectiveRun.status === 'failed');
  objectiveKicker.textContent = `Level ${objectiveRun.level.campaign.difficulty}`;
  objectiveTitle.textContent = objectiveRun.level.campaign.title;
  objectiveSubtitle.textContent = objectiveRun.level.campaign.subtitle;
  objectiveArrivals.textContent = `Arrived ${objectiveRun.progress} / ${objectiveRun.objective.targetArrivals}`;
  objectiveStatus.textContent = objectiveRun.status === 'won'
    ? 'Cleared'
    : objectiveRun.status === 'failed' ? 'Gridlock' : stats.gridlocked ? 'Gridlock' : 'Running';
}

function updateObjective(stats: ReturnType<Sim['stats']>) {
  const before = objectiveRun.status;
  objectiveRun = updateObjectiveRun(objectiveRun, stats);
  if (before !== objectiveRun.status) {
    if (objectiveRun.status === 'won') ui.toast('Level cleared');
    if (objectiveRun.status === 'failed') ui.toast('Gridlock hit the city');
  }
  renderObjectiveUI(stats);
}

/* ---------------- game loop ---------------- */

const FIXED_DT = 1 / 60;
let acc = 0;
let lastT = performance.now();
let statTimer = 0;
let saveTimer = 0;

function frame(now: number) {
  const elapsed = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;

  // WASD panning
  if (panKeys.size) {
    const k = 720 * elapsed;
    const dx = (panKeys.has('d') ? 1 : 0) - (panKeys.has('a') ? 1 : 0);
    const dy = (panKeys.has('s') ? 1 : 0) - (panKeys.has('w') ? 1 : 0);
    if (dx || dy) cam.pan(-dx * k, -dy * k);
  }

  if (!sim.paused) {
    acc += elapsed * sim.speed;
    let steps = 0;
    while (acc >= FIXED_DT && steps < 10) {
      sim.step(FIXED_DT);
      acc -= FIXED_DT;
      steps++;
    }
    if (steps >= 10) acc = 0; // dropped behind; don't spiral
  }

  renderer.render(net, sim, tools, getMap(mapId), heatmap, sim.time);

  statTimer += elapsed;
  if (statTimer > 0.4) {
    statTimer = 0;
    const stats = sim.stats();
    ui.updateStats(stats);
    updateObjective(stats);
    ui.tick();
  }

  saveTimer += elapsed;
  if (playMode === 'custom' && saveDirty && saveTimer > 2) {
    saveTimer = 0;
    saveDirty = false;
    save(net, mapId);
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// expose for curious consoles
(window as any).game = { net, sim, tools, cam, MAPS, CAMPAIGN_LEVELS };
