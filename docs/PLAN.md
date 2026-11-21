# Traffic Lab: browser traffic-management game, implementation plan

## Context
You want a mobile-first browser game where players build and redesign road infrastructure, from simple intersections up to overpasses, bridges and tunnels, and the traffic simulation reacts realistically. The long-term hook is redesigning real intersections using their real traffic data. Constraints: TypeScript, our own engine, raw WebGL 2 (no Three.js or Babylon), a small bundle and tight control over memory.

Decisions made so far:
- **Full 3D perspective** camera (orbit, pan and pinch-zoom on touch).
- **Synthetic levels first**; real OSM and traffic-count data comes in a later milestone.
- **Minimalistic, cosy look with surrounding city.** The scene shows a city patch about 2× the size of the buildable area, with buildings, trees and parks. The construction zone is fully lit and in full color. The surrounding city sits outside it and is clearly different: desaturated and darkened, fading toward zero brightness at the scene edge.
- The project directory is empty and **Node.js isn't installed**, and there's no Homebrew. Step 0 below covers setup.

## Guiding architecture
```
src/
  core/      math (vec3/mat4/quat, Bezier), fixed-timestep loop, events, pools
  gl/        thin WebGL2 layer: context and loss handling, shader/program, buffers, VAO, textures, instancing
  render/    camera, scene passes (terrain, roads, environment, vehicles, signals, overlays), mesh generators
  env/       procedural city context: lots, low-poly buildings, trees, parks, props; zone masking
  input/     pointer events → gestures (tap, drag, pinch, two-finger rotate), raycast picking
  network/   road model: nodes, segments (3D Bezier + elevation), lanes, junctions, lane connectors
  sim/       pure TS, DOM-free, deterministic: vehicles, car-following, lane change, junction logic, signals, routing, demand
  editor/    build tools, snapping, validation, undo/redo (command pattern)
  game/      levels (JSON), objectives, metrics and scoring, budget
  ui/        lightweight HTML/CSS overlay (no framework), HUD and menus
tools/       offline scripts (later: OSM → level JSON)
tests/       Vitest unit/headless sim tests
```
Key principles:
- **Simulation is separate from rendering.** `sim/` never touches WebGL or the DOM, so it can be unit-tested headless and later moved into a Web Worker.
- **Data-oriented vehicles.** State is kept as structure-of-arrays typed arrays (`Float32Array` for position, speed and accel; `Int32Array` for lane and route index), allocated once with a fixed capacity, so the simulation loop creates no garbage.
- **Fixed sim timestep** (e.g. 10 Hz, with a speed multiplier), and rendering interpolates between steps at display rate.
- **Simulation models are established traffic-engineering methods:**
  - IDM (Intelligent Driver Model) for car-following
  - MOBIL for lane changes
  - gap acceptance and right-of-way at junctions, using conflict zones precomputed from the lane-connector geometry
  - signal controllers with phases
  - routing by Dijkstra/A* over the lane graph, driven by an origin-destination demand matrix with time-of-day profiles
- **Mobile render budget:**
  - instanced vehicles (one draw call per vehicle type)
  - static road meshes merged per chunk, with a target under 100 draw calls
  - device-pixel-ratio capped around 2
  - one directional light, no real-time shadow maps at first (cheap blob shadows instead)
  - pause when the tab is hidden, and handle `webglcontextlost`
- **Zero runtime dependencies.** Dev-only tools are Vite, TypeScript and Vitest.

## Milestones (each ends with something runnable)

### 0. Environment setup
- I'll install Node without admin rights using **nvm**: run its official install script, then `nvm install --lts`. The alternative is the macOS installer from nodejs.org, which you run yourself.
- `git init`, then scaffold Vite + TS (strict) + Vitest, `.gitignore` and npm scripts (`dev`, `build`, `test`).
- Vite's dev server runs with `--host`, so you can open the game on your phone over the same Wi-Fi.
- **Verify:** `npm run dev` shows a blank WebGL canvas cleared to a color on the laptop and the phone.

### 1. Engine core
- Write the math library, the GL wrapper (shader compile with readable errors), the render loop with fixed-step simulation and interpolation, and a perspective camera with touch and mouse orbit, pan and pinch.
- **Verify:** a ground plane with grid and a few test cubes, navigable smoothly on the phone; FPS overlay shown.

### 2. Road network and road meshes
- **Data model:** nodes, segments as cubic Bezier curves in 3D, lane profiles (count, width, direction) and junction nodes.
- **Mesh generator:** extrude a road ribbon along the curve, add lane markings (shader-driven, no textures needed), and build junction surface polygons.
- **Verify:** a hardcoded straight road and a curved road plus a 4-way junction render correctly; unit tests for curve arc-length and offsets.

