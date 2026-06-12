// DOM UI: toolbar, road type picker, contextual panels (junction control
// with the signal phase editor, gates, segments), stats, toasts.

import { Network, RNode, Segment, Phase, SignKind } from './network';
import { ROAD_TYPES, roadType, LANE_W, MPH, VehicleKind } from './roadTypes';
import { Tools, ToolKind, Selection } from './tools';
import { Sim, SimStats } from './sim';
import { autoPhases, isPermissiveLeft } from './signals';
import { V } from './vec';

const TOOL_DEFS: { id: ToolKind; label: string; key: string; icon: string }[] = [
  {
    id: 'select', label: 'Inspect', key: 'V',
    icon: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M3 1.8l9.2 5.6-4 1.1 2.6 4.5-1.9 1.1-2.6-4.5-2.9 3z" fill="currentColor"/></svg>',
  },
  {
    id: 'draw', label: 'Build road', key: 'R',
    icon: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M2 14C5 9 11 7 14 2" stroke="currentColor" stroke-width="2.6" fill="none" stroke-linecap="round"/><path d="M2 14C5 9 11 7 14 2" stroke="#0000" stroke-width="2.6" fill="none"/><path d="M4.3 11.2l.9.8M7.5 8.4l.9.8M10.7 5.5l.9.8" stroke="var(--bg-2,#1a1d24)" stroke-width="1" stroke-linecap="round"/></svg>',
  },
  {
    id: 'upgrade', label: 'Upgrade road', key: 'U',
    icon: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M3 14V8M13 14V8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M8 13V9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-dasharray="2 1.6"/><path d="M8 1.5L4.4 5.4h2.2V7h2.8V5.4h2.2z" fill="currentColor"/></svg>',
  },
  {
    id: 'edit', label: 'Edit nodes', key: 'E',
    icon: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M2 13C5 9 11 8 14 3" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/><circle cx="2.4" cy="13" r="2" fill="currentColor"/><circle cx="8.2" cy="9.4" r="2" fill="currentColor"/><circle cx="13.6" cy="3.4" r="2" fill="currentColor"/></svg>',
  },
  {
    id: 'gate', label: 'Spawn gate', key: 'G',
    icon: '<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.2" stroke="currentColor" stroke-width="1.6" fill="none" stroke-dasharray="2.5 1.8"/><path d="M5.4 5l3 3-3 3M8.8 5l3 3-3 3" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  },
  {
    id: 'bulldoze', label: 'Bulldoze', key: 'X',
    icon: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
  },
];

const SIGN_OPTS: { id: SignKind; label: string }[] = [
  { id: 'none', label: 'Open' },
  { id: 'yield', label: 'Yield' },
  { id: 'stop', label: 'Stop' },
  { id: 'blinkY', label: 'Blink Y' },
  { id: 'blinkR', label: 'Blink R' },
];

function compass(h: V): string {
  // approach physically lies opposite the arrival heading
  const a = Math.atan2(-h.y, -h.x) * 180 / Math.PI;
  const dirs = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];
  return dirs[Math.round(((a + 360) % 360) / 45) % 8];
}

export class UI {
  private panel = document.getElementById('panel')!;
  private panelContent = document.getElementById('panel-content')!;
  private hintEl = document.getElementById('hint')!;
  private toastEl = document.getElementById('toast')!;
  private toastTimer = 0;
  private currentPanelNode: number | null = null;

  constructor(
    private net: Network,
    private sim: Sim,
    private tools: Tools,
    private onChange: () => void,
  ) {
    this.buildToolbar();
    this.buildRoadTypes();
  }

  /* ---------------- toolbar ---------------- */

  private buildToolbar() {
    const host = document.getElementById('tools')!;
    for (const t of TOOL_DEFS) {
      const btn = document.createElement('button');
      btn.className = 'toolbtn';
      btn.dataset.tool = t.id;
      btn.innerHTML = `${t.icon}<span class="tlabel">${t.label}</span><kbd>${t.key}</kbd>`;
      btn.onclick = () => this.setTool(t.id);
      host.appendChild(btn);
    }
    document.getElementById('snap-grid')!.onclick = () => this.setSnap('grid');
    document.getElementById('snap-free')!.onclick = () => this.setSnap('free');
    document.getElementById('snap-curve')!.onclick = () => this.setSnap('curve');
    this.syncToolbar();
  }

