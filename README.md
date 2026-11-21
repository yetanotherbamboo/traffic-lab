# Traffic Lab

A browser game about building and redesigning roads, with a realistic traffic simulation. It is mobile-first: everything works by touch on a phone, and with a mouse on a computer.

**▶ Play: https://yetanotherbamboo.github.io/traffic-lab/**

Traffic Lab is an early test version. Your city is saved in your browser, so you can come back to it later; **↺ Reset** (top right) starts over in a brand-new city with different buildings.

**Add it to your home screen** to play full screen like an app:

- **iPhone / iPad (Safari):** tap the Share button, then **Add to Home Screen**.
- **Android (Chrome):** tap the **⋮** menu, then **Add to Home screen** (or **Install app**).

On iPhone the home-screen app keeps its own city, separate from the one in Safari.

## How to play

The toolbar at the bottom has the tools:

| Tool | What it does |
|------|--------------|
| **Move** | Drag to move the view; pinch or use two fingers to zoom and turn (mouse: drag, right-drag to turn, wheel to zoom). |
| **Build** | Draw a new road. Pick a road type (street, avenue, one-way, boulevard). Draw by **dragging** from start to end, or switch to **tapping** the start and then the end. Roads that cross make junctions automatically; buildings in the way are demolished (and paid for). A red cross means no road can start there (too close to a junction). |
| **Bend** | Drag the middle of a road to curve it. |
| **Edit** | Tap a road to change its lanes, direction and speed limit. Tap a junction to change how it is controlled and which lanes may turn where. |
| **Remove** | Tap a road to remove it. |
| **Undo / Redo** | Step back and forward through your changes. |

You redesign one junction: you can only build inside the bright construction zone around it, and the darker city around it is context. (Editing a whole city is planned as a separate game mode.)

### Junctions

In the **Edit** panel of a junction you can choose:

- **Priority**: the main road has right of way, side roads give way. You choose which roads form the main road.
- **All-way stop**: everyone stops, first come first served.
- **Signals**: traffic lights with phases; you set each phase's green time.
- **Roundabout**: turns the junction into a roundabout with 1 to 3 lanes and a size you choose. Any road can join the ring anywhere.
- **Turn lanes**: set which way each lane may go. Lanes limited to some directions get painted arrows; no arrow means any direction.
- **Non-stop lanes**: a lane that crosses and merges with no other traffic (for example the far side of a T-junction whose side road only turns right) can skip the lights or stop signs and drive straight through.

### Traffic

Cars and vans drive with realistic following distances, change lanes, use their blinkers, give way, wait for gaps, queue at lights and choose their routes. The numbers at the top left show how traffic is doing: average speed, vehicles waiting and trips completed.

## Running it yourself

You need [Node.js](https://nodejs.org/) (a recent version).

```sh
npm install        # once: installs the development tools
npm run dev        # starts the game at http://localhost:5173 (also reachable from a phone on the same Wi-Fi)
npm test           # runs the automated tests
npm run build      # checks the code and builds the release version into dist/
```

## How it's made

- TypeScript with its **own small engine on raw WebGL 2**: no game engine and no runtime libraries.
- The simulation uses established traffic-engineering models:
  - the Intelligent Driver Model for following other cars;
  - MOBIL-style lane changes;
  - gap acceptance and right of way in conflict zones computed from the lane geometry;
  - fixed-time signal controllers.
- It runs at a fixed 10 steps per second with seeded randomness, so runs are repeatable.
- The simulation code (`src/sim/`, `src/network/`) has no browser dependencies and is tested headless with Vitest.
- Every push to `main` runs the tests, builds the game and publishes it to GitHub Pages ([workflow](.github/workflows/deploy.yml)).

```
src/
  core/      math, fixed-timestep loop, seeded random numbers
  gl/        thin WebGL 2 wrappers (meshes, shader programs)
  render/    camera, shaders, mesh generators, renderer
  env/       procedural city around the construction zone
  input/     touch and mouse gestures
  network/   road model: nodes, curved road segments, lanes, junctions
  sim/       lane graph, vehicles, junction rules, signals, routing
  editor/    build tools, snapping, validation, roundabouts, undo/redo
  game/      the world state and the test city
  ui/        toolbar, panels and editor overlay
tests/       automated tests
docs/        the plan and progress notes (docs/PLAN.md)
```

The plan, progress and known issues are in [docs/PLAN.md](docs/PLAN.md).