### 2b. Environment and visual style
- **Art direction:** a minimal low-poly look with a soft pastel palette defined in one place.
  - **Lighting:** warm directional "late afternoon" light, hemisphere ambient for soft fill, and light distance fog.
  - **Contact shadows:** fake ambient occlusion via vertex colors and blob shadows under buildings and trees. No real-time shadow maps, to protect phone performance.
- **Procedural city context (`env/`), from a seed:**
  1. Split the area between roads into city blocks and blocks into lots.
  2. Fill each lot with an instanced building or a park.
  3. **Buildings** come from a few parametric kits: box houses with pitched or flat roofs, mid-rise blocks and shops, varied by size, color and window bands drawn in the shader.
  4. **Trees** are instanced low-poly crowns of 2–3 types, placed along streets and in parks.
  5. **Small props**, such as street lamps and benches, are added later if the budget allows.
- **Zone treatment:**
  - **Construction area:** a rounded rectangle, rendered in full color with a subtle animated border line.
  - **Context ring:** about 2× the construction area's size. Every shader computes a zone factor from the world position. Outside the zone it desaturates and darkens the color and fades it toward zero at the outer edge (vignette into a dark background), so the context reads clearly as "not yours to edit".
  - **Context traffic:** cars on context roads use the same treatment.
- **Gameplay hooks:**
  - Buildings inside the construction area occupy lots.
  - Building a road through one shows a demolition cost and removes it with a small sink animation.
  - Roads entering from the context are the demand entry and exit points.
- **Budget:** buildings and trees take 1 draw call per mesh kit (instanced), so the whole environment fits within about 10 draw calls.
- **Verify:**
  - The test scene shows a cosy, readable city patch on the phone, with the build zone clearly distinct.
  - The same seed always produces the same city.
  - FPS stays stable while orbiting.

### 3. Traffic simulation v1
- Build the lane graph from the network; spawners and sinks; IDM movement along lanes; render vehicles as instanced boxes or low-poly cars.
- **Verify:** headless tests (a vehicle accelerates to the speed limit, keeps a safe gap, no overlaps); visually, cars flow on the test road.

### 4. Intersections and control
- **Lane connectors** through junctions, with conflict zones computed between them.
- **Right-of-way control:** priority/yield and all-way-stop rules, gap acceptance.
- **Traffic signals:** phases, cycle and green splits.
- **Lane changing:** MOBIL, plus route-driven lane selection ahead of turns.
- **Verify:** scenario tests (no collisions at a signalized cross, no deadlock under load); a visual 4-way signalized junction.

### 5. Editor (touch-first)
- **Tools:** draw road, curve, delete and lane-count change; snapping to nodes and angles.
- **Configuration:** signal and priority setup; turn-lane assignment.
- **Editing support:** undo/redo; live rebuild of the affected lane graph without restarting the simulation.
- **Verify:** on the phone, build a T-junction from scratch and watch traffic use it.

### 6. Elevation: overpasses, bridges, tunnels
- **Elevation:** per-node height, ramps with maximum grade validation, and clearance checks between crossing segments.
- **Bridges:** deck plus pillars.
- **Tunnels:** portals and terrain cut, plus an "underground view" toggle (ghost terrain) so tunnels stay editable.
- **Demo interchanges:** a simple diamond interchange and a cloverleaf.
- **Verify:** build a two-level crossing; vehicles on each level don't conflict; clearance errors appear when layers are too close.

### 7. Game layer
- **Level format:** JSON containing the initial network, buildable area, context city seed and overrides, budget, OD demand matrix and time-of-day profile, and objectives.
- **Metrics:** average delay, throughput, max queue length, stops per vehicle, and a level-of-service grade.
- **Scoring:** compare against the baseline layout.
- **UI:** HUD, level select, results screen, sim speed control (1x/4x/16x); 3–5 synthetic levels with increasing difficulty.
- **Verify:** complete a level end-to-end; scoring is deterministic for the same seed.

### 8. Performance and robustness
- **Web Worker simulation:** move the simulation to a Web Worker, passing state back and forth as transferable buffers (no SharedArrayBuffer, so no special server headers are needed).
- **Rendering:** profile on a mid-range phone; add distance LOD for vehicles.
- **Persistence and offline:** saves stored in IndexedDB; PWA manifest and offline cache.
- **Verify:** stable 60 fps with about 2,000 vehicles on a mid-range phone; bundle size check (target under 200 KB gzipped, excluding level data).