  setTool(t: ToolKind) {
    this.tools.setTool(t);
    this.syncToolbar();
  }

  setSnap(m: 'grid' | 'free' | 'curve') {
    if (this.tools.snapMode !== m) this.tools.cancelChain();
    this.tools.snapMode = m;
    document.getElementById('snap-grid')!.classList.toggle('active', m === 'grid');
    document.getElementById('snap-free')!.classList.toggle('active', m === 'free');
    document.getElementById('snap-curve')!.classList.toggle('active', m === 'curve');
    this.hint(this.defaultHint());
  }

  syncToolbar() {
    document.querySelectorAll<HTMLButtonElement>('.toolbtn').forEach(b => {
      b.classList.toggle('active', b.dataset.tool === this.tools.tool);
    });
    const t = this.tools.tool;
    document.getElementById('draw-options')!.hidden = t !== 'draw' && t !== 'upgrade';
    document.getElementById('placement-opts')!.hidden = t !== 'draw';
    const game = document.getElementById('game')!;
    game.className = `tool-${t}`;
    this.hint(this.defaultHint());
  }

  private defaultHint(): string {
    switch (this.tools.tool) {
      case 'draw':
        return this.tools.snapMode === 'curve'
          ? 'Curve mode: click to <b>start</b>, click to <b>aim</b> the angle, click to <b>lock</b> the curve — then keep clicking to flow. <b>Esc</b> ends.'
          : 'Click to place road points, <b>Esc</b> to stop the chain. Draw across roads to make intersections. Right-drag pans, wheel zooms.';
      case 'upgrade': return 'Pick a road type, then click or drag across roads to convert them in place.';
      case 'edit': return 'Drag nodes to reshape roads — curves smooth automatically. Click a road to insert a node. <b>Del</b> removes/dissolves.';
      case 'select': return 'Click an intersection to set signs or program signals. Click a road to change its type.';
      case 'gate': return 'Click a dead-end road tip to add a spawn gate. Cars enter and exit the map there.';
      case 'bulldoze': return 'Click roads or intersections to demolish them.';
    }
  }

  /* ---------------- road type cards ---------------- */

  private buildRoadTypes() {
    const host = document.getElementById('roadtypes')!;
    for (const rt of ROAD_TYPES) {
      const card = document.createElement('button');
      card.className = 'rtcard';
      card.dataset.rt = rt.id;
      const cv = document.createElement('canvas');
      cv.width = 64; cv.height = 40;
      this.drawRoadThumb(cv, rt.id);
      const meta = document.createElement('div');
      meta.className = 'rtmeta';
      meta.innerHTML = `<span class="rtname">${rt.name}</span><span class="rtdesc">${rt.desc}</span>`;
      card.append(cv, meta);
      card.onclick = () => {
        this.tools.roadTypeId = rt.id;
        host.querySelectorAll('.rtcard').forEach(c => c.classList.toggle('active', c === card));
        // retype selected segment when inspecting
        if (this.tools.tool === 'select' && this.tools.selection?.kind === 'seg') {
          this.net.changeSegType(this.tools.selection.id, rt.id);
          this.net.rebuild();
          this.onChange();
        }
      };
      host.appendChild(card);
    }
    host.querySelector(`[data-rt="${this.tools.roadTypeId}"]`)?.classList.add('active');
  }

