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
| Geometry | **Triangle-mesh kernel** (BSP CSG on polygons), verified by measured tests. No exact B-Rep yet (an earlier unused, incorrect B-Rep module was removed) |
| Fillet / chamfer / shell | Not applied: the feature reports a rebuild warning and the model is unchanged (the mesh kernel cannot round, bevel or hollow correctly); stays so — Phase 2 is not planned |
| STEP / IGES export | Standards-compliant faceted solids (every face, shared vertices); not exact surfaces — stays so, Phase 2 is not planned |
| Sketcher | Lines, rectangles, circles, points; constraint solver exists but has little UI |
| Assemblies | Primitive shapes only (box, cylinder…), not real part documents |
| Drawings / FEA | Work on the mesh; run on the UI thread |
| Persistence | Single JSON file download / upload; no backend |
| API | None (internal store actions only) |
| Engineering | 31 Node tests, no linter, no CI, no type checking |

The single biggest gap to a SOLIDWORKS-class product is the **exact geometric
kernel**. Clean cylinders, selectable edges, true fillets and exact STEP depend on it.
On 2026-11-16 it was decided not to build one (see Phase 2): CasiWorks stays on its mesh kernel.

---

## Phase 0 — Engineering foundation

Make every later step safe to take.

- [x] **0.1** Linting: ESLint (flat config) for JS/JSX + React hooks rules; fix all errors; `npm run lint`
- [ ] **0.1b** Clear the remaining `no-unused-vars` warnings (137 at 0.1), then make warnings fail CI
- [x] **0.2** Error boundary: a crash in one panel shows a recoverable message instead of a blank app
- [x] **0.3** CI: GitHub Actions runs lint, tests and build on every push and PR
- [x] **0.4** Type checking → replaced by the full TypeScript migration, track T below
- [ ] **0.5** Split the single test file into per-module test files
- [x] **0.6** Autosave the current document to IndexedDB; restore on reload (one document, about a second after each change and when the tab is hidden; undo history is not kept; two open tabs share the one slot, the last write wins)

## Track T — Full TypeScript migration (complete)

Goal: every `.js` → `.ts` and every `.jsx` → `.tsx` (tests included), strict
mode everywhere, no `any`. Converted bottom-up so each step leaves the app
working. Node runs `.ts` directly (type stripping), so tests need no build step.

- [x] **T.0** Tooling: TypeScript 6, strict `tsconfig.json`, `npm run typecheck` in CI, typescript-eslint; first file converted (`utils/clone.ts`) to prove Vite + Node + lint
- [x] **T.1** Domain types (`types/`: Feature, SketchEntity, MassProperties, …) and `utils/` → `.ts`
- [x] **T.2** Public API → `.ts` (typed API for script and add-in authors)
- [x] **T.3** Store and rebuild → `.ts`
- [ ] **T.4** Kernel → `.ts`
  - [x] **T.4a** Sketch engine and constraint solver
  - [x] **T.4b** Geometry engine (plus profile builder and CSG modules; geometry fixes with tests)
  - [x] **T.4c** B-Rep and topology — removed instead of converted: unused by the app, a duplicate of the mesh CSG, and measured wrong (see commit)
  - [x] **T.4d** Import / export and material library (plus standards-compliant faceted STEP and IGES 5.3)
- [x] **T.5** Assembly, simulation, drawings, features → `.ts`
  - [x] **T.5a** Assembly manager (plus mate fixes)
  - [x] **T.5b** FEA engine (plus a real quadratic Tet10 element)
  - [x] **T.5c** Drawing engine (plus real edge extraction and hidden-line removal, upright views, correct isometric, valid DXF)
  - [x] **T.5d** Feature engine (plus hole depth/entry, pattern vectors, revolve plane fixes)