### 9. Real-world data
- **OSM import:** an offline `tools/` script converts an OSM extract into a level JSON: lanes, turn restrictions, signals, and building footprints, heights and trees, so the surrounding city resembles the real place.
- **Traffic data:** import public traffic-count datasets as the OD/turning-movement demand; calibrate simulation parameters against observed queues and flow.
- **Attribution:** in-game credits for OSM and other data sources.
- **Verify:** one real intersection level whose baseline behaviour roughly matches the published counts.

## Workflow
We go milestone by milestone. At the end of each, tests and the build run, the result is checked on a phone, and the work is committed.

## Progress
_Last updated: 2026-11-21_

### Done
- [x] **0. Environment setup:** Node via nvm, Vite + TS (strict) + Vitest, git. Verified on laptop and phone.
- [x] **1. Engine core:** math, GL wrapper, fixed-step loop, orbit camera, touch/mouse controls, FPS HUD. Verified on phone: 60–68 fps. The two-finger rotate inversion is fixed.
- [x] **2. Road network and road meshes:** Bezier segments, lane profiles, junctions (3+ arms, and 2-arm bends), shader lane markings, kerbs, sidewalks, rounded corners. Verified on phone.
- [x] **2b. Environment and visual style:**
  - **City generation:** seeded generator in `src/env/city.ts`. Lots line both sides of every street (houses with gable roofs, shops, mid-rises, parks); street trees and yard trees fill the rest.
  - **Look:** shader-drawn windows (a few warmly lit), soft blob shadows, palette in `src/env/style.ts`.
  - **Construction zone:** `src/env/zone.ts` and the `COMMON` shader chunk. Full colour inside with the build grid and a pulsing border line; outside, a desaturated, darker context ring fading to the background.
  - **Status:** verified on phone.
- [x] **3. Traffic simulation v1:**
  - **Lane graph:** `src/sim/laneGraph.ts` holds road lanes plus curved connectors through junctions. Lane-use rules: the inner lane turns left, the kerb lane turns right, all lanes may go straight.
  - **Routing:** fastest lane-level route by free-flow time, `src/sim/router.ts`.
  - **Driving:** IDM car-following with anticipation of slower lanes ahead, such as tight turns (`src/sim/idm.ts`).
  - **Simulation:** typed-array vehicle state at a fixed 10 Hz (`src/sim/traffic.ts`). Spawners and sinks sit at roads leaving the scene.
  - **Rendering:** instanced low-poly cars and vans, interpolated between simulation steps.
  - **Probe:** over 10 simulated minutes, a step took about 0.03 ms, with no gridlock.
  - **Status:** verified on phone.
- [x] **4. Intersections and control:**
  - **Conflict zones:** `src/sim/junctions.ts` precomputes them per connector pair, crossing or merging, plus split distances for connectors leaving the same lane.
  - **Junction control** per node (`RoadNode.control`):
    - **Signal:** fixed-time phases per opposite-approach pair (green, 3 s yellow, 2 s all-red), with permitted left turns waiting in the box, one per movement, and phase clearance.
    - **Priority:** main road vs side road (a give-way line on side roads).
    - **All-way stop:** stop, then first-arrived goes first.
  - **Right of way:** side road gives way to main road; turning traffic gives way to straight traffic; then give way to traffic from the right. Gap acceptance uses a 2 s critical margin.
  - **Inside the junction** (`src/sim/traffic.ts`): first-in-first-out order, which rules out circular waits. Vehicles entering give way to those already inside; nobody enters onto a full exit; a latched breaker handles rare cases where vehicles are still mutually stuck after 6 s.
  - **Routing:** per-destination cost-to-go tables (`src/sim/router.ts`), so vehicles can change lanes freely.
  - **Lane changes:** MOBIL with a strategic bias towards lanes that lead to the destination. A changer keeps blocking its old lane until it has moved across, and the sideways slide is smoothed visually.
  - **Visuals:** traffic lights whose lamps change colour, stop signs, stop and give-way lines. Vehicles are now rendered centred, with heading taken from a trailing rear point.
  - **Stress check:** 4 junction types × 5 seeds, plus the city at 1× and 1.5× demand. At nominal demand there were no deadlocks and essentially no overlaps (one sample in one T-junction seed).
  - **Status:** awaiting phone check.
