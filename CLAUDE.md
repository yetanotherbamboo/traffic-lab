# Traffic Lab

A mobile-first browser game about building and redesigning road infrastructure, with a realistic traffic simulation. It uses its own engine written in TypeScript on raw WebGL 2.

- Plan, progress and known issues are in `docs/PLAN.md`. Update its **Progress** section at the end of every milestone.

## Commands
Node is installed via nvm, so non-interactive shells need: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"`.
- `npm run dev`: dev server on `0.0.0.0:5173` (phone access over LAN)
- `npm test`: Vitest (headless; `tests/**/*.test.ts`)
- `npm run build`: typecheck + production bundle (reports gzip size)
- **Deploy:** every push to `main` runs the tests, builds and publishes to GitHub Pages (`.github/workflows/deploy.yml`): https://yetanotherbamboo.github.io/traffic-lab/ (repo `yetanotherbamboo/traffic-lab`, public). Commits use the GitHub noreply email set in this repo's git config.
- **Saves:** players' cities are kept in browser storage under `SAVE_KEY` in `src/main.ts`; bump its version when the starting city or the network data format changes incompatibly.

## Hard rules
- **No runtime dependencies.** Don't use Three.js, Babylon, gl-matrix or UI frameworks; write it ourselves. Dev-only tools (Vite, TS, Vitest) are fine.
- **WebGL 2 / GLSL ES 3.00 only.**
  - Shaders are TS template strings in `src/render/shaders.ts`.
  - Vertex attributes use fixed `layout(location = N)` slots that match the `Attrib.loc` values in the TS mesh layouts.
- **Mobile performance is a feature.**
  - Keep draw calls low: use instancing for repeated objects and merged static meshes.
  - Cap device pixel ratio at 2. Avoid real-time shadow maps.
  - Avoid per-frame allocations in hot paths (simulation step, instance uploads).
- **`src/sim/` and `src/network/` must stay DOM-free and WebGL-free.** That keeps them headless-testable and lets the simulation move to a Web Worker later.
- **Determinism:** the simulation runs on a fixed timestep (`SIM_STEP`, 10 Hz) with seeded randomness only. Never use `Math.random()` in the simulation or in procedural generation.

## Conventions
- **World space:** Y-up, metres, right-hand traffic.
  - Lane direction: looking from segment node `a` to `b`, forward lanes are on the right of the centreline (`rightOf(d) = (-d.z, 0, d.x)`).
  - Angles: `atan2(z, x)`.
- **Matrices:** column-major `Float32Array(16)` (`src/core/math.ts`). Vectors are `Vec3` tuples.
- **Triangle winding:** front faces are CCW. Ribbon cross-section columns are ordered left → right in pairs, one pair per strip. The test `road surfaces face upwards` guards winding; add similar checks for new mesh generators.
- **TypeScript:** strict mode with `noUncheckedIndexedAccess`. Use `!` only where the index is known to be valid. Use `import type` for type-only imports (`verbatimModuleSyntax`).
- **Layout:** `core/` (math, loop), `gl/` (thin GL wrappers), `render/` (camera, shaders, mesh generators, renderer), `input/`, `network/` (road model), and later `env/`, `sim/`, `editor/`, `game/`, `ui/`.
- **Visual style:** minimal, low-poly, cosy pastel palette. Lighting is a warm sun plus hemisphere ambient and distance fog into the dark background (`BACKGROUND` in `renderer.ts`).
- **Tests:** add Vitest tests for math, geometry and simulation logic. Visual results are verified by the user on the phone.
- **Commits:** one per milestone (or fix), message prefixed `Milestone N:` when completing one.
- **User:** new to web development. Explain run and verify steps plainly, and don't assume tooling knowledge.
