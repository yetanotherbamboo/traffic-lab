import { formatMoney } from '../editor/cost';
import { type Editor, ROAD_PRESETS, type Tool } from '../editor/editor';
import { MAX_LANES, setControl, setFreeFlow, setGreen, setLanes, setMajor, setSpeed, setTurns } from '../editor/ops';
import {
  RING_MAX_LANES, RING_MIN_LANES, convertToRoundabout, outerRadius, removeRoundabout, setRoundaboutLanes, setRoundaboutSize,
} from '../editor/roundabout';
import type { World } from '../game/world';
import { type JunctionControl, TURN_LEFT, TURN_RIGHT, TURN_STRAIGHT } from '../network/network';
import { TURN_BIT } from '../sim/laneGraph';
import { APPROACH_HEX, BACKWARD_HEX, FORWARD_HEX } from './colors';

const ICONS: Record<string, string> = {
  view: 'M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3',
  road: 'M6 21L10 3M18 21L14 3M12 5v2M12 11v2M12 17v2',
  bend: 'M4 20C4 11 11 4 20 4M12 9.5a2 2 0 1 0 .01 0',
  select: 'M5 3l13 8-6 1.5L9 19z',
  delete: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  undo: 'M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
  redo: 'M15 14l5-5-5-5M20 9H9a5 5 0 0 0 0 10h3',
};

const TOOLS: [Tool, string][] = [['view', 'Move'], ['road', 'Build'], ['bend', 'Bend'], ['select', 'Edit'], ['delete', 'Remove']];

const HINTS: Record<Tool, string> = {
  view: 'Drag to move · pinch or two fingers to zoom and turn',
  road: 'Drag from a point to another to build a road · two fingers move the view',
  bend: 'Drag the middle of a road to bend it',
  select: 'Tap a road, junction or roundabout to change it',
  delete: 'Tap a road to remove it',
};

/** Lane turn options a lane button cycles through (0 = automatic). */
const TURN_CYCLE = [0, TURN_LEFT, TURN_STRAIGHT, TURN_RIGHT, TURN_LEFT | TURN_STRAIGHT, TURN_STRAIGHT | TURN_RIGHT,
  TURN_LEFT | TURN_STRAIGHT | TURN_RIGHT, TURN_LEFT | TURN_RIGHT];

export function turnGlyphs(mask: number): string {
  return (mask & TURN_LEFT ? '←' : '') + (mask & TURN_STRAIGHT ? '↑' : '') + (mask & TURN_RIGHT ? '→' : '') || '·';
}

const CONTROLS: [JunctionControl, string][] = [['priority', 'Priority'], ['allway', 'All-way stop'], ['signal', 'Signals']];

type Child = Node | string | null | false;

function h(tag: string, attrs: Record<string, string | ((e: Event) => void)> = {}, ...kids: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') el.addEventListener(k, v);
    else el.setAttribute(k, v);
  }
  for (const k of kids) if (k) el.append(k);
  return el;
}

function icon(name: string): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name]!);
  svg.append(path);
  return svg;
}

const chip = (label: Child, on: boolean, click: () => void, cls = ''): HTMLElement =>
  h('button', { class: `chip ${cls}${on ? ' on' : ''}`, click }, label);
const swatch = (hex: string): HTMLElement => h('span', { class: 'sw', style: `background:${hex}` });

/** HTML toolbar, hint/preview line and the panels for changing roads and junctions. */
export class EditorUI {
  private readonly toolbar = document.getElementById('toolbar')!;
  private readonly info = document.getElementById('info')!;
  private readonly panel = document.getElementById('panel')!;
  private readonly toolButtons = new Map<Tool, HTMLButtonElement>();
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private seen = -1;
  private panelKey = '';

