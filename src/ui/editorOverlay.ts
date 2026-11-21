import type { Vec3 } from '../core/math';
import type { Editor, Marker } from '../editor/editor';
import { outerRadius } from '../editor/roundabout';
import { segmentEditable } from '../editor/rules';
import type { World } from '../game/world';
import type { OverlayBuilder } from '../render/overlay';
import { APPROACH_HEX, BACKWARD_HEX, FORWARD_HEX, OVERLAY, hexToVec } from './colors';

const MARKER_COLOR: Record<Marker['kind'], Vec3> = {
  node: OVERLAY.node, segment: OVERLAY.segment, free: OVERLAY.free, handle: OVERLAY.segment, blocked: OVERLAY.error,
};

/** A snap marker: a ring, or a red cross where no road can start. */
function marker(ob: OverlayBuilder, m: Marker, color: Vec3): void {
  if (m.kind !== 'blocked') {
    ob.ring(m.pos, m.kind === 'handle' ? 1.6 : 2.4, color);
    return;
  }
  const r = 2.0, [x, , z] = m.pos;
  ob.strip([x - r, 0, z - r], [x + r, 0, z + r], 0.7, color);
  ob.strip([x - r, 0, z + r], [x + r, 0, z - r], 0.7, color);
}
const APPROACH = APPROACH_HEX.map(hexToVec);
const FORWARD = hexToVec(FORWARD_HEX), BACKWARD = hexToVec(BACKWARD_HEX);

/** Fills the overlay for the editor's current state: previews, snap points, selection. */
export function buildEditorOverlay(ob: OverlayBuilder, ed: Editor, w: World): void {
  ob.clear();
  const d = ed.draft;
  if (d) {
    const net = d.candidate;
    const color = d.error ? OVERLAY.error : OVERLAY.ok;
    if (net) {
      for (const id of d.changed) {
        const seg = net.segments.get(id);
        if (seg) ob.curve(seg.curve, color, 1.0);
      }
    }
    for (const m of d.markers) marker(ob, m, d.error && m.kind === 'free' ? color : MARKER_COLOR[m.kind]);
    for (const id of d.demolish) {
      const it = w.city.items[id]!;
      if (it.lot) ob.lot(it.lot, OVERLAY.demolish);
      else ob.ring([it.x, 0, it.z], it.r, OVERLAY.demolish, 0.35);
    }
  }
  if (ed.hover) marker(ob, ed.hover, MARKER_COLOR[ed.hover.kind]);

  // Bend tool: grab handles in the middle of every editable road.
  if (ed.tool === 'bend' && !d) {
    for (const seg of w.net.segments.values()) {
      if (seg.ring === undefined && segmentEditable(w.net, w.zone, seg)) ob.dot(seg.curve.point(0.5), 1.4, OVERLAY.segment);
    }
  }

  const sel = ed.selection;
  if (sel?.kind === 'roundabout' && w.net.roundabouts.has(sel.id)) {
    const r = w.net.roundabouts.get(sel.id)!;
    ob.ring(r.centre, outerRadius(r) + 1.5, OVERLAY.select, 0.5);
    ob.ring(r.centre, Math.max(1, r.radius - 1), OVERLAY.select, 0.5);
  } else if (sel?.kind === 'segment' && w.net.segments.has(sel.id)) {
    const seg = w.net.segment(sel.id);
    const { forward: f, backward: b, laneWidth: lw } = seg.profile;
    const [s0, s1] = w.net.trimmedRange(seg);
    if (f > 0) ob.arrows(seg.curve, FORWARD, (f * lw) / 2, 9, s0, s1);
    if (b > 0) ob.arrows(seg.curve, BACKWARD, -(b * lw) / 2, 9, s0, s1, true);
    const ext = Math.max(f, b) * lw + seg.profile.sidewalk;
    ob.curve(seg.curve, OVERLAY.select, 0.5, s0, s1, ext);
    ob.curve(seg.curve, OVERLAY.select, 0.5, s0, s1, -ext);
  } else if (sel?.kind === 'node' && w.net.nodes.has(sel.id)) {
    const node = w.net.node(sel.id);
    ob.ring(node.pos, w.net.junctionRadius(sel.id) + 1, OVERLAY.select, 0.5);
    const major = w.sim.junctions.control.get(sel.id) === 'priority' ? w.sim.junctions.major.get(sel.id) : undefined;
    w.net.arms(sel.id).forEach((a, i) => {
      const c = APPROACH[i % APPROACH.length]!;
      const l: Vec3 = [a.end[0] - a.right[0] * a.leftExt, 0, a.end[2] - a.right[2] * a.leftExt];
      const r: Vec3 = [a.end[0] + a.right[0] * a.rightExt, 0, a.end[2] + a.right[2] * a.rightExt];
      ob.strip(l, r, 1.4, c);
      if (major?.has(a.segment.id)) {
        ob.strip(a.end, [a.end[0] + a.dir[0] * 14, 0, a.end[2] + a.dir[2] * 14], 0.7, OVERLAY.major);
      }
    });
  }
}
