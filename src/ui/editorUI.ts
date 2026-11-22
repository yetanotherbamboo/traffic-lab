import { formatMoney } from '../editor/cost';
import { BUILD_LEVELS, type Editor, ROAD_PRESETS, type Tool } from '../editor/editor';
import type { DrawMode } from '../editor/shape';
import type { Vec3 } from '../core/math';
import { MAX_LANES, setControl, setEntrance, setFreeFlow, setGreen, setLanes, setMajor, setSpeed, setTurns } from '../editor/ops';
import {
  RING_MAX_LANES, RING_MIN_LANES, convertToRoundabout, outerRadius, removeRoundabout, setRoundaboutLanes, setRoundaboutSize,
} from '../editor/roundabout';
import type { World } from '../game/world';
import { type JunctionControl, type RoadSegment, SAME_LEVEL, TURN_LEFT, TURN_RIGHT, TURN_STRAIGHT } from '../network/network';
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

const TOOLS: [Tool, string][] = [['view', 'Move'], ['road', 'Build'], ['bend', 'Reshape'], ['select', 'Edit'], ['delete', 'Remove']];

const HINTS: Record<Tool, string> = {
  view: 'Drag to move · pinch or two fingers to zoom and turn',
  road: 'Drag from one point to another, or tap the start and then the end · two fingers move the view',
  bend: 'Drag a junction or road end to move it · drag the middle of a road to bend it',
  select: 'Tap a road, junction or roundabout to change it',
  delete: 'Tap a road to remove it, or drag across several · drags starting off a road move the view',
};

/** Lane turn options a lane button cycles through (0 = automatic). */
const TURN_CYCLE = [0, TURN_LEFT, TURN_STRAIGHT, TURN_RIGHT, TURN_LEFT | TURN_STRAIGHT, TURN_STRAIGHT | TURN_RIGHT,
  TURN_LEFT | TURN_STRAIGHT | TURN_RIGHT, TURN_LEFT | TURN_RIGHT];

export function turnGlyphs(mask: number): string {
  return (mask & TURN_LEFT ? '←' : '') + (mask & TURN_STRAIGHT ? '↑' : '') + (mask & TURN_RIGHT ? '→' : '') || '·';
}

const SHAPES: [DrawMode, string][] = [['straight', 'Straight'], ['curve', 'Curve'], ['continuous', 'Continuous'], ['upgrade', 'Upgrade']];

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
/** " · bridge 6 m" / " · ramp 0–6 m" for raised roads, nothing on the ground. */
function levelLabel(seg: RoadSegment): string {
  const ya = seg.curve.p0[1], yb = seg.curve.p3[1];
  const m = (y: number): string => `${Math.round(y)}`;
  if (Math.abs(ya - yb) > SAME_LEVEL) return ` · ramp ${m(Math.min(ya, yb))}–${m(Math.max(ya, yb))} m`;
  return Math.abs(ya) > SAME_LEVEL ? ` · ${ya > 0 ? 'bridge' : 'tunnel'} ${m(Math.abs(ya))} m` : '';
}
const swatch = (hex: string): HTMLElement => h('span', { class: 'sw', style: `background:${hex}` });