  private drawRoadThumb(cv: HTMLCanvasElement, rtId: string) {
    const rt = roadType(rtId);
    const c = cv.getContext('2d')!;
    const W = cv.width, H = cv.height;
    c.fillStyle = '#5d7a4c';
    c.fillRect(0, 0, W, H);
    const sc = Math.min(2.4, (H - 6) / (rt.halfWidth * 2));
    const cy = H / 2;
    const hw = rt.halfWidth * sc;
    c.fillStyle = '#41454d';
    c.fillRect(0, cy - hw, W, hw * 2);
    if (rt.centerTurn) {
      c.fillStyle = 'rgba(231,185,60,.12)';
      c.fillRect(0, cy - (LANE_W * sc) / 2, W, LANE_W * sc);
    }
    const line = (off: number, color: string, dash: number[] | null, w = 1.2) => {
      c.strokeStyle = color; c.lineWidth = w;
      c.setLineDash(dash ?? []);
      c.beginPath(); c.moveTo(0, cy + off * sc); c.lineTo(W, cy + off * sc); c.stroke();
      c.setLineDash([]);
    };
    line(rt.halfWidth - 0.4, '#e8e6df', null);
    line(-(rt.halfWidth - 0.4), '#e8e6df', null);
    if (rt.centerTurn) {
      line(LANE_W / 2 + 0.48, '#e7b93c', null, 1.35);
      line(-(LANE_W / 2 + 0.48), '#e7b93c', null, 1.35);
      line(LANE_W / 2 - 0.28, '#e7b93c', [4, 3], 1.1);
      line(-(LANE_W / 2 - 0.28), '#e7b93c', [4, 3], 1.1);
    } else if (!rt.oneWay) {
      line(0.5, '#e7b93c', null, 1);
      line(-0.5, '#e7b93c', null, 1);
    }
    for (const dir of [1, -1]) {
      const offs = rt.lanes.filter(l => l.dir === dir && l.kind === 'drive').map(l => l.off).sort((a, b) => a - b);
      for (let i = 1; i < offs.length; i++) line((offs[i - 1] + offs[i]) / 2, '#e8e6df', [4, 4], 1);
    }
    if (rt.oneWay) {
      c.fillStyle = '#e8e6df';
      c.beginPath();
      c.moveTo(W / 2 + 6, cy); c.lineTo(W / 2 - 2, cy - 3); c.lineTo(W / 2 - 2, cy + 3);
      c.fill();
    }
  }

  /* ---------------- hint + toast ---------------- */

  hint(html: string) { this.hintEl.innerHTML = html; }

