# CasiWorks Pro — Roadmap

Goal: grow CasiWorks Pro from a capable prototype into a complete, professional
CAD platform: exact solid modeling, assemblies, drawings and simulation on the
desktop side, and a programmable, collaborative platform (public API, cloud
storage, versioning) on the platform side.

The work is split into **baby steps**. Each step is small, leaves the app
working, has a test or a check that proves it, and lands as its own commit.
Steps are done in order inside a phase; phases mostly run in order because
later ones build on earlier ones.

Status: `[x]` done · `[~]` in progress · `[ ]` not started

---

## Where we are today (honest baseline)

| Area | State |
|------|-------|
| UI shell | Ribbon, feature tree with rollback, property panel, 3D viewport, dialogs |
| Geometry | **Triangle-mesh kernel** (BSP CSG on polygons). Exact B-Rep classes exist in `kernel/BRep.js` but the live model does not use them |
| Fillet / chamfer | Applied to the whole body, not to selected edges |
| STEP / IGES export | Faceted (triangles), not exact surfaces |
| Sketcher | Lines, rectangles, circles, points; constraint solver exists but has little UI |
| Assemblies | Primitive shapes only (box, cylinder…), not real part documents |
| Drawings / FEA | Work on the mesh; run on the UI thread |
| Persistence | Single JSON file download / upload; no backend |
| API | None (internal store actions only) |
| Engineering | 31 Node tests, no linter, no CI, no type checking |

The single biggest gap to a SOLIDWORKS-class product is the **exact geometric
kernel** (Phase 2). Everything users judge as "real CAD" — clean cylinders,
selectable edges, true fillets, exact STEP — depends on it.

---

## Phase 0 — Engineering foundation

Make every later step safe to take.

- [x] **0.1** Linting: ESLint (flat config) for JS/JSX + React hooks rules; fix all errors; `npm run lint`
- [ ] **0.1b** Clear the remaining `no-unused-vars` warnings (137 at 0.1), then make warnings fail CI
- [x] **0.2** Error boundary: a crash in one panel shows a recoverable message instead of a blank app
- [x] **0.3** CI: GitHub Actions runs lint, tests and build on every push and PR
- [x] **0.4** Type checking → replaced by the full TypeScript migration, track T below
- [ ] **0.5** Split the single test file into per-module test files
- [ ] **0.6** Autosave the current document to IndexedDB; restore on reload

## Track T — Full TypeScript migration

Goal: every `.js` → `.ts` and every `.jsx` → `.tsx` (tests included), strict
mode everywhere, no `any`. Converted bottom-up so each step leaves the app
working. Node runs `.ts` directly (type stripping), so tests need no build step.

- [x] **T.0** Tooling: TypeScript 6, strict `tsconfig.json`, `npm run typecheck` in CI, typescript-eslint; first file converted (`utils/clone.ts`) to prove Vite + Node + lint
- [x] **T.1** Domain types (`types/`: Feature, SketchEntity, MassProperties, …) and `utils/` → `.ts`
- [x] **T.2** Public API → `.ts` (typed API for script and add-in authors)
- [ ] **T.3** Store and rebuild → `.ts`
- [ ] **T.4** Kernel → `.ts` (several steps: math/sketch, geometry, B-Rep/topology, import/export)
- [ ] **T.5** Assembly, simulation, drawings → `.ts`
- [ ] **T.6** Viewport and UI components → `.tsx`
- [ ] **T.7** Tests → `.ts`; set `allowJs: false`; delete the JavaScript lint block

## Phase 1 — Command layer and public API v1

One command path used by the UI, keyboard, macros and external code. This is
the foundation of "API support": the UI becomes just one client of the API.

- [x] **1.1** `src/api/` — public `CasiWorksAPI` object over the store: documents, features, sketches, query; documented with JSDoc; unit tests
- [ ] **1.2** Expose it as `window.casiworks` (and as an ES module) with a version number (`api.version`)
- [ ] **1.3** Command registry: every ribbon button and shortcut runs a named command (`feature.extrudeCut`, `file.save`…) through the registry
- [ ] **1.4** Events: `api.on('rebuild' | 'selectionChanged' | 'featureAdded', …)`
- [ ] **1.5** Macro recorder: record commands to a replayable JS script; run macro from file
- [ ] **1.6** Scripting console panel (run API snippets in-app)
- [ ] **1.7** API reference docs generated from JSDoc, published with the app
- [ ] **1.8** Plugin manifest: load third-party add-ins that register commands and ribbon buttons