- [x] **5. Editor (touch-first):**
  - **Tools** (toolbar at the bottom; two fingers always move the camera):
    - **Road:** drag from one point to another. Ends snap to junctions and road ends, onto the middle of a road (which makes a T-junction), or to free points on 15° steps and whole metres. Crossing a road creates a junction. Presets: Street 1+1, Avenue 2+2, One-way 2, Boulevard 3+3.
    - **Bend:** drag the handle in the middle of a road.
    - **Edit:** tap a road for lanes per direction, speed limit and swapping directions. Tap a junction for its control (priority, all-way stop or signals), main road, green time per phase, and turn lanes per approach lane (auto, ←, ↑, →, or combinations).
    - **Remove:** tap a road.
    - **Undo/redo:** snapshot history (network, demolished items, money spent), 100 steps; Ctrl/Cmd+Z on desktop.
  - **Preview while dragging:**
    - The real road mesh is rebuilt live, so junctions form under the finger.
    - A green or red centreline shows the new road, with the reason when it's invalid.
    - The preview shows cost, and red outlines mark buildings and trees that would be demolished.
  - **Validation** (`src/editor/validate.ts`): stay inside the construction zone, minimum road length between junctions, minimum angle between roads (25°), at most 6 roads per junction, minimum curve radius, no overlap with roads it doesn't connect to.
  - **Construction zone:** roads crossing its border are split there at startup (`splitAtZone`). Inside is editable; outside is fixed context. Spawners stay at the original scene exits.
  - **Live rebuild:** an edit rebuilds the lane graph and junction model, and `TrafficSim.adopt` carries the running vehicles over by matching lanes. Only vehicles whose road disappeared are removed; nothing restarts. A commit takes about 10–20 ms.
  - **Demolition:** buildings, parks and trees under new roads or new junction areas sink into the ground. Prices are placeholders (k€) until Milestone 7; the HUD shows money spent.
  - **Network changes:**
    - Lane-count changes at a straight 2-road node now make a small junction: a tapered surface (fixes the old seam), and merge conflicts where the outer lane gives way.
    - Opposite junction arms get a straight kerb, so the flat side of a T no longer bulges.
    - Turn arrows are painted on all approach lanes of real junctions.
  - **Code:**
    - `src/editor/` (rules, pick, snap, ops, validate, cost, editor) is DOM-free and tested in `tests/editor.test.ts`.
    - `src/game/world.ts` holds the live state.
    - `src/ui/` holds the HTML toolbar, panels and overlay content. `src/render/overlay.ts` adds 1 draw call.
  - **Checks:** a headless browser run showed drawing, junction panel, signals, turn lanes, bend, remove and undo working. Traffic after a crossing street, a lane drop and a road removal kept flowing, with no new overlaps.
  - **Status:** awaiting phone check.
  - **Follow-ups (2026-11-20):**
    - **Junction spacing:** junctions can be built much closer (see Junction sizing).
    - **Lane changes:** the sideways offset follows an S-curve over distance travelled (12–45 m, longer at speed), and the heading comes from front and rear points on that curve. Cars steer through a change at any speed instead of sliding sideways.
    - **Lane-change safety:** a change must fit before the end of the lane. A changer keeps clear of traffic ahead in its old lane until its rear is across. Cars still leaving a lane count as occupying it, so two cars can't swap lanes through each other.

  - **Left turns, blinkers and light glow (2026-11-20):**
    - **Waiting in the junction:** left-turners no longer wait at the stop line for oncoming traffic. They pull into the junction and wait part-way through the turn, just short of the oncoming lanes (`Conflict.oncoming`). Only one car per lane waits inside; the rest wait at the line. Crossing traffic from side roads is still checked at the line.
    - **Impatience:** a driver who has waited a while accepts a smaller gap (margin 2 s → 1 s over 35 s).
    - **Blinkers:** amber lamps at the front and rear corners blink, with a per-car phase, when turning within 45 m, through a turn, and during lane changes (`src/render/lights.ts`).
    - **Glow:** soft premultiplied glow sprites with a minimum on-screen size, so signals stay readable when zoomed out and blinkers show at mid zoom. This adds 2 draw calls (lights, glows).
  - **Van model (2026-11-20):** vans (`TrafficSim.van`, about 10% of vehicles) have their own low-poly model: a tall cargo box behind a raked windscreen with a short bonnet, glazed only at the cab (shader kind 4). This adds 1 draw call.
  - **Turn arrows fix (2026-11-20):** arrows follow the lane's path (they used to run straight back from the stop line and drift off curved approaches). Short approaches between close junctions get the arrow nearer the stop line (it used to be skipped below 14 m; now only below 5.5 m). Flat road paint no longer gets the near-ground darkening, so arrows and stop lines stay crisp when zoomed out.
  - **No arrow = any direction (2026-11-20):** lanes that may take every turn their arm offers (`LaneGraph.armTurns`) get no arrow, e.g. single-lane streets. Arrows appear only on lanes limited to some directions, by default or by the turn-lane editor.
  - **Roundabouts (2026-11-20):** any junction of 3+ roads can become a roundabout in the junction panel (`src/editor/roundabout.ts`).
    - **Model:** a `Roundabout` record (centre, island radius, 1–3 lanes) owns a ring of one-way arc roads (`RoadSegment.ring`) along the island edge, lanes outside it, anticlockwise from above (right-hand traffic). Each road is cut where it reaches the island and joins the ring at a ring node; long gaps get plain joints (arcs ≤ 100°).
    - **Lanes (`LaneGraph.connectRing`):** ring lanes continue lane for lane; exits leave from the outer ring lanes (kerb-aligned), so drivers on inner lanes move out first or go round again; entering lanes are spread over all ring lanes (kerb lane → outer). Any lane counts and one-way roads work.
    - **Right of way:** the ring is always the main road at ring nodes (`JunctionModel.majorRoad`), so entering traffic gives way. Circulating traffic is exempt from the "don't block the junction" rule (a full ring would lock otherwise); entering traffic looks ahead along short ring pieces for room for a whole car (`exitBlocked` look-ahead, which applies to all junctions).
    - **Size:** the island grows from a default (8 m + 3 m per extra lane) until every ring piece between entries keeps 5 m outside the junction areas. The panel changes lanes and size (rebuild in place) or turns it back into a priority, all-way or signal junction at the centre.
    - **Editing around it:** new roads can join the ring anywhere (the ring is rebuilt evenly around entries after every edit, `tidyRoundabouts`); roads can't cross the island; Bend refuses ring roads; Remove on the ring removes the whole ring.
    - **Merge zones** now start where paths come within 3.0 m (was 2.3 m): at long, shallow merges (a wide entry onto the ring) cars touched before the zone began.
    - **Verified:** 4 layouts × 5 seeds × 15 min with 0 overlaps (checked every other step); city, priority and signal stress runs unchanged (priority worst wait improved 345 s → 180 s). Adds no draw calls.
  - **Non-stop lanes (2026-11-20):** a per-junction option (`RoadNode.freeFlow`, junction panel "Non-stop lanes"), e.g. the far side of a T whose side road only turns right, or both main-road lanes where a one-way road branches off and the far lane may not turn into it.
    - **Which lanes:** an incoming lane qualifies when none of its movements has a conflict zone (crossing or merge) with another approach (`JunctionModel.nonStop`, computed whatever the option says); splits from the same lane don't count. The player frees lanes by limiting turns with the existing turn-lane buttons; the panel lists how many lanes qualify.
    - **Behaviour:** with the option on, those lanes and their connectors (`JunctionModel.free`) skip signals, stop signs and give-way rules, and may enter even when there is no room after the junction: a queue standing on a free path blocks only its own lane. Signals drop them from the phases (an arm whose lanes are all free leaves the cycle).
    - **Markings:** no stop or give-way line, and no pole when a whole arm is free; the lane's lines continue through the junction along its straight path (a full double centre line, since nothing crosses a non-stop lane, drawn once when both directions are non-stop; a solid line next to lanes that stop; dashed divider between free lanes, edge line unless the lane turns off on that side).
    - **Verified:** T-junctions with signals and all-way stop: the free lane is never held, with 0 overlaps over 10 min; the other lanes' waiting is unchanged within run-to-run noise (8 seeds).
  - **No road starts too close to a junction (2026-11-20):** with the Road tool, hovering over a road where no new road could join shows a red cross (and a not-allowed mouse pointer) instead of the yellow snap ring, and a drag starting there builds nothing and says "Too close to a junction". `anchorProblem` tries a junction there with a perpendicular road of the chosen type (the angle needing the least room); if a piece of the old road would still be shorter than `MIN_ROAD`, the point is blocked, so the band is wider for wider roads. Junctions already holding the maximum number of roads are blocked too; roundabout rings are left to the usual check (they are rebuilt around new entries).
  - **Road tool: draw by tapping (2026-11-20):** the Road panel's "Draw by" switch picks dragging (as before) or tapping the start and then the end (`Editor.roadMode`). In tap mode one-finger drags move the view between taps; with a mouse the road previews from the start to the pointer. A start is refused where no road can begin (same check as the red cross); an end that fails keeps the start and shows why; tapping the start again (or Escape, or switching tool/mode) cancels.
  - **Bolder, narrower arrows; roads start near the zone border (2026-11-20):** arrow strokes 0.18 → 0.26 m, turn branches reach 0.7 m sideways (was 1.0). The "too short" rule (`tooShort` in `validate.ts`) now measures the drivable stretch through plain joints (the cuts at the zone border are not junctions); a piece only has to hold its junction areas. A start or end too close to such a joint for a junction to fit moves onto the joint (`Editor.settle`, up to 20 m), so the red band before the border is gone.
  - **Solid lane arrows (2026-11-20):** arrows are flat painted shapes instead of thin boxes: a straight bar with a broad triangular head, and turn branches curving smoothly off the bar into their own head (`arrowShape` in `junctionProps.ts`). They form one small mesh in the road vertex layout (`MAT_PAINT`), drawn with the road shader and a polygon offset, rebuilt with the junction props (+1 draw call).
  - **Published (2026-11-20):** public repo `yetanotherbamboo/traffic-lab`; GitHub Actions tests, builds and deploys every push to `main` to https://yetanotherbamboo.github.io/traffic-lab/ (relative asset paths, `base: './'`). Test timeout raised to 60 s for slower CI machines.
  - **Saved cities, Reset, "Build" (2026-11-20):** the player's city (network, demolished items, money spent: `World.snapshot()`) is saved in the browser's localStorage after every change (`traffic-lab:city:v1`, removed when the city equals the start) and restored at startup before the warm-up; an unreadable save is dropped. A Reset button (top right, with a confirmation) puts the starting city back as one undoable step (`Editor.resetTo`). Undo history isn't saved. The Road tool button is now labelled "Build".
  - **Home-screen icon (2026-11-20):** `public/icon.svg` (a pastel crossroads with three cars; the junction and cars stay inside the central 80 % circle so Android masks never cut them) rendered to `apple-touch-icon.png` (180), `icon-192.png` and `icon-512.png` with headless Chrome. `manifest.webmanifest` (standalone, dark theme) and Apple web-app meta tags let the game be added to the home screen on iPhone and Android and open full screen. A home-screen copy on iPhone keeps its own saved city, separate from Safari's.
  - **One-junction zone, new city on Reset (2026-11-21):** the game is about redesigning one junction (whole-city editing is a future game mode). The buildable area is 200 m square (`hx = hz = 100`, corner radius 40) around the central crossroads; the ring street moved out to 150 m (curved corner controls at 0.5 R) so the border stays about 50 m from its junctions and arms can still be widened up to the border; context `contextScale` 1.9, roads leaving the scene end at 270 m. Reset now grows a new city from a fresh seed (`World.regenerate`, seed from `crypto.getRandomValues` in `main.ts`, not in the simulation), warms it up and clears undo history (`Editor.startOver`); it can't be undone. Saves carry the seed (`traffic-lab:city:v3`); `World.restore` refuses a snapshot from another seed.
  - **Stricter start check (2026-11-21):** `anchorProblem` used to try only one trial road (perpendicular, to the right) on a road and never checked junctions, so the cursor offered starts from which no road could be built (in a city with T-junctions on every arm of the centre crossroads, the centre itself, for example). It now tries both sides of a road, and at a junction the middle of every gap between its roads (gaps under 2 × `MIN_ANGLE` are skipped; no gap at all → `NO_ROOM`). A start is allowed if any trial leaves every existing road piece long enough; the trial road's own length doesn't count (the player can draw it long enough). Test: every offered start along the four arms can be built from (fails on the old check).
  - **Small road types (2026-11-21):** Build presets "Lane" (1+0, 3.0 m lane, 1.5 m sidewalk, 30 km/h) and "Alley" (1+1, 2.75 m lanes, 1 m sidewalk, 30 km/h). Next: smaller junctions for small roads and entrances (plan: tiny roads B/C/D).
  - **Compact junctions for small roads (2026-11-21):** `isSmall(profile)` (≤ 1 lane each way, lane ≤ 3 m, sidewalk ≤ 1.5 m). In `armTrim`, a corner next to a small road gets 1.5 m kerb room (3 m otherwise), and a junction with a small road has a 3 m minimum trim (5 m otherwise). Junctions without small roads are unchanged. Tests: side lanes and alleys fit at ≤ 75 % of a street's spacing; compact T and alley crossroads face upwards; alley all-way 4-way and a lane joining a street run 15 minutes without collisions.
  - **Entrances (2026-11-21):** `RoadNode.entrance` (saved; takes effect only while `entranceLayout` holds: three roads, two continuing straight with the same lanes, the third with ≤ 1 lane each way). Trims (`entranceTrim`): the through road stops past the side road's carriageway on its side + sidewalk + 1 m; the side road starts at the through road's kerb + 0.5 m. `tooShort` needs only 2 m (`MIN_ROAD_ENTRANCE`) on a stretch ending at an entrance. Always priority with the through road as main road (`junctions.ts`). `addRoad` turns a new T into an entrance when a full junction would leave a road too short and the entrance fits (`preferEntrance`); `anchorProblem` tries an entrance too. `setLanes` at an entrance that would no longer fit: "Not enough room for more lanes here". Junction panel: Type Junction/Entrance (`setEntrance`, refused when a full junction doesn't fit). Closest side road to the centre crossroads: lane 14 m on the avenue / 20 m on the street (was 18 / 25), street 18 / 22 (was 24 / 28). Known limit: the red cross checks both directions, so a one-way lane may fit leaving one way but not the other (its lane lies on one side).
  - **Fix: small roads overlapping at angles (2026-11-21):** entrance trims ignored the angle, so a diagonal lane or alley left its sidewalks over the through road (user screenshot). `entranceTrim` now uses the angle: the side road starts where both its edges clear the through road ((M + e·cos)/sin), and each through-road arm stops past the side road's edge plus M·|cot| on both corners. Entrances need ≥ 70° (`ENTRANCE_MIN_SIN`); sharper joins are full junctions. Mesh: corner sidewalks drop near-duplicate kerb points (a 2 cm backwards strip flipped the sidewalk where a one-way lane's kerb lies on its centreline, also at compact junctions) and are narrowed to 0.9 × the fillet radius. Tests: overlap clearance for entrances at 70–110°, upward-facing meshes for lanes at 30–150° on an avenue (both fail on the old code).
  - **Curve physics (2026-11-21)** (first step of the road-tool redesign; plan: study of Cities: Skylines road building, then curve-aware roads before curves get easy to draw):
    - **Cornering speed:** each road lane has a cornering-speed profile (`Lane.safe`: `sqrt(MAX_LAT_ACCEL · radius)` per path point, at most the limit; `pathRadii` from the turn between neighbouring path pieces) and its slow stretches (`Lane.bends`). Inside a bend the desired speed is the cornering speed. Before a bend (on the lane or the next one), drivers brake once reaching the bend's speed needs `CURVE_BRAKE` (1.3 m/s²), just hard enough (`TrafficSim.bendAccel`), because IDM alone only eases off and cars entered bends 20% too fast. Roundabout rings now run at cornering speed (about 25 km/h) instead of the full limit.
    - **Connectors keep the average-radius speed:** trying the tightest radius made turns slower than real (a turn's Bézier is tighter in the middle than a circular arc), drivers then rejected gaps, and the test city's longest wait doubled (111 → 226 s).
    - **Curved arms at junctions:** `armTrim` also follows the real curved edges (`RoadNetwork.edgeHit`, only when an arm is curved; never less room than the straight-line estimate), so a road bending back towards its neighbour no longer overlaps it. Straight junctions are unchanged.
    - **Sampling:** lanes and road meshes take at least one sample per 6° of turning as well as every 2 m (`CubicBezier.pieces`).
    - **Corner sidewalks:** stations on a kerb fillet use the circle's exact tangent (the sidewalk lies on the inside of the fillet, so averaged directions folded it where a few cm of straight kerb meets the arc; this showed up once the curved ring corners got slightly uneven trims).
    - **Tests:** cornering profile; cars slow before 25 m and 40 m bends and stay within cornering speed (+8%); gentle bends don't slow cars; curved arm clearance (fails without the fix); straight junction trims unchanged. Mesh and lane-graph build about 0.2 ms slower on the test city.
  - **Road tool redesign (2026-11-21)** (Cities: Skylines style, adapted to touch):
    - **Pending road:** a drag from start to end, or a tap on each, shows the road (real mesh, cost, demolition) without building it. Its circles (grips) can be dragged; ✓ Build in the info line builds it (greyed out with the reason in red when it can't be), ✕ / Escape drops it (`Editor.discard`), Enter builds. One-finger drags away from the grips move the view; with nothing placed yet a drag draws. Replaces the drag/tap "Draw by" switch.
    - **Chaining:** after ✓ the end node starts the next road; tapping that start again or ✕ stops.
    - **Shapes** (`src/editor/shape.ts`, Road panel "Shape"): Straight; Curve (a middle grip bows the road through that point, the Bend tool's quadratic); Continuous (circular arc leaving along the road it continues: a chained road's end direction, or the only road at a dead end; up to 75° off that direction, else "Too sharp a turn…"; elsewhere straight with a hint). Switching shape or road type reshapes a pending road.
    - `addRoad` takes optional control points. Draft gained `length` (curve length shown in the info) and `grips` (drawn as dots inside the rings).
    - **Checks:** editor tests for ✓/✕, tap-tap, grips, chaining, Curve, Continuous (tangent at the joint, no junction there) and the shape maths (arc within 0.3% of a circle). Headless Chrome at phone size (390×844) drove real mouse gestures: drag → pending → ✓ → chained tap → ✓ → ✕ → Curve with the middle grip dragged 8 m (built road's midpoint exactly there), no console errors. It also found ✕ leaving a stale hint (fixed: `discard` clears messages).
  - **Overlay through buildings (2026-11-21):** the editor overlay is drawn a second time after the lit meshes with `depthFunc(GREATER)`, no depth writes and 50% constant alpha (`OVERLAY_GHOST` in `renderer.ts`), so grips, previews, selections and demolition outlines show as a ghost where buildings, trees or vehicles hide them. +1 draw call while the overlay has anything in it. Checked in headless Chrome: a curve's middle grip behind a building now shows.

### Next
- [ ] **Road tool, part 2:**
  - guidance: length and angle labels above the finger, guide lines from nearby roads, a snapping toggle, the advisory speed of tight bends ("cars slow to 25 km/h").
  - Continuous: match the curvature where the new arc meets the previous road (only the direction matches now, so cars may still dip in speed at the join).
  - Later: an Upgrade tool (change a road's type in place), node dragging, drag-to-remove, parallel roads.
- [ ] **6. Elevation: overpasses, bridges, tunnels.**

### Known issues / tech debt
- **Junction sizing:** each road end is trimmed separately (`RoadNetwork.armTrim`), only as far as its neighbours' sidewalk edges require plus 3 m for a rounded kerb (minimum 5 m; straight lane-count tapers keep the long taper). A street crossing an avenue pulls the avenue back only about 9 m, so junctions can be about 24 m apart. Corners are circular fillets. Curved arms follow their real edges (`edgeHit`), but only against their two neighbours.
- **Dead ends:** roads have no end caps. Vehicles that end up on a player-made dead end (only via a forced fallback move) are removed there; there are no U-turns.
- **Junction markings:** there are no stop lines or crosswalks yet.
- **Lot placement:** lots are placed by sampling along streets, not by extracting real city blocks. Odd-shaped block interiors are filled only with trees.
- **Demolished lots stay empty:** removing a road doesn't regrow buildings.
- **No node dragging:** junctions can't be moved yet; delete and redraw instead. Leftover straight 2-road nodes (after deleting a crossing road) aren't merged back.
- **Widening roads demolishes frontage:** adding lanes pushes sidewalks into lots, which are demolished (and paid for) immediately. The lanes panel has no cost preview.
- **Lane-mapping on edits:** vehicles inside a junction whose connector no longer exists are removed rather than re-routed.
- **Preview cost on phones:** each drag move clones the network, validates and rebuilds the road mesh, about 3 ms on a laptop. Watch for lag on the phone.
- **Side roads at busy priority junctions:** a left-turner waiting in the middle physically blocks side-road traffic crossing its path (which gives way to it). With heavy main-road traffic, side-road cars can wait 3–5 minutes; the worst case in tests was 345 s, versus 214 s before. That's realistic, and a cue for the player to add signals, but the game layer should surface it (Milestone 7 metrics).
- **Junction gap acceptance (fixed 2026-11-20):** a left-turner used to cut in front of oncoming traffic, for three reasons:
  - It estimated its own arrival as if it had already slowed to turning speed.
  - At higher approach speeds it committed before it started looking for gaps.
  - Conflict zones were too short next to curved paths.
  - **Fixes:** the earliest arrival is used for "they're through before I arrive"; gaps are checked from before the commit point; zones are measured where the paths are closer than 2.8 m; and of two cars inside one zone, the one less far across stops.
  - **Result:** 0 overlaps (checked every other step) in the city, 16 priority-junction seeds, signals and close-together junctions. The price: about 2% less city throughput and about 15% less on close-together junctions, because drivers are more careful. Commits take about 30 ms on a laptop.
- **Roundabout size:** entries need room between them (each road's junction area plus 5 m of ring), so roundabouts on wide roads are large (2 avenues + 2 streets: about 44 m across) and roads meeting at small angles need a big ring. Ring lanes have no lane arrows or spiral markings; the island is plain grass.
- **Deadlock breaker:** when it fires, a stuck vehicle creeps through, which can cause a brief visual overlap. This is rare at nominal demand and more frequent when the network is oversaturated (1.5× demand: a few samples per 20 minutes).
- **Signal timings:** green time defaults to 10 s + 8 s per lane and can be changed per phase in the editor. No actuation or protected left phases yet.
- **Free-flow routing:** routes use free-flow time only, so vehicles don't avoid congestion. Dynamic rerouting is a candidate for Milestone 7/8.
- **Spawn queues:** a blocked entry lane delays spawns (pending capped at 20); this isn't measured yet.
- **City generation speed:** it runs on the main thread at startup (time shown in the HUD). Move it to a worker if it grows.
- **Junction mesh sliver:** at some junction shapes (e.g. the test ring at R = 150 with corner controls at 0.55 R) the sidewalk corner leaves a 2 cm flipped triangle; invisible, but `road surfaces face upwards` catches it. The starting city avoids it.
- **Unconfirmed control:** the mouse right-drag rotate direction hasn't been checked by the user.