  toast(msg: string) {
    this.toastEl.textContent = msg;
    this.toastEl.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => { this.toastEl.hidden = true; }, 2600);
  }

  /* ---------------- stats ---------------- */

  updateStats(st: SimStats) {
    document.getElementById('st-cars')!.textContent = String(st.carCount);
    document.getElementById('st-arrived')!.textContent = String(st.arrived);
    document.getElementById('st-flow')!.textContent = String(st.flowPerMin);
    document.getElementById('st-trip')!.textContent = st.avgTrip ? `${st.avgTrip.toFixed(0)}s` : '—';
    document.getElementById('st-grid-wrap')!.hidden = !st.gridlocked;
  }

  /* ---------------- panels ---------------- */

  onSelect(sel: Selection | null) {
    this.currentPanelNode = null;
    if (!sel) { this.panel.hidden = true; return; }
    if (sel.kind === 'node') {
      const node = this.net.nodes.get(sel.id);
      if (!node) { this.panel.hidden = true; return; }
      if (node.gate) this.renderGatePanel(node);
      else if (node.isJunction) { this.currentPanelNode = node.id; this.renderJunctionPanel(node); }
      else this.renderNodePanel(node);
    } else {
      const seg = this.net.segs.get(sel.id);
      if (!seg) { this.panel.hidden = true; return; }
      this.renderSegPanel(seg);
    }
  }

  /** re-render junction panel if topology shifted; refresh live indicators */
  tick() {
    if (this.currentPanelNode === null || this.panel.hidden) return;
    const node = this.net.nodes.get(this.currentPanelNode);
    if (!node) { this.panel.hidden = true; this.currentPanelNode = null; return; }
    if (node.control.kind === 'lights') {
      const live = this.sim.signals.currentPhase(node);
      this.panelContent.querySelectorAll('.phase-card').forEach((el, i) => {
        el.classList.toggle('live', i === live);
      });
    }
  }

  private panelShell(kicker: string, title: string): HTMLElement {
    this.panel.hidden = false;
    this.panelContent.innerHTML = `
      <div class="panel-head">
        <div><span class="panel-kicker">${kicker}</span><span class="panel-title">${title}</span></div>
        <button class="panel-close" title="Close">✕</button>
      </div>
      <div class="panel-body"></div>`;
    (this.panelContent.querySelector('.panel-close') as HTMLElement).onclick = () => this.tools.select(null);
    return this.panelContent.querySelector('.panel-body') as HTMLElement;
  }

  private renderNodePanel(node: RNode) {
    const body = this.panelShell('Road node', node.segs.length === 1 ? 'Dead end' : 'Curve node');
    body.innerHTML = `
      <div class="legend-note">${node.segs.length === 1
        ? 'A loose road end. Use the <b>Spawn gate</b> tool to turn it into a traffic source/exit.'
        : 'A shaping node. Use <b>Edit nodes</b> to drag it — the road curves smoothly through it. Cars never stop here.'}</div>
      <div class="legend-note">Traffic controls (signals, stop &amp; yield signs) live on
      <b>intersections</b> — nodes where 3+ roads meet. Build a crossing or
      tee a road into this one, then inspect the junction.</div>`;
    const del = document.createElement('button');
    del.className = 'bigbtn danger';
    del.textContent = node.segs.length === 2 ? 'Dissolve node' : 'Delete node';
    del.onclick = () => { this.tools.selection = { kind: 'node', id: node.id }; this.tools.deleteSelected(); };
    body.appendChild(del);
  }

  private renderGatePanel(node: RNode) {
    const body = this.panelShell('Spawn gate', node.gate!.industrial ? 'Industrial gate' : 'Traffic gate');
    const rate = node.gate!.rate;
    body.innerHTML = `
      <div class="seg-ctrl" id="gate-kind">
        <button data-ind="0" class="${node.gate!.industrial ? '' : 'active'}">City traffic</button>
        <button data-ind="1" class="${node.gate!.industrial ? 'active' : ''}">Industrial</button>
      </div>
      <div class="fieldrow"><span>Spawn rate</span><span class="fval"><span id="gate-rate-val">${rate}</span> /min</span></div>
      <input type="range" id="gate-rate" min="0" max="40" step="1" value="${rate}">
      <div class="legend-note">${node.gate!.industrial
        ? '<b>Industrial</b>: dispatches semi trucks (plus some pickups). Semis are long, slow to accelerate, and other drivers will overtake them on multi-lane roads.'
        : 'Cars spawn here and pick a random <b>other</b> gate as a destination. They route with live traffic in mind and re-route around jams.'}</div>`;
    body.querySelectorAll<HTMLButtonElement>('#gate-kind button').forEach(b => {
      b.onclick = () => {
        node.gate!.industrial = b.dataset.ind === '1';
        this.onChange();
        this.renderGatePanel(node);
      };
    });
    const slider = body.querySelector('#gate-rate') as HTMLInputElement;
    slider.oninput = () => {
      node.gate!.rate = +slider.value;
      body.querySelector('#gate-rate-val')!.textContent = slider.value;
      this.onChange();
    };
    const del = document.createElement('button');
    del.className = 'bigbtn danger';
    del.textContent = 'Remove gate';
    del.onclick = () => {
      node.gate = null;
      this.onChange();
      this.tools.select(null);
    };
    body.appendChild(del);
  }

  private renderSegPanel(seg: Segment) {
    const body = this.panelShell('Road section', seg.rt.name);
    // edits apply to the whole connected run of this road
    const chainSegs = this.net.chains.find(c => c.segs.includes(seg.id))?.segs ?? [seg.id];
    const applyToChain = (fn: (s: Segment) => void) => {
      for (const sid of chainSegs) {
        const s = this.net.segs.get(sid);
        if (s) fn(s);
      }
      this.net.rebuild();
      this.onChange();
      this.renderSegPanel(this.net.segs.get(seg.id) ?? seg);
    };

    const curSpd = seg.speedLimit ?? seg.rt.speed;
    body.innerHTML = `
      <div class="fieldrow"><span>Length</span><span class="fval">${seg.poly.len.toFixed(0)} m</span></div>
      <div class="fieldrow"><span>Speed limit</span><span class="fval">${Math.round(curSpd * MPH)} mph</span></div>`;

    const speedSet = document.createElement('div');
    speedSet.className = 'seg-ctrl';
    const PRESETS: [number, number][] = [[25, 11.2], [35, 15.6], [45, 20.1], [60, 26.8], [75, 33.5]];
    for (const [mph, val] of PRESETS) {
      const b = document.createElement('button');
      b.textContent = String(mph);
      b.classList.toggle('active', Math.abs(curSpd - val) < 1);
      b.onclick = () => applyToChain(s => { s.speedLimit = val; });
      speedSet.appendChild(b);
    }
    body.appendChild(speedSet);

    body.insertAdjacentHTML('beforeend', '<div class="optlabel" style="margin:2px 0 0">Banned vehicles</div>');
    const banSet = document.createElement('div');
    banSet.className = 'signset';
    const KINDS: { k: VehicleKind; label: string }[] = [
      { k: 'semi', label: 'Semis' }, { k: 'pickup', label: 'Pickups' },
      { k: 'suv', label: 'SUVs' }, { k: 'sedan', label: 'Sedans' },
    ];
    for (const { k, label } of KINDS) {
      const b = document.createElement('button');
      b.className = 'signbtn';
      b.dataset.sign = 'stop';
      b.textContent = label;
      b.classList.toggle('active', seg.bans.includes(k));
      b.onclick = () => applyToChain(s => {
        const i = s.bans.indexOf(k);
        if (i >= 0) s.bans.splice(i, 1); else s.bans.push(k);
      });
      banSet.appendChild(b);
    }
    body.appendChild(banSet);

    body.insertAdjacentHTML('beforeend', `
      <div class="legend-note">Speed limit and bans apply to the <b>whole connected road</b>
      (${chainSegs.length} section${chainSegs.length > 1 ? 's' : ''}). Banned vehicles route around it.
      Pick a road type on the left toolbar to <b>convert</b> this section.</div>`);

    const del = document.createElement('button');
    del.className = 'bigbtn danger';
    del.textContent = 'Demolish section';
    del.onclick = () => {
      this.net.removeSegment(seg.id);
      this.net.rebuild();
      this.onChange();
      this.tools.select(null);
    };
    body.appendChild(del);
  }

  /* ---------------- junction panel ---------------- */

  private renderJunctionPanel(node: RNode) {
    const kind = node.control.kind;
    const body = this.panelShell('Intersection', `${node.approaches.length}-way junction`);

    const ctrl = document.createElement('div');
    ctrl.className = 'seg-ctrl';
    const kinds: { k: string; label: string }[] = [
      { k: 'open', label: 'Right of way' },
      { k: 'signs', label: 'Signs' },
      { k: 'lights', label: 'Signals' },
    ];
    for (const { k, label } of kinds) {
      const b = document.createElement('button');
      b.textContent = label;
      b.classList.toggle('active', kind === k);
      b.onclick = () => {
        if (k === 'open') node.control = { kind: 'open' };
        else if (k === 'signs') {
          const signs: Record<number, SignKind> = {};
          node.approaches.forEach(a => signs[a.seg] = 'none');
          node.control = { kind: 'signs', signs };
        } else {
          node.control = { kind: 'lights', phases: autoPhases(node, false), yellow: 3 };
          this.sim.signals.resetJunction(node.id);
        }
        this.net.rebuild();   // signals clear the junction box of through-markings
        this.onChange();
        this.renderJunctionPanel(node);
      };
      ctrl.appendChild(b);
    }
    body.appendChild(ctrl);

    const helpersRow = document.createElement('label');
    helpersRow.className = 'fieldrow';
    helpersRow.innerHTML = `<span>Left-turn helpers</span>`;
    const helpers = document.createElement('input');
    helpers.type = 'checkbox';
    helpers.checked = node.showTurnHelpers;
    helpers.onchange = () => {
      node.showTurnHelpers = helpers.checked;
      this.onChange();
    };
    helpersRow.appendChild(helpers);
    body.appendChild(helpersRow);

    if (kind === 'open') {
      body.insertAdjacentHTML('beforeend', `
        <div class="legend-note">Unmanaged crossing. Cars follow common rules:
        straight beats turns, left turns yield to oncoming traffic, and ties go
        to the car on the right. Fine for light traffic — upgrade when queues form.</div>`);
    } else if (kind === 'signs' && node.control.kind === 'signs') {
      const signs = node.control.signs;
      for (const ap of node.approaches) {
        const row = document.createElement('div');
        row.className = 'approach-row';
        const segObj = this.net.segs.get(ap.seg);
        row.innerHTML = `<div class="approach-name"><span class="dirchip">${compass(ap.heading)}</span> ${segObj?.rt.name ?? 'road'} approach</div>`;
        const set = document.createElement('div');
        set.className = 'signset';
        for (const opt of SIGN_OPTS) {
          const b = document.createElement('button');
          b.className = 'signbtn';
          b.dataset.sign = opt.id;
          b.textContent = opt.label;
          b.classList.toggle('active', (signs[ap.seg] ?? 'none') === opt.id);
          b.onclick = () => {
            signs[ap.seg] = opt.id;
            set.querySelectorAll('.signbtn').forEach(x => x.classList.toggle('active', x === b));
            this.onChange();
          };
          set.appendChild(b);
        }
        row.appendChild(set);
        body.appendChild(row);
      }
      body.insertAdjacentHTML('beforeend', `
        <div class="legend-note"><b>Stop</b>/<b>Blink R</b> require a full stop.
        <b>Yield</b>/<b>Blink Y</b> give way without stopping. Give the busy road
        <b>Open</b> and side streets <b>Stop</b> for a classic priority road.</div>`);
    } else if (kind === 'lights' && node.control.kind === 'lights') {
      this.renderPhaseEditor(body, node);
    }
  }

  private renderPhaseEditor(body: HTMLElement, node: RNode) {
    if (node.control.kind !== 'lights') return;
    const control = node.control;

    const presets = document.createElement('div');
    presets.className = 'presetrow';
    const mkPreset = (label: string, prot: boolean) => {
      const b = document.createElement('button');
      b.className = 'ghostbtn';
      b.textContent = label;
      b.onclick = () => {
        control.phases = autoPhases(node, prot);
        this.sim.signals.resetJunction(node.id);
        this.onChange();
        this.renderJunctionPanel(node);
      };
      return b;
    };
    presets.append(mkPreset('Auto: simple', false), mkPreset('Auto: protected lefts', true));
    body.appendChild(presets);

    const live = this.sim.signals.currentPhase(node);
    control.phases.forEach((phase, idx) => {
      body.appendChild(this.phaseCard(node, phase, idx, idx === live, control));
    });

    const add = document.createElement('button');
    add.className = 'addphase';
    add.textContent = '+ Add phase';
    add.onclick = () => {
      control.phases.push({ dur: 12, green: [] });
      this.onChange();
      this.renderJunctionPanel(node);
    };
    body.appendChild(add);

    const yellowRow = document.createElement('div');
    yellowRow.className = 'fieldrow';
    yellowRow.innerHTML = `<span>Yellow time</span>`;
    const yIn = document.createElement('input');
    yIn.type = 'number'; yIn.min = '1'; yIn.max = '8'; yIn.step = '0.5';
    yIn.value = String(control.yellow);
    yIn.onchange = () => { control.yellow = Math.max(1, Math.min(8, +yIn.value || 3)); this.onChange(); };
    yellowRow.appendChild(yIn);
    body.appendChild(yellowRow);

    body.insertAdjacentHTML('beforeend', `
      <div class="legend-note">Click the arrows in each phase to toggle which
      movements get green. <b>Dashed green</b> arrows are permissive — those cars
      still yield to oncoming traffic. Phases run top to bottom, then loop.</div>`);
  }

  private phaseCard(node: RNode, phase: Phase, idx: number, isLive: boolean, control: { phases: Phase[]; yellow: number }): HTMLElement {
    const card = document.createElement('div');
    card.className = 'phase-card' + (isLive ? ' live' : '');

    const head = document.createElement('div');
    head.className = 'phase-head';
    head.innerHTML = `<span class="live-dot"></span><span class="pname">PHASE ${idx + 1}</span>`;
    const durLabel = document.createElement('label');
    durLabel.append('green ');
    const dur = document.createElement('input');
    dur.type = 'number'; dur.min = '3'; dur.max = '90'; dur.step = '1';
    dur.value = String(phase.dur);
    dur.onchange = () => { phase.dur = Math.max(3, Math.min(90, +dur.value || 12)); this.onChange(); };
    durLabel.appendChild(dur);
    durLabel.append(' s');
    head.appendChild(durLabel);
    const del = document.createElement('button');
    del.className = 'pdel';
    del.title = 'Delete phase';
    del.textContent = '✕';
    del.onclick = () => {
      control.phases.splice(idx, 1);
      this.sim.signals.resetJunction(node.id);
      this.onChange();
      this.renderJunctionPanel(node);
    };
    head.appendChild(del);
    card.appendChild(head);

    const dia = document.createElement('div');
    dia.className = 'phase-diagram';
    dia.appendChild(this.junctionDiagram(node, phase));
    card.appendChild(dia);
    return card;
  }

  /** clickable SVG of the junction with per-movement arrows */
  private junctionDiagram(node: RNode, phase: Phase): SVGElement {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '-52 -52 104 104');
    svg.setAttribute('width', '212');
    svg.setAttribute('height', '212');
    svg.classList.add('mini-junction');

    // spokes (where roads physically sit: opposite arrival heading)
    for (const ap of node.approaches) {
      const dx = -ap.heading.x, dy = -ap.heading.y;
      const spoke = document.createElementNS(NS, 'line');
      spoke.setAttribute('x1', String(dx * 18));
      spoke.setAttribute('y1', String(dy * 18));
      spoke.setAttribute('x2', String(dx * 50));
      spoke.setAttribute('y2', String(dy * 50));
      spoke.classList.add('spoke');
      svg.appendChild(spoke);
    }
    const core = document.createElementNS(NS, 'circle');
    core.setAttribute('cx', '0'); core.setAttribute('cy', '0'); core.setAttribute('r', '17');
    core.classList.add('corebox');
    svg.appendChild(core);

    for (const ap of node.approaches) {
      const hx = ap.heading.x, hy = ap.heading.y;       // travel direction
      const px = -hy, py = hx;                          // right of travel
      const baseX = -hx * 34, baseY = -hy * 34;         // out on the spoke
      const turnsHere: ('L' | 'S' | 'R')[] = (['L', 'S', 'R'] as const).filter(t => ap.turns[t]?.length);
      turnsHere.forEach(t => {
        const lat = t === 'L' ? -7.5 : t === 'R' ? 7.5 : 0;
        const ox = baseX + px * lat, oy = baseY + py * lat;
        const mk = `${ap.seg}|${t}`;
        const g = document.createElementNS(NS, 'g');
        g.classList.add('mv-arrow');
        const on = phase.green.includes(mk);
        if (on) g.classList.add('on');
        if (on && isPermissiveLeft(node, mk, phase)) g.classList.add('permissive');

        const ang = Math.atan2(hy, hx) * 180 / Math.PI;
        g.setAttribute('transform', `translate(${ox} ${oy}) rotate(${ang})`);

        const hit = document.createElementNS(NS, 'circle');
        hit.setAttribute('r', '7');
        hit.setAttribute('cx', '6');
        hit.setAttribute('cy', '0');
        hit.classList.add('hitbox');
        g.appendChild(hit);

        const path = document.createElementNS(NS, 'path');
        path.classList.add('glyph');
        if (t === 'S') path.setAttribute('d', 'M 0 0 L 13 0 M 13 0 l -4 -3.2 M 13 0 l -4 3.2');
        else if (t === 'L') path.setAttribute('d', 'M 0 0 L 6 0 Q 9.5 0 9.5 -3.5 L 9.5 -8 M 9.5 -8 l -3.2 3.4 M 9.5 -8 l 3.2 3.4');
        else path.setAttribute('d', 'M 0 0 L 6 0 Q 9.5 0 9.5 3.5 L 9.5 8 M 9.5 8 l -3.2 -3.4 M 9.5 8 l 3.2 -3.4');
        g.appendChild(path);

        g.addEventListener('click', () => {
          const i = phase.green.indexOf(mk);
          if (i >= 0) phase.green.splice(i, 1);
          else phase.green.push(mk);
          this.onChange();
          // re-render diagram in place to refresh permissive styling
          const parent = svg.parentElement!;
          parent.replaceChild(this.junctionDiagram(node, phase), svg);
        });
        svg.appendChild(g);
      });
    }
    return svg;
  }
}