/** HTML toolbar, hint/preview line and the panels for changing roads and junctions. */
export class EditorUI {
  private readonly toolbar = document.getElementById('toolbar')!;
  private readonly info = document.getElementById('info')!;
  private readonly panel = document.getElementById('panel')!;
  private readonly tag = document.getElementById('tag')!;
  private tagAt: Vec3 | null = null;
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
        editor.discard();
      } else if (e.key === 'Enter' && editor.pending) {
        e.preventDefault();
        editor.confirm();
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
    this.renderTag();
    const sel = ed.selection;
    const key = `${ed.tool}|${ed.preset}|${ed.drawMode}|${ed.snapping}|${ed.parallel}|${ed.level}|${sel ? `${sel.kind}${sel.id}` : ''}|${this.world.version}`;
    if (key !== this.panelKey) {
      this.panelKey = key;
      this.renderPanel();
    }
  }

  private renderInfo(): void {
    const ed = this.editor, d = ed.draft;
    const out: Child[] = [];
    const stop = (): HTMLElement => chip('✕', false, () => ed.discard(), 'icon');
    if (ed.tool === 'road' && ed.pending && d) {
      // A pending road: what it costs (or why it can't be built), with ✕ and ✓ either side.
      // One row: ✕ | what it costs (or why not), wrapping in the middle | ✓ Build.
      const text = d.error ? h('span', { class: 'err' }, d.error) : h('span', {}, ...this.costLine(d));
      text.classList.add('grow');
      const ok = chip('✓ Build', false, () => ed.confirm(), 'go') as HTMLButtonElement;
      ok.disabled = !ed.canConfirm;
      out.push(stop(), text, ok);
    } else if (d?.sweepKind) {
      const n = d.swept.length, roads = `${n} ${n === 1 ? 'road' : 'roads'}`;
      out.push(n === 0 ? 'Drag across the roads'
        : d.sweepKind === 'remove' ? h('span', {}, 'Lift to remove ', h('b', {}, roads), ' · Undo brings them back')
        : h('span', {}, 'Lift to make ', h('b', {}, roads), ` ${ROAD_PRESETS[ed.preset]!.name}`));
    } else if (d?.candidate && ed.tool === 'bend') {
      out.push(...(d.error ? [h('span', { class: 'err' }, d.error)] : this.costLine(d)));
    } else if (ed.tool === 'road' && ed.pendingStart) {
      out.push(stop(), ' ', ed.message ? h('span', { class: 'err' }, ed.message)
        : ed.noContinuation ? 'Nothing to continue here: this road will be straight · tap or drag to its end'
        : 'Tap where the road ends, or drag from its start');
    } else if (ed.message) {
      out.push(h('span', { class: 'err' }, ed.message));
    } else if (ed.tool === 'road' && ed.drawMode === 'upgrade') {
      out.push(`Tap or drag across roads to make them ${ROAD_PRESETS[ed.preset]!.name} · tap a one-way road again to reverse it`);
    } else {
      out.push(HINTS[ed.tool]);
    }
    this.info.replaceChildren(...out.filter((c): c is Node | string => !!c));
    this.info.classList.toggle('pending', ed.tool === 'road' && ed.pending && !!d);
    this.info.hidden = false;
  }

  /** The floating label's text: "42 m · 90°", and the bend speed when cars must slow down. */
  private renderTag(): void {
    const g = this.editor.tool === 'road' ? this.editor.draft?.guide ?? null : null;
    this.tagAt = g?.at ?? null;
    if (!g) {
      this.tag.hidden = true;
      return;
    }
    const top = `${g.length.toFixed(0)} m${g.angle !== null ? ` · ${g.angle}°` : ''}`;
    this.tag.replaceChildren(top, ...(g.slowTo !== null ? [h('span', { class: 'slow' }, `bend: cars slow to ${g.slowTo} km/h`)] : []));
    this.tag.hidden = false;
  }

  /**
   * Call every frame after the camera moved: keeps the label above its point on screen.
   * `project` maps a ground point to CSS pixels, or returns false when it is behind the camera.
   */
  placeTag(project: (p: Vec3, out: [number, number]) => boolean): void {
    if (!this.tagAt || this.tag.hidden) return;
    const s = this.screen;
    if (!project(this.tagAt, s)) {
      this.tag.style.transform = 'translate(-9999px, 0)';
      this.tagX = NaN;
      return;
    }
    const lift = 56; // px between the point and the label: clear of a fingertip
    const above = s[1] - lift - this.tag.offsetHeight > 70; // keep clear of the stats at the top
    const y = above ? s[1] - lift - this.tag.offsetHeight : s[1] + lift;
    const x = Math.min(Math.max(s[0] - this.tag.offsetWidth / 2, 6), window.innerWidth - this.tag.offsetWidth - 6);
    const rx = Math.round(x), ry = Math.round(y);
    if (rx === this.tagX && ry === this.tagY) return;
    this.tagX = rx;
    this.tagY = ry;
    this.tag.style.transform = `translate(${rx}px, ${ry}px)`;
  }

  private readonly screen: [number, number] = [0, 0];
  private tagX = NaN;
  private tagY = NaN;

  /** "42 m · 120 k€ · demolishes 3 items (45 k€)" */
  private costLine(d: NonNullable<Editor['draft']>): Child[] {
    const out: Child[] = [];
    // A parallel pair: "2 × 45 m" (along the drawn line), not both lengths added up.
    const pair = this.editor.tool === 'road' && this.editor.parallel && d.guide;
    if (pair) out.push(h('b', {}, `2 × ${d.guide!.length.toFixed(0)} m`), ' · ');
    else if (d.length > 0) out.push(h('b', {}, `${d.length.toFixed(0)} m`), ' · ');
    out.push(h('b', {}, formatMoney(d.cost)));
    if (d.demolish.length > 0) {
      const n = d.demolish.length;
      out.push(' · demolishes ', h('b', {}, `${n} ${n === 1 ? 'item' : 'items'}`), ` (${formatMoney(d.demolishCost)})`);
    }
    return out;
  }

  private renderPanel(): void {
    const ed = this.editor, sel = ed.selection;
    const body: Child[] = [];
    if (ed.tool === 'road') {
      // Two rows that scroll sideways (no wrapping), so the panel stays short on a phone.
      body.push(h('div', { class: 'row scroll' }, ...ROAD_PRESETS.map((p, i) =>
        chip(`${p.name} ${p.profile.forward}${p.profile.backward ? `+${p.profile.backward}` : ''}`, ed.preset === i, () => {
          ed.setPreset(i);
        }))));
      body.push(h('div', { class: 'row scroll' },
        ...SHAPES.map(([m, label]) => chip(label, ed.drawMode === m, () => ed.setDrawMode(m))),
        ed.drawMode !== 'upgrade' && h('span', { class: 'vsep' }),
        ed.drawMode !== 'upgrade' && chip('Parallel', ed.parallel, () => ed.setParallel(!ed.parallel), 'toggle'),
        ed.drawMode !== 'upgrade' && chip('Snap', ed.snapping, () => ed.setSnapping(!ed.snapping), 'toggle')));
      // Level: new roads are built at this height, with ramps where they meet other levels.
      if (ed.drawMode !== 'upgrade') {
        body.push(h('div', { class: 'row scroll' }, ...BUILD_LEVELS.map((l) => chip(l.name, ed.level === l.level, () => ed.setLevel(l.level)))));
      }
    } else if (ed.tool === 'select' && sel?.kind === 'segment' && this.world.net.segments.has(sel.id)) {
      body.push(...this.roadPanel(sel.id));
    } else if (ed.tool === 'select' && sel?.kind === 'node' && this.world.net.nodes.has(sel.id)) {
      body.push(...this.junctionPanel(sel.id));
    } else if (ed.tool === 'select' && sel?.kind === 'roundabout' && this.world.net.roundabouts.has(sel.id)) {
      body.push(...this.roundaboutPanel(sel.id));
    }
    // Rebuilding resets sideways-scrolled rows: keep where they were.
    const scrolled = [...this.panel.querySelectorAll<HTMLElement>('.row.scroll')].map((r) => r.scrollLeft);
    this.panel.replaceChildren(...body.filter((c): c is Node | string => !!c));
    this.panel.querySelectorAll<HTMLElement>('.row.scroll').forEach((r, i) => (r.scrollLeft = scrolled[i] ?? 0));
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
      h('h3', {}, `Road · ${seg.curve.length.toFixed(0)} m${levelLabel(seg)}`),
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
    const entrance = net.isEntrance(nodeId);
    const out: Child[] = [h('h3', {}, entrance ? 'Entrance · the through road has right of way' : `Junction · ${arms.length} roads`)];
    // A small road joining a through road can be a compact entrance instead of a full junction.
    if (net.entranceLayout(nodeId)) {
      out.push(h('div', { class: 'row' }, h('span', { class: 'label' }, 'Type'),
        chip('Junction', !entrance, () => entrance && this.act((n) => setEntrance(n, nodeId, false))),
        chip('Entrance', entrance, () => !entrance && this.act((n) => setEntrance(n, nodeId, true)))));
    }
    if (!entrance) {
      out.push(h('div', { class: 'row' }, ...CONTROLS.map(([c, label]) => chip(label, control === c, () => this.act((n) => setControl(n, nodeId, c)))),
        chip('Roundabout', false, () => this.toRoundabout(nodeId))));
    }

    if (control === 'priority' && !entrance) {
      const major = w.sim.junctions.major.get(nodeId);
      const pairs: [number, number][] = [];
      for (let i = 0; i < arms.length; i++) for (let j = i + 1; j < arms.length; j++) pairs.push([arms[i]!.segment.id, arms[j]!.segment.id]);
      const cur = pairs.findIndex(([a, b]) => major?.has(a) && major.has(b));
      out.push(h('div', { class: 'row' }, h('span', { class: 'label' }, 'Main road'),
        ...(cur >= 0 ? pairs[cur]!.map((s) => swatch(colorOf(s))) : []),
        chip('Change', false, () => this.act((n) => setMajor(n, nodeId, pairs[(cur + 1) % pairs.length]!)))));
    }

    if (control === 'signal' && !entrance) {
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