  constructor(private readonly editor: Editor, private readonly world: World) {
    for (const [tool, label] of TOOLS) {
      const b = h('button', { title: label, click: () => editor.setTool(tool) }, icon(tool), label) as HTMLButtonElement;
      this.toolButtons.set(tool, b);
      this.toolbar.append(b);
    }
    this.toolbar.append(h('div', { class: 'sep' }));
    this.undoBtn = h('button', { title: 'Undo', click: () => editor.undo() }, icon('undo'), 'Undo') as HTMLButtonElement;
    this.redoBtn = h('button', { title: 'Redo', click: () => editor.redo() }, icon('redo'), 'Redo') as HTMLButtonElement;
    this.toolbar.append(this.undoBtn, this.redoBtn);
    // Keep page gestures (pinch-zoom, scroll bounce) away from the controls.
    document.getElementById('ui')!.addEventListener('touchmove', (e) => {
      if (!(e.target as HTMLElement).closest('#panel')) e.preventDefault();
    }, { passive: false });
    window.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) editor.redo();
        else editor.undo();
      } else if (e.key === 'Escape') {
        editor.cancel();
      }
    });
  }

  /** Call once per frame; redraws only after a change. */
  update(): void {
    const v = this.editor.version * 100000 + this.world.version;
    if (v === this.seen) return;
    this.seen = v;
    const ed = this.editor;
    for (const [t, b] of this.toolButtons) b.classList.toggle('on', ed.tool === t);
    this.undoBtn.disabled = !ed.canUndo;
    this.redoBtn.disabled = !ed.canRedo;
    this.renderInfo();
    const sel = ed.selection;
    const key = `${ed.tool}|${ed.preset}|${ed.roadMode}|${sel ? `${sel.kind}${sel.id}` : ''}|${this.world.version}`;
    if (key !== this.panelKey) {
      this.panelKey = key;
      this.renderPanel();
    }
  }

  private renderInfo(): void {
    const ed = this.editor, d = ed.draft;
    const out: Child[] = [];
    if (d?.candidate && (ed.tool === 'road' || ed.tool === 'bend')) {
      if (d.error) {
        out.push(h('span', { class: 'err' }, d.error));
      } else {
        const len = d.touched.length > 0 && ed.tool === 'road'
          ? Math.hypot(d.markers[1]!.pos[0] - d.markers[0]!.pos[0], d.markers[1]!.pos[2] - d.markers[0]!.pos[2])
          : 0;
        if (len > 0) out.push(h('b', {}, `${len.toFixed(0)} m`), ' · ');
        out.push(h('b', {}, formatMoney(d.cost)));
        if (d.demolish.length > 0) {
          const n = d.demolish.length;
          out.push(' · demolishes ', h('b', {}, `${n} ${n === 1 ? 'item' : 'items'}`), ` (${formatMoney(d.demolishCost)})`);
        }
      }
    } else if (ed.message) {
      out.push(h('span', { class: 'err' }, ed.message));
    } else if (ed.tool === 'road' && ed.roadMode === 'tap') {
      out.push(ed.pendingStart
        ? 'Tap where the road should end · tap the start again to cancel'
        : 'Tap where the road should start · drag to move the view');
    } else {
      out.push(HINTS[ed.tool]);
    }
    this.info.replaceChildren(...out.filter((c): c is Node | string => !!c));
    this.info.hidden = false;
  }

  private renderPanel(): void {
    const ed = this.editor, sel = ed.selection;
    const body: Child[] = [];
    if (ed.tool === 'road') {
      body.push(h('div', { class: 'row' }, ...ROAD_PRESETS.map((p, i) =>
        chip(`${p.name} ${p.profile.forward}${p.profile.backward ? `+${p.profile.backward}` : ''}`, ed.preset === i, () => {
          ed.preset = i;
          this.panelKey = '';
          this.seen = -1;
        }))));
      body.push(h('div', { class: 'row' }, h('span', { class: 'label' }, 'Draw by'),
        chip('Dragging', ed.roadMode === 'drag', () => ed.setRoadMode('drag')),
        chip('Tapping start and end', ed.roadMode === 'tap', () => ed.setRoadMode('tap'))));
    } else if (ed.tool === 'select' && sel?.kind === 'segment' && this.world.net.segments.has(sel.id)) {
      body.push(...this.roadPanel(sel.id));
    } else if (ed.tool === 'select' && sel?.kind === 'node' && this.world.net.nodes.has(sel.id)) {
      body.push(...this.junctionPanel(sel.id));
    } else if (ed.tool === 'select' && sel?.kind === 'roundabout' && this.world.net.roundabouts.has(sel.id)) {
      body.push(...this.roundaboutPanel(sel.id));
    }
    this.panel.replaceChildren(...body.filter((c): c is Node | string => !!c));
    this.panel.hidden = body.length === 0;
  }

  private act(op: Parameters<Editor['apply']>[0]): void {
    this.editor.apply(op);
  }

  private roadPanel(segId: number): Child[] {
    const seg = this.world.net.segment(segId);
    const { forward: f, backward: b, speedLimit = 50 } = seg.profile;
    const counter = (hex: string, label: string, n: number, set: (k: number) => void): HTMLElement =>
      h('div', { class: 'row' }, h('span', { class: 'label' }, swatch(hex), ` ${label}`),
        chip('−', false, () => set(n - 1)), h('span', { class: 'num' }, String(n)), chip('+', false, () => set(n + 1)));
    return [
      h('h3', {}, `Road · ${seg.curve.length.toFixed(0)} m`),
      counter(FORWARD_HEX, 'Lanes', f, (k) => k >= 0 && k <= MAX_LANES && this.act((n) => setLanes(n, segId, k, b))),
      counter(BACKWARD_HEX, 'Lanes', b, (k) => k >= 0 && k <= MAX_LANES && this.act((n) => setLanes(n, segId, f, k))),
      h('div', { class: 'row' }, h('span', { class: 'label' }, 'Speed'),
        ...[30, 40, 50, 60, 70].map((v) => chip(`${v}`, speedLimit === v, () => this.act((n) => setSpeed(n, segId, v))))),
      f !== b ? h('div', { class: 'row' }, chip('⇄ Swap directions', false, () => this.act((n) => setLanes(n, segId, b, f)))) : null,
    ];
  }

  /** Turns a junction into a roundabout and selects it. */
  private toRoundabout(nodeId: number): void {
    const centre = this.world.net.node(nodeId).pos;
    if (this.editor.apply((n) => convertToRoundabout(n, nodeId)) !== null) return;
    const r = [...this.world.net.roundabouts.values()].find((x) => x.centre[0] === centre[0] && x.centre[2] === centre[2]);
    if (r) this.editor.select({ kind: 'roundabout', id: r.id, pos: r.centre });
  }

  private roundaboutPanel(id: number): Child[] {
    const net = this.world.net;
    const r = net.roundabouts.get(id)!;
    const entries = [...net.nodes.values()].filter((n) => n.ring === id && n.segments.length > 2).length;
    const back = (c: JunctionControl): void => {
      let centre = -1;
      const err = this.editor.apply((n) => {
        const res = removeRoundabout(n, id);
        if (n.nodes.has(res.node)) setControl(n, res.node, c);
        centre = res.node;
        return res;
      });
      if (err === null && this.world.net.nodes.has(centre) && this.world.net.node(centre).segments.length >= 3) {
        this.editor.select({ kind: 'node', id: centre, pos: this.world.net.node(centre).pos });
      }
    };
    const diameter = Math.round(outerRadius(r) * 2);
    return [
      h('h3', {}, `Roundabout · ${entries} ${entries === 1 ? 'road' : 'roads'} · ${diameter} m across`),
      h('div', { class: 'row' }, ...CONTROLS.map(([c, label]) => chip(label, false, () => back(c))), chip('Roundabout', true, () => {})),
      h('div', { class: 'row' }, h('span', { class: 'label' }, 'Lanes'),
        chip('−', false, () => r.lanes > RING_MIN_LANES && this.act((n) => setRoundaboutLanes(n, id, r.lanes - 1))),
        h('span', { class: 'num' }, String(r.lanes)),
        chip('+', false, () => r.lanes < RING_MAX_LANES && this.act((n) => setRoundaboutLanes(n, id, r.lanes + 1)))),
      h('div', { class: 'row' }, h('span', { class: 'label' }, 'Size'),
        chip('−', false, () => this.act((n) => setRoundaboutSize(n, id, r.radius - 2))),
        h('span', { class: 'num' }, `${diameter} m`),
        chip('+', false, () => this.act((n) => setRoundaboutSize(n, id, r.radius + 2)))),
      h('div', { class: 'row' }, h('span', { class: 'label' }, 'Traffic on the ring has right of way; new roads can join it anywhere')),
    ];
  }

  private junctionPanel(nodeId: number): Child[] {
    const w = this.world, net = w.net;
    const node = net.node(nodeId);
    const control = node.control ?? 'priority';
    const arms = net.arms(nodeId);
    const colorOf = (segId: number): string => APPROACH_HEX[arms.findIndex((a) => a.segment.id === segId) % APPROACH_HEX.length]!;
    const out: Child[] = [
      h('h3', {}, `Junction · ${arms.length} roads`),
      h('div', { class: 'row' }, ...CONTROLS.map(([c, label]) => chip(label, control === c, () => this.act((n) => setControl(n, nodeId, c)))),
        chip('Roundabout', false, () => this.toRoundabout(nodeId))),
    ];

    if (control === 'priority') {
      const major = w.sim.junctions.major.get(nodeId);
      const pairs: [number, number][] = [];
      for (let i = 0; i < arms.length; i++) for (let j = i + 1; j < arms.length; j++) pairs.push([arms[i]!.segment.id, arms[j]!.segment.id]);
      const cur = pairs.findIndex(([a, b]) => major?.has(a) && major.has(b));
      out.push(h('div', { class: 'row' }, h('span', { class: 'label' }, 'Main road'),
        ...(cur >= 0 ? pairs[cur]!.map((s) => swatch(colorOf(s))) : []),
        chip('Change', false, () => this.act((n) => setMajor(n, nodeId, pairs[(cur + 1) % pairs.length]!)))));
    }

    if (control === 'signal') {
      const ctrl = w.sim.junctions.signals.get(nodeId);
      ctrl?.phases.forEach((ph, k) => {
        const set = (s: number): void => this.act((n) => {
          for (const a of ph.arms) setGreen(n, nodeId, a, s);
        });
        out.push(h('div', { class: 'row' }, h('span', { class: 'label' }, `Phase ${k + 1} `, ...ph.arms.map((a) => swatch(colorOf(a)))),
          chip('−', false, () => set(ph.green - 5)), h('span', { class: 'num' }, `${ph.green} s`), chip('+', false, () => set(ph.green + 5))));
      });
      if (ctrl) out.push(h('div', { class: 'row' }, h('span', { class: 'label' }, 'Cycle'), `${ctrl.cycle} s (incl. yellow and all-red)`));
    }

    // Non-stop lanes: lanes that cross and merge with no other traffic may skip the control.
    const eligible = w.sim.junctions.nonStop.get(nodeId) ?? [];
    const on = node.freeFlow === true;
    out.push(h('div', { class: 'row' }, h('span', { class: 'label' }, 'Non-stop lanes'),
      chip('Off', !on, () => on && this.act((n) => setFreeFlow(n, nodeId, false))),
      chip('On', on, () => !on && this.act((n) => setFreeFlow(n, nodeId, true)))));
    out.push(h('div', { class: 'row' }, h('span', { class: 'label' }, eligible.length === 0
      ? 'No lane can skip this junction yet: every lane crosses or merges with other traffic. Limit turns below to free one'
      : `${eligible.length === 1 ? '1 lane crosses' : `${eligible.length} lanes cross`} no other traffic${on ? ` and never ${eligible.length === 1 ? 'stops' : 'stop'}` : ''} `,
    ...eligible.map((id) => swatch(colorOf(w.graph.lanes[id]!.segment))))));

    // Turn lanes per approach, innermost lane first (left to right as the driver sees them).
    out.push(h('h3', {}, 'Turn lanes'));
    for (const arm of arms) {
      const seg = arm.segment;
      const n = net.lanesAt(seg, nodeId).incoming;
      if (n === 0) continue;
      const masks = (seg.b === nodeId ? seg.turnsB : seg.turnsA) ?? [];
      const lanes = w.graph.lanes.filter((l) => l.kind === 'road' && l.segment === seg.id && l.toNode === nodeId)
        .sort((a, b) => a.index - b.index);
      const buttons = lanes.map((l) => {
        const mask = masks[l.index] ?? 0;
        let actual = 0;
        for (const c of l.next) actual |= TURN_BIT[w.graph.lanes[c]!.turn ?? 'straight'];
        const next = TURN_CYCLE[(TURN_CYCLE.indexOf(mask) + 1) % TURN_CYCLE.length]!;
        return chip(mask === 0 ? h('span', {}, turnGlyphs(actual), h('span', { class: 'auto' }, 'auto')) : turnGlyphs(mask),
          mask !== 0, () => this.act((nn) => setTurns(nn, seg.id, nodeId, l.index, next)), 'lane');
      });
      out.push(h('div', { class: 'row' }, h('span', { class: 'label' }, swatch(colorOf(seg.id)), ` ${n} ${n === 1 ? 'lane' : 'lanes'}`), ...buttons));
    }
    return out;
  }
}