- [x] **T.6** Viewport and UI components → `.tsx`
  - [x] **T.6a** Viewport (plus Right-plane sketch mirroring, all entity types drawn, sketch over the model, no selection while sketching, working Ortho toggle, edge display without boolean fan lines)
  - [x] **T.6b** Common components and dialogs (plus spin-button hold, material dialog sync, DXF exports the model, IGES in the export dialog)
  - [x] **T.6c** Feature tree, property panel, command manager (plus sketches on any plane, per-type feature parameters, hole/pattern/mirror inputs, tree filter fix)
  - [x] **T.6d** Drawing modal, results viewer, App, entry point (plus Poisson's ratio passed to FEA, whole drawing sheet visible, stress tensor at the peak element)
- [x] **T.7** Tests → `.ts`; set `allowJs: false`; delete the JavaScript lint block

## Phase 1 — Command layer and public API v1 (complete)

One command path used by the UI, keyboard, macros and external code. This is
the foundation of "API support": the UI becomes just one client of the API.

- [x] **1.1** `src/api/` — public `CasiWorksAPI` object over the store: documents, features, sketches, query; documented with JSDoc; unit tests
- [x] **1.2** Expose it as `window.casiworks` (and as an ES module) with a version number (`api.version`); `casiworks:ready` event; `casiworks-pro/api` with `createHeadlessAPI()`
- [x] **1.3** Command registry: every ribbon button and shortcut runs a named command (`feature.extrudeCut`, `file.save`…) through the registry; `api.commands` (API 1.1)
- [x] **1.4** Events: `api.on('rebuild' | 'selectionChanged' | 'featureAdded', …)`; also featureChanged/Removed, documentChanged, commandExecuted (API 1.2)
- [x] **1.5** Macro recorder: record commands to a replayable JS script; run macro from file (JSON macros replay without evaluating code; `.mjs` export; API 1.3)
- [x] **1.6** Scripting console panel (run API snippets in-app): Tools ▸ Console / Ctrl+`, `api` and `run()` in scope, await, last-line value, history, command list and examples
- [x] **1.7** API reference docs generated from JSDoc, published with the app (`/api/`, `npm run docs:api`; undocumented public members fail a test)
- [x] **1.8** Plugin manifest: load third-party add-ins that register commands and ribbon buttons (Add-ins tab and dialog, `api.plugins` in API 1.4, example `public/plugins/washer.js`; persisting installed add-ins across sessions is not done yet)

## Phase 2 — Exact B-Rep kernel (not planned)

**Decision (2026-11-16): CasiWorks keeps its own triangle-mesh kernel; OpenCascade is not adopted.**
The 2.1 spike measured the OpenCascade WebAssembly build used by replicad (1.2.1): 22.9 MB raw,
7.2 MB gzip, 5.0 MB brotli, against 0.48 MB gzip for the whole app today; licence LGPL-2.1
(replicad itself MIT). The rest of the phase is dropped. Fillet, chamfer and shell stay
"not applied" with a sketch workaround; STEP/IGES stay faceted; faces cannot be picked one by one.
Items elsewhere that say they need exact geometry (3.9, 5.1, 6.2, 6.3) are limited to what the mesh kernel can do.

- [x] **2.1** Spike: evaluate OpenCascade via WebAssembly: size and licence measured (above); not adopted
- ~~**2.2–2.9**~~ Kernel interface, OCCT adapter, topology picking, edge fillet/chamfer, exact STEP, topological naming — not planned

## Phase 3 — Part modeling parity

- [x] **3.1** Sketch on any planar face, not only the three default planes (Sketch ▸ On Face: click a flat face; the sketch keeps that plane; walls are upright, and Front/Top/Right faces line up with the standard planes. Faces are not tracked if the part changes: no topological naming)
- [x] **3.2** Constraint UI: add/show/delete geometric relations; fully-defined colouring (Relation tool: horizontal, vertical, parallel, perpendicular, equal, coincident, concentric, tangent, fix; green tags with ✕; rectangles, slots and polygons come with their relations; joined ends stay joined and tangent joins tangent; conflicting or redundant relations are refused; status bar: fully / under (DOF) / over; white lines when fully defined)
- [x] **3.3** Driving dimensions editable in the viewport (Smart Dimension: length, Ø, R, point–point, point–line, line–line; type the value; double-click to change; least-change solving keeps free geometry in place; `api.sketches.constrain / setDimension / status`, API 1.11)
- [x] **3.4** Arcs, splines, slots, polygons, trim / extend / offset / mirror (all with click hints; trim cuts back to the nearest crossings and turns a cut circle into an arc; extend lengthens lines to the next entity; offset follows a connected chain of lines and arcs and re-joins the corners; mirror copies about a picked line; splines through clicked points, open or closed; pick tolerance is 8 screen pixels; grid snap can be switched off. Splines and ellipses can be mirrored but not trimmed or offset)
- [x] **3.5** Reference geometry: planes (offset + tilt from Front/Top/Right; sketches follow them), axes (parallel to X/Y/Z through a point or a reference point) and points, all editable and drivable by equations. Revolve about the sketch X/Y axis, a centreline or a reference axis in the sketch plane. Coordinate systems are not done
- [x] **3.6** Hole wizard (counterbore, countersink, tapped) with standards tables: ISO metric M3–M20, clearance holes ISO 273 (close / normal / loose), counterbores for ISO 4762 (DIN 974-1), countersinks for ISO 10642, tapped = tap drill d − P (thread not modelled). The resolved sizes are stored on the feature; custom sizes remain; `api.features.hole` (API 1.8)
- [x] **3.7** Global variables and equations (Tools ▸ Equations; any feature number field (hole positions too, as `position.x`) and any sketch dimension (the sketch is solved again when variables or the configuration change) takes an expression and stays linked (ƒ); safe parser, dependency order, cycle detection; saved with the project, in undo; `equations.set` / `equations.list`)
- [x] **3.8** Configurations (design tables): named versions that override variable values. Tools ▸ Configs table, quick switcher on the ribbon, badge in the title bar; switching is an undo step; saved with the project; `configurations.*` commands and `api.configurations`
- [x] **3.9** Measure tool (Evaluate ▸ Measure, key M: two picks on the model, corners snap; distance, dX/dY/dZ, angle between faces, gap between parallel faces; `api.model.measure` in API 1.6). Section view: the existing cross-section toggle; exact-geometry sections are not planned (mesh kernel)

## Phase 4 — Assemblies

- [ ] **4.1** Multi-document workspace: parts and assemblies as separate documents
- [ ] **4.2** Insert real part documents as components (with references, not copies)
- [ ] **4.3** Mates picked on real faces/edges; under/over-defined feedback
- [x] **4.4** Interference detection (Assembly ▸ Interference: every pair at its assembled position, shared volume by solid intersection, shown in red with a results card that notices when the assembly changed; touching parts are not reported; `api.assembly.interference`, API 1.13)
- [x] **4.5** Bill of materials (BOM button on the Assembly tab: identical parts grouped with quantities, exact masses, a material per component (picked in the BOM, shown in the viewport, saved with the project; unset follows the document material), CSV export; `assembly.bom` / `assembly.setMaterial` from scripts)
- [ ] **4.6** Exploded views with steps; motion along mates

## Phase 5 — Drawings

- [ ] **5.1** Views generated from exact geometry (crisp edges, true arcs)
- [ ] **5.2** Associative dimensions that update with the model (today the sheet has fixed views and overall dimensions; the Drawing tab switches hidden lines, dimensions and GD&T, picks the sheet size and exports SVG / DXF)
- [x] **5.3** BOM tables and balloons from assemblies (Drawing tab: Part / Assembly. The assembly sheet draws the assembled components, puts the parts list on the title block and numbers each item with a balloon placed clear of the other sheet elements. Checked with `layoutProblems` on every sheet size; SVG and DXF)
- [ ] **5.4** Sheet formats and title block editor (layout done: reserved bands per view, title block kept clear, standard ISO 5455 scales, overlap checker `layoutProblems` tested on every example and sheet size; editor still to do)
- [x] **5.5** PDF and DXF export (vector PDF written directly, no library: standard Helvetica fonts, GD&T symbols drawn as lines, checked with poppler and Ghostscript; Drawing tab, sheet window and `api.drawings.pdf()`). DWG is not planned (closed format; DXF covers the exchange)

## Phase 6 — Simulation

- [x] **6.1** Solver in a Web Worker with progress and cancel (phases: meshing / solving; inline fallback where workers are unavailable)
- [ ] **6.2** Meshing from exact geometry with local refinement (voxel mesh now sized from an element budget — Coarse / Medium / Fine — choosing the grid whose volume best matches the part, with the coverage reported and a warning beyond ±5%; thin-walled parts such as the sheet-metal enclosure still mesh far too thick; local refinement on the mesh kernel only, exact geometry is not planned)
- [ ] **6.3** Fixtures and loads picked on faces (the FEA panel chooses the fixed face, loaded face and load direction among the six bounding-box faces, shown on the model; picking single faces would need an exact kernel, which is not planned)
- [x] **6.4** Results: deformed shape, probes, report export (colour plot of von Mises / displacement and exaggerated deformed shape; probes: click the plot for stress and displacement at the nearest node, up to 12, labelled on the model and listed; Report: a self-contained printable HTML page with verdict, results, plot picture, study, material, mesh and probes)
- [x] **6.5** Modal (frequency) analysis (Analysis ▸ Modal in the FEA panel: the lowest natural frequencies and their mode shapes with the fixed face held; lumped mass (HRZ for Tet10), shift-invert Lanczos with a direct envelope Cholesky (RCM ordering; IC(0)-CG past ~100 MB); Tet10 coarse within 1% of the cantilever formula; runs in the solver worker; `simulation.modal` command, `api.model.naturalFrequencies()` since API 1.14)

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