## Phase 2 — Exact B-Rep kernel

Replace the mesh kernel with an exact one, behind the same feature engine.

- [ ] **2.1** Spike: evaluate OpenCascade via WebAssembly (opencascade.js / replicad): bundle size, load time, license (LGPL-2.1 — check obligations for commercial distribution)
- [ ] **2.2** Kernel interface (`KernelAdapter`): extrude, revolve, boolean, fillet, tessellate — implemented by the current mesh kernel first
- [ ] **2.3** Run the kernel in a Web Worker; UI stays responsive during rebuilds
- [ ] **2.4** OCCT adapter: extrude + boolean; feature flag to switch kernels
- [ ] **2.5** Face / edge / vertex picking mapped to real topology
- [ ] **2.6** Edge-selective fillet and chamfer
- [ ] **2.7** Exact STEP AP214/AP242 import and export via OCCT
- [ ] **2.8** Persistent topological naming (features keep referring to the right face after upstream edits)
- [ ] **2.9** Make OCCT the default; keep the mesh kernel as fallback

## Phase 3 — Part modeling parity

- [ ] **3.1** Sketch on any planar face, not only the three default planes
- [ ] **3.2** Constraint UI: add/show/delete geometric relations; fully-defined coloring
- [ ] **3.3** Driving dimensions editable in the viewport
- [ ] **3.4** Arcs, splines, slots, polygons, trim / extend / offset (the viewport currently draws only lines and circles; points and arcs are stored but not displayed)
- [ ] **3.5** Reference geometry: planes, axes, points, coordinate systems
- [ ] **3.6** Hole wizard (counterbore, countersink, tapped) with standards tables
- [ ] **3.7** Global variables and equations
- [ ] **3.8** Configurations (design tables)
- [ ] **3.9** Measure tool and section view on exact geometry

## Phase 4 — Assemblies

- [ ] **4.1** Multi-document workspace: parts and assemblies as separate documents
- [ ] **4.2** Insert real part documents as components (with references, not copies)
- [ ] **4.3** Mates picked on real faces/edges; under/over-defined feedback
- [ ] **4.4** Interference detection
- [ ] **4.5** Bill of materials
- [ ] **4.6** Exploded views with steps; motion along mates

## Phase 5 — Drawings

- [ ] **5.1** Views generated from exact geometry (crisp edges, true arcs)
- [ ] **5.2** Associative dimensions that update with the model
- [ ] **5.3** BOM tables and balloons from assemblies
- [ ] **5.4** Sheet formats and title block editor
- [ ] **5.5** PDF and DWG/DXF export

## Phase 6 — Simulation

- [ ] **6.1** Solver in a Web Worker with progress and cancel
- [ ] **6.2** Meshing from exact geometry with local refinement
- [ ] **6.3** Fixtures and loads picked on faces
- [ ] **6.4** Results: deformed shape, probes, report export
- [ ] **6.5** Modal (frequency) analysis

## Phase 7 — Platform (cloud and collaboration)

The "experience platform" layer: data management and a server-side API.

- [ ] **7.1** Backend service (Node), auth (OIDC), user accounts
- [ ] **7.2** Cloud document storage with versions and revisions (PDM basics)
- [ ] **7.3** REST API v1: documents, versions, export jobs; OpenAPI spec; API keys
- [ ] **7.4** Headless kernel on the server: run rebuild / export jobs without a browser
- [ ] **7.5** Webhooks (document saved, revision released)
- [ ] **7.6** Sharing, permissions, comments on models
- [ ] **7.7** Real-time co-viewing; later, co-editing
- [ ] **7.8** Lifecycle: check-in/out, release states, where-used

## Phase 8 — Production readiness

- [ ] **8.1** Performance budgets (load time, rebuild time) tracked in CI
- [ ] **8.2** Accessibility and keyboard-only operation
- [ ] **8.3** Internationalization and unit systems (MMGS, IPS, …)
- [ ] **8.4** Security review, CSP, dependency policy
- [ ] **8.5** Crash reporting and opt-in telemetry
- [ ] **8.6** User documentation and tutorials
- [ ] **8.7** Desktop packaging (installable PWA, optionally Electron/Tauri)
- [ ] **8.8** Licensing, releases, changelog

---

## Working agreement

- One baby step = one commit, with the step id in the message (`[0.1] …`).
- Every step keeps `npm run lint`, `npm test` and `npm run build` green.
- A step that changes behavior adds or updates a test.
- No trademarked names (SOLIDWORKS, 3DEXPERIENCE, FeatureManager, …) in the product.
