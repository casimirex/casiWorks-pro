# CasiWorks Pro — Professional 3D CAD Engineering Suite

**CasiWorks Pro** is a professional, web-based 3D CAD application for mechanical design. Built with modern WebGL/Three.js rendering, a parametric feature tree over a triangle-mesh solid kernel (BSP CSG booleans, exact mass properties), a Levenberg-Marquardt 2D constraint solver, multi-body kinematic assembly mates, 3D solid linear static FEA simulation, 2D engineering drawings with GD&T, and ISO standard CAD data exchange (faceted STEP AP214, IGES 5.3, STL, DXF).

---

## 🏛️ System Architecture

```
casiworks/
├── index.html                    # Application entry HTML with branded splash screen
├── package.json                  # Dependencies & scripts
├── vite.config.ts                # Vite build configuration
├── src/
│   ├── main.tsx                  # React 18 bootstrap
│   ├── App.tsx                   # Central application logic & reactive model rebuild loop
│   ├── index.css                 # Dark engineering UI styling
│   │
│   ├── api/
│   │   ├── CasiWorksAPI.ts       # Public, typed scripting API v1
│   │   └── index.ts              # API entry: window.casiworks, casiworks-pro/api module
│   ├── commands/                 # Command registry: ribbon, shortcuts and API run named commands
│   │   ├── CommandRegistry.ts    # Registry, key bindings, execution listeners
│   │   ├── builtinCommands.ts    # Every built-in command (file.*, feature.*, sketch.*, view.*, …)
│   │   └── macros.ts             # Macro recorder, replay with id mapping, script export
│   ├── console/                  # In-app scripting console (ScriptConsole.tsx, evaluate.ts)
│   ├── plugins/                  # Add-ins: PluginManager (load, namespacing, rollback, unload)
│   │
│   ├── types/
│   │   └── cad.ts                # Core domain types (features, sketch entities, mass properties)
│   │
│   ├── store/
│   │   └── cadStore.ts           # Zustand + Immer state (undo/redo, feature tree, assembly)
│   │
│   ├── kernel/                   # Geometry kernel (triangle meshes)
│   │   ├── GeometryEngine.ts     # Extrude, revolve, sweep, loft, patterns, mirror, holes, booleans, mass properties
│   │   ├── csg.ts                # BSP-tree CSG: union / subtract / intersect on closed meshes
│   │   ├── profile.ts            # Sketch entities → closed loops → shapes with holes
│   │   ├── SketchEngine.ts       # Sketch entity factories, snapping, profile closure check
│   │   ├── ConstraintSolver.ts   # Levenberg-Marquardt 2D solver with QR decomposition, rank & DOF analysis
│   │   ├── MaterialLibrary.ts    # Engineering materials (Steels, Al, Ti, Plastics) with physical constants
│   │   ├── ExportEngine.ts       # STEP AP214 faceted solid, IGES 5.3 MSBO, STL (Binary/ASCII), DXF, OBJ
│   │   └── ImportEngine.ts       # STEP, IGES 5.3, Binary/ASCII STL, AutoCAD DXF, and Project JSON parser
│   │
│   ├── features/
│   │   ├── FeatureEngine.ts      # Parametric feature evaluation (rollback, suppression, dependencies)
│   │   └── rebuildModel.ts       # Rebuild entry point shared by the UI and the API
│   │
│   ├── assembly/
│   │   └── AssemblyManager.ts    # Multi-body solver: Standard & Advanced mates (Tangent, Width, Path), Exploded Views
│   │
│   ├── simulation/
│   │   ├── FEAEngine.ts          # 3D Solid FEA: Tet4/Tet10 meshing, 12x12 stiffness matrix, PCG solver, Cauchy tensor
│   │   └── ResultsViewer.tsx     # Simulation panel: max von Mises, deflection, factor of safety, stress tensor
│   │
│   ├── drawings/
│   │   ├── DrawingEngine.ts      # 2D Orthographic projections, Hidden Line Removal (HLR), GD&T, SVG/DXF export
│   │   └── DrawingViewModal.tsx  # Interactive engineering drawing sheet viewer modal
│   │
│   ├── viewport/                 # High-Performance 3D Viewport
│   │   ├── Viewport3D.tsx        # R3F Canvas, OrbitControls, Reference Planes, Shading, Sharp Edges
│   │   ├── ViewportPicker.ts     # Raycaster, 3D to sketch plane projection, vertex & edge snapping
│   │
│   ├── components/
│   │   ├── layout/
│   │   │   ├── CommandManager.tsx # Ribbon toolbar (Features, Sketch, Surfaces, Assembly, Drawing, FEA)
│   │   │   ├── FeatureTree.tsx    # Feature Tree (history, planes, suppression, rollback)
│   │   │   ├── PropertyPanel.tsx  # Contextual property panel with parameter binding and debounced updates
│   │   │   ├── StatusBar.tsx      # MMGS units, grid/snap toggles, tool status
│   │   │   └── MainLayout.tsx     # Master flex layout
│   │   ├── dialogs/
│   │   │   ├── ExportDialog.tsx   # Multi-format CAD export (STEP, IGES, STL, DXF, OBJ)
│   │   │   ├── MaterialDialog.tsx # Searchable material database with physical properties
│   │   │   └── MassPropsDialog.tsx# Exact Volume, Mass, Center of Mass, Moments of Inertia
│   │   └── common/
│   │       └── NumericInput.tsx   # High-precision engineering spinner input with units
│   │
│   └── utils/
│       ├── math.ts               # Small vector helpers, ids, sketch-plane transforms
│       ├── constants.ts          # Tool ids, feature/entity types, materials, settings
│       ├── examples.ts           # 8 parametric example models
│       ├── clone.ts              # Safe deep clone for undo snapshots
│       ├── debounce.ts           # Debounce for responsive sliders
│       ├── projectFile.ts        # Project save / open / new (.casiproj)
│       └── shortcuts.ts          # Keyboard shortcuts
└── tests/
    ├── casiworks.test.ts         # Solver, features, assembly, data exchange, FEA, drawings, store
    ├── geometry.test.ts          # Kernel: profiles, extrude/revolve/loft, mirror, patterns, examples
    ├── sketch.test.ts            # Sketch engine and constraint solver semantics
    ├── api.test.ts               # Public API (headless)
    ├── commands.test.ts          # Command registry, keymap, built-in commands
    ├── events.test.ts            # API events
    ├── macros.test.ts            # Macro recording, replay, script export
    ├── console.test.ts           # Scripting console evaluator
    ├── apidocs.test.ts           # API reference completeness
    └── plugins.test.ts           # Add-ins: loading, conflicts, rollback, unload
```

---

## 🔬 What Actually Works (Verified Production Architecture)

CasiWorks Pro implements real, verified engineering algorithms rather than superficial UI mocks. The architecture is tested across 7 areas:

### 1. Real Feature Tree & Parametric Dependency Graph
- **Directed Acyclic Graph (DAG)**: Features maintain explicit `parentIds` and `childIds` associations. Sketches act as foundational parents to extrusions, cuts, revolves, sweeps, lofts, fillets, and chamfers.
- **Rollback Bar**: The feature history tree features an interactive rollback bar (`rollbackIndex`). Dragging or clicking any position rolls back evaluation to that historical state without destroying downstream feature definitions, allowing upstream parameter adjustments that recalculate downstream upon roll-forward.
- **Cascading Suppress & Unsuppress**: Suppressing an upstream feature automatically cascades suppression through all downstream children in the dependency chain. Conversely, unsuppressing a downstream feature automatically restores any required parent features.
- **Live Rebuild Loop**: Edits mark the model dirty; `rebuildModel` (`src/features/rebuildModel.ts`) re-evaluates the feature tree into solid bodies. Features that fail report a rebuild warning on that feature instead of stopping the rebuild.

### 2. Industrial-Strength 2D Constraint Solver
- **Levenberg-Marquardt with Householder QR Decomposition**: Built in `src/kernel/ConstraintSolver.ts`, the solver computes a 2nd-order central-difference numerical Jacobian $\mathbf{J}$ ($m_{\text{constraints}} \times n_{\text{vars}}$) and solves the augmented least-squares system via Householder QR decomposition with column pivoting:
  $$\min \left\| \begin{bmatrix} \mathbf{J} \\ \sqrt{\lambda} \mathbf{I} \\ \sqrt{\mu} \mathbf{I} \end{bmatrix} \Delta \mathbf{x} - \begin{bmatrix} -\mathbf{r} \\ \mathbf{0} \\ -\sqrt{\mu}(\mathbf{x} - \mathbf{x}_0) \end{bmatrix} \right\|_2^2$$
  where $\lambda$ is an adaptive Levenberg-Marquardt damping factor and $\mu$ is Tikhonov regularization anchoring the solution to initial geometry.
- **Degrees of Freedom (DOF) Analysis**: Evaluates numerical rank of $\mathbf{J}$ from diagonal elements of $\mathbf{R}$ after QR column pivoting. Computes remaining degrees of freedom:
  $$\text{DOF} = n_{\text{vars}} - \text{rank}(\mathbf{J})$$
  and classifies sketch state into `under_constrained`, `fully_constrained`, or `over_constrained`.
- **Over-Constrained & Conflict Diagnostics**: Distinguishes between redundant constraints (linearly dependent equations with zero residual) and inconsistent/conflicting constraints (non-zero residual, e.g. conflicting dimensions), returning diagnostic objects `{ type: 'conflict', constraintIds: [...] }`.
- **Complete Constraint Catalog**: `COINCIDENT`, `HORIZONTAL`, `VERTICAL`, `PARALLEL`, `PERPENDICULAR`, `EQUAL`, `FIX`, `MIDPOINT`, `CONCENTRIC`, `COLINEAR`, `TANGENT`, `DIMENSION` (distance, radius, diameter), `ANGLE`, and `SYMMETRIC`.

### 3. Geometry Kernel (triangle meshes)
Solids are closed, outward-facing triangle meshes (`src/kernel/`). Every operation
below is covered by measured regression tests (volumes against closed-form values,
bounds, and a closed-mesh check) in `tests/geometry.test.ts`.

- **Profiles** (`profile.ts`): sketch entities become closed loops regardless of drawing direction; loops nest by containment (solid / hole / island); overlapping regions are unioned; construction geometry is ignored.
- **Extrude**: blind, midplane, through (500 mm, one direction), flip; several regions per sketch.
- **Revolve**: full or partial (capped) revolutions; either profile orientation.
- **Loft**: closed, capped solid between two or more sections. **Sweep** along a path.
- **Patterns and mirror**: linear and circular (full or partial angle); instances and mirror halves are unioned, so overlaps are not double-counted.
- **Booleans** (`csg.ts`): BSP-tree union, subtract and intersect.
- **Mass properties**: exact for the mesh — volume, area, center of mass and inertia tensor (at the center of mass and at the origin) in SI units.

**Not available** (CasiWorks uses its own mesh kernel; an exact B-Rep kernel is not planned): fillet, chamfer
and shell are kept in the feature tree but report a "not applied" warning and leave
the model unchanged; faces and edges cannot be selected individually; STEP/IGES
export writes faceted (triangulated) geometry.

### 4. Multi-Body Assembly Mate Engine
- **Kinematic Mates** (`src/assembly/AssemblyManager.ts`):
  - **Standard Mates**:
    - `Coincident`: Aligns opposing face normals ($\vec{n}_2 = -\vec{n}_1$) and eliminates contact standoff gap.
    - `Distance`: Enforces exact planar offset standoff distance along opposing face normals.
    - `Concentric`: Aligns cylindrical axis directions and eliminates perpendicular axis offset.
    - `Parallel`: Aligns face normal vectors ($\vec{n}_1 \parallel \vec{n}_2$) while preserving translational freedom.
    - `Perpendicular`: Enforces orthogonal surface orientation ($\vec{n}_1 \cdot \vec{n}_2 = 0$).
    - `Angle`: Enforces specified angular orientation between faces or axes.
  - **Advanced Mates**:
    - `Tangent`: Tangent contact between cylindrical surfaces and planar/cylindrical reference faces (centerline distance $= \text{radius} + \text{offset}$).
    - `Width`: Symmetrically centers a tab component between two boundary reference faces.
    - `Path`: Restrains a component's reference point along a 3D guide curve polyline.
- **Multi-Body Solver**: 6-DOF satisfaction loop using quaternion rotation (`setFromUnitVectors`, `slerp`) and translation relaxation with weighted mass distribution for unpinned bodies.
- **Exploded View Generator**: Configurable exploded distances along kinematic motion axes with 3D polyline leader lines.

### 5. 3D Solid Linear Static FEA Simulation
- **3D Tetrahedral Meshing** (`src/simulation/FEAEngine.ts`):
  - Voxelizes arbitrary CAD solids via ray-triangle parity containment testing.
  - Decomposes voxels into 6 tetrahedra using Kuhn's decomposition.
  - Supports **Tet4** (linear 4-node) and **Tet10** (quadratic 10-node with mid-edge nodes) elements.
  - Tracks surface boundary faces with outward normal vectors and surface areas.
- **3D Elasticity Stiffness Matrix**:
  - Exact $12 \times 12$ element stiffness matrix based on Young's modulus $E$ and Poisson's ratio $\nu$:
    $$\mathbf{k}_e = \int_{V_e} \mathbf{B}^T \mathbf{D} \mathbf{B} \, dV = V_e \, \mathbf{B}^T \mathbf{D} \mathbf{B}$$
    where $\mathbf{B}$ is the $6 \times 12$ strain-displacement matrix and $\mathbf{D}$ is the $6 \times 6$ isotropic constitutive matrix.
  - Strictly symmetric ($K_{ij} = K_{ji}$) verified to machine precision.
- **Global Solver**:
  - `SparseMatrix` assembly with symmetric Dirichlet elimination for fixed fixtures ($u_x = u_y = u_z = 0$), pin/roller supports, boundary plane selectors, and pressure loads.
  - **Preconditioned Conjugate Gradient (PCG)** solver with Jacobi preconditioning.
- **3D Stress & Strain Tensor**:
  - Computes all 6 Cauchy stress components: $\sigma_{xx}, \sigma_{yy}, \sigma_{zz}, \tau_{xy}, \tau_{yz}, \tau_{zx}$.
  - Analytical principal stresses ($\sigma_1 \ge \sigma_2 \ge \sigma_3$) via Cardano's cubic formula for the characteristic polynomial.
  - von Mises equivalent stress:
    $$\sigma_v = \sqrt{\frac{1}{2}\left[(\sigma_{xx} - \sigma_{yy})^2 + (\sigma_{yy} - \sigma_{zz})^2 + (\sigma_{zz} - \sigma_{xx})^2 + 6(\tau_{xy}^2 + \tau_{yz}^2 + \tau_{zx}^2)\right]}$$
  - Factor of Safety (FOS) against material yield strength ($\text{FOS} = \sigma_{\text{yield}} / \sigma_v$).
  - Displaced Three.js BufferGeometry generation with rainbow/jet colormap vertex coloring.

### 6. 2D Engineering Drawings Engine
- **Orthographic Projections** (`src/drawings/DrawingEngine.ts`):
  - Generates Front, Top, Right, Left, Bottom, Back, and 30° Isometric views from 3D models.
  - Feature crease extraction based on dihedral angle thresholding.
- **Hidden Line Removal (HLR)**:
  - Barycentric depth buffer occlusion testing against front-facing triangles.
  - Classifies visible solid contour lines (thick 0.5mm) vs dashed hidden lines (thin 0.25mm).
- **Dimensioning & GD&T (ASME Y14.5 / ISO 1101)**:
  - Linear dimensions with extension/witness lines, offsets, overshoot, and arrowheads.
  - Datum feature symbols (`[A]`, `[B]`).
  - Feature Control Frames: Flatness ($\unicode{x23E5}$), Perpendicularity ($\bot$), Parallelism ($\parallel$), Position ($\bigoplus$), Circular Runout ($\nearrow$), Cylindricity ($\unicode{x232D}$), Concentricity ($\unicode{x25CE}$).
- **Vector Export**:
  - High-fidelity scalable vector graphics (**SVG**) export with title block, borders, and styled CSS layers.
  - AutoCAD **DXF** export structured into `VISIBLE`, `HIDDEN`, and `DIMENSION` layers.

### 7. CAD Data Exchange (STEP, IGES, STL, OBJ, DXF)
All solid exports are triangulated meshes (exact curved surfaces would need an
exact B-Rep kernel, which is not planned). Every face is written; `tests/exchange.test.ts` checks each
file against its standard's structure with parsers independent of the importer,
then round-trips all examples with exact volume.
- **STEP (ISO 10303-21, AP214; AP242 optional)**: faceted B-rep — `FACETED_BREP` /
  `FACETED_BREP_SHAPE_REPRESENTATION`, a `CLOSED_SHELL` of triangular `POLY_LOOP`
  faces over shared points, millimetre units, colour styling.
- **IGES 5.3**: manifold solid B-rep (entity 186) with a vertex list (502),
  edge list (504) of lines (110) shared between faces, loops (508), planes (108),
  faces (510) and a closed shell (514); 80-column records with parameters never
  split across records.
- **STL** (binary and ASCII) with facet normals computed from each triangle; **OBJ**.
- **DXF R12**: sketch entities (`LINE`, `CIRCLE`, `ARC`, `POINT`) or the model as `3DFACE`s.
- **Importers** read STL, OBJ, DXF, faceted/planar STEP and IGES 5.3 B-rep faces;
  files with no readable faces are reported as errors. (The app's Open command
  currently loads project files only.)
- **Project files** (`.casiproj`): feature history, sketches, constraints,
  dimensions, material and assembly.

---

## 🧩 Scripting API (v1)

CasiWorks Pro exposes a public, versioned, fully typed API (`src/api/`).
It drives the same store as the UI, so API edits appear in the feature tree and
viewport, and can be undone like any other edit.

**In the running app** it is `window.casiworks`. The built-in **scripting
console** (Tools ▸ Console, or Ctrl+\`) has it in scope as `api`, with
`run(id, args)` for commands; `await` works and the value of the last line is
shown. Or use the browser's developer console:

```js
const api = window.casiworks;          // api.version === '1.6.0'
const { sketchId } = api.sketches.create({
  plane: 'Front',
  entities: [{ type: 'rectangle', corner1: { x: -30, y: -20 }, corner2: { x: 30, y: 20 } }],
});
const boss = api.features.extrude({ sketchId, depth: 25 });
api.features.update(boss, { depth: 40 });
api.model.massProperties(); // { volume: 96000 (mm³), mass: 0.7584 (kg), ... }
```

Scripts that load before the app (extensions, an embedding page) can wait for it:

```js
window.addEventListener('casiworks:ready', (e) => console.log('CasiWorks', e.detail.version));
```

**Headless, as an ES module** (Node 22.18+ runs the TypeScript sources directly):

```js
import { createHeadlessAPI } from 'casiworks-pro/api';
const api = createHeadlessAPI();   // same API, no browser or React
```

`api.version` follows semantic versioning: minor versions only add, major
versions may break.

**New in 1.5**: equations, configurations, assemblies, drawings and sketch editing:

```js
api.equations.set([{ name: 'wall', expression: '3' }, { name: 'depth', expression: 'wall * 8' }]);
api.equations.link(boss, 'depth', 'depth + 1');           // the extrude follows the variables
api.configurations.set([{ name: 'Large', values: { wall: '6' } }]);
api.configurations.activate('Large');                    // depth becomes 49

const plate = api.assembly.insert({ name: 'Base_Plate', shape: 'box', dimensions: { width: 50, height: 12, depth: 50 } });
const pin = api.assembly.insert({ name: 'Pin_Shaft', shape: 'pin' });
api.assembly.mate({ type: 'concentric', component1: plate, component2: pin });
api.assembly.solve();
api.assembly.setMaterial([pin], 'Brass_C36000');
api.assembly.bom();                                      // rows with quantities and masses

api.drawings.setOptions({ subject: 'assembly', sheetSize: 'A3_LANDSCAPE' });
const svg = api.drawings.svg();                          // parts list and balloons; dxf() too

api.sketches.trim(sketchId, lineId, { x: 5, y: 0 });     // also extend, offset, mirror
```

**New in 1.6**: `api.model.measure(a, b, { normalA, normalB })`: distance, dX/dY/dZ, the
angle between faces and, for parallel faces, the gap (what the Measure tool shows).

**Add-ins** (since 1.4): an add-in is an ES module that exports a plugin
object; it gets the public API and can add commands and Add-ins ribbon buttons.
Load one from **Add-ins ▸ Manage** (URL or file) or with `api.plugins.load(url)`.
Commands are named `<pluginId>.<name>`, cannot replace built-in commands or
key bindings, and everything an add-in registered is removed when it is
unloaded. The bundled example, [`public/plugins/washer.js`](public/plugins/washer.js),
adds ISO 7089 washers:

```js
export default {
  id: 'washer', name: 'Washer generator', version: '1.0.0', apiVersion: '1.4',
  commands: [{ name: 'create', label: 'Washer', run: (args, host) => { /* host.api.sketches…, host.api.features… */ } }],
  buttons: [{ command: 'create', label: 'M8', args: { size: 'M8' }, icon: '◎' }],
};
```

An add-in runs with the same access as the app, so load only add-ins you trust.

**API reference:** generated from the sources' doc comments by
`npm run docs:api` (also run automatically before `dev` and `build`) and served
with the app at **`/api/`** (Tools ▸ API Reference). It lists every namespace,
member, event, command and type; a test fails if a public member is undocumented.

**Commands** (since 1.1): every ribbon button, status-bar toggle and keyboard
shortcut runs a named command, and scripts can run the same ones:

```js
api.commands.list();                                  // [{ id: 'feature.extrudeCut', label, category, shortcuts }, …]
api.commands.execute('sketch.new', { plane: 'Right' });
api.commands.execute('view.isometric');
api.commands.execute('assembly.mate', { type: 'concentric' });
```

Commands that open dialogs or files (`file.open`, `model.material`, `drawing.open`…)
need the running app; headless they fail with `OPERATION_FAILED`.

**Events** (since 1.2): react to changes made anywhere — UI, keyboard or script:

```js
const stop = api.on('featureAdded', (e) => console.log('added', e.feature.name, e.feature.parameters));
api.on('rebuild', (e) => console.log(e.ok ? `${e.bodyCount} body` : e.errors));
api.on('selectionChanged', (e) => console.log(e.ids));
stop(); // or api.off('featureAdded', handler)
```

Events: `rebuild`, `featureAdded`, `featureChanged`, `featureRemoved`,
`selectionChanged`, `documentChanged` (new / open / example — sent instead of
per-feature events), `commandExecuted`. Payloads are plain data.

**Macros** (since 1.3): **Tools ▸ Record** records the model changes you make
(sketches as their finished geometry, features with their parameters, edits,
suppression, material, assembly mates) and **Stop** saves them as a
`.casimacro.json` file; **Run Macro** replays one, **Save as Script** writes it
as a JavaScript module. Ids are remapped on replay, so a macro can run any
number of times. From code:

```js
api.macros.startRecording('Bracket');
// … work in the UI or call api.commands …
const macro = api.macros.stopRecording();   // plain JSON
api.macros.run(macro);                      // replay
api.macros.toScript(macro);                 // const r1 = run('sketch.create', …); run('feature.create', { sketchId: r1.sketchId, … })
```

Running a macro file never evaluates code: it is data. Scripts (`.mjs`) run
where you choose to run them (browser console, `node`).

Namespaces: `document`, `sketches`, `features`, `model`, `materials`, `history`.
Units are mm, degrees, kg and kg/m³. Invalid calls throw `CasiWorksAPIError`
with a stable `code` (`INVALID_ARGUMENT`, `NOT_FOUND`, `INVALID_DOCUMENT`).
All return values are plain JSON data.

Every input and result is typed (`CasiWorksAPI`, `SketchSpec`, `ExtrudeSpec`,
`FeatureInfo`, `MassProperties`, …), so TypeScript editors autocomplete the API
and reject invalid calls at compile time; the same rules are enforced at
runtime for plain JavaScript callers.

---

## 🧪 Verification & Test Suite


Browser end-to-end smoke test (needs Chrome; set `CHROME_PATH` if it is not found): `npm run build && npm run e2e`. It drives the real app — sketching with the mouse, property-panel features, drawings, FEA, commands and events, export, macro record and replay — and saves screenshots to `e2e-output/`.

CasiWorks Pro is verified through an automated test suite (`tests/casiworks.test.ts` and the other `tests/*.test.ts` files) executed with Node.js test runner:

```bash
npm test
```

### Coverage (all passing; run `npm test`)
- **Constraint solver**: coupled systems, equal/parallel constraints, DOF analysis, conflict detection, numerical edge cases
- **Feature engine**: midplane/through extrudes, rollback, thin features, suppressed-sketch propagation, missing-sketch errors
- **Geometry kernel** (`tests/geometry.test.ts`): profiles (regions, direction, nesting, overlap, construction), extrude/flip, revolve, loft, mirror, patterns, not-applied finishing features, all examples
- **Assembly**: coincident, distance, concentric, parallel, perpendicular, tangent, width, path mates; degenerate cases
- **Data exchange**: STL, DXF, STEP AP214/AP242 and IGES 5.3 round-trips; IGES Global-section Hollerith validity
- **FEA**: cantilever deflection vs. Euler-Bernoulli analytical solution, Tet4/Tet10 stiffness and stress tensor
- **Drawings**: orthographic projection with hidden-line removal, dimensions, GD&T, SVG/DXF export
- **Application state**: add/remove/suppress on every built-in example, project save/load round-trip, atomic rejection of invalid files
- **Public API** (`tests/api.test.ts`): headless modeling end-to-end, undo/redo, suppression, rollback, materials, validation error codes, copy semantics

The suite runs in CI-friendly Node with no browser: `npm test`. Run `npm run build` to verify the production bundle.

---

## 🚀 Key Features

1. **Professional CAD UI Layout**:
   - **Ribbon**: Command toolbar with Features, Sketch, Surfaces, Assembly, Evaluate, Simulation, and Drawing tabs.
   - **Feature Tree**: Left sidebar showing Document origin, Reference Planes (Front, Top, Right), and feature timeline.
   - **Properties**: Contextual parameter editor with green OK checkmark and red Cancel buttons, with debounced sliders.
   - **ViewCube & Triad**: 3D orientation controls with standard views (Top, Front, Right, Isometric).

2. **2D Sketching**:
   - Lines, Rectangles, Circles, Arcs, Splines, Slots, and Points.
   - Smart Dimensioning and Construction Geometry toggle.
   - Interactive projection onto Front (XY), Top (XZ), and Right (YZ) planes.
   - Snapping to grid and entity vertices/midpoints.

3. **3D Parametric Modeling**:
   - **Extrude Boss/Base & Extrude Cut**: Blind, Mid Plane, Through All.
   - **Revolve Boss/Base & Revolve Cut**: Full 360° or partial angle around sketch axes.
   - **Sweep & Loft**: Profile sweeping along 3D guide curves with rotation-minimizing frames.
   - **Fillet & Chamfer**: Procedural edge rounding and beveling.
   - **Shell**: Hollowed out parts with user-specified wall thickness and cavity void shells.
   - **Hole Wizard**: Standard circular through and blind holes.
   - **Patterns & Mirror**: Linear and circular array patterning across planes.

4. **Engineering Materials & Physical Evaluation**:
   - Comprehensive library of steels (AISI 1020, 304SS, 4140), aluminums (6061-T6, 7075-T6), titanium, brass, copper, ABS, nylon, carbon fiber.
   - **Mass Properties Calculator**: Mass, volume, surface area, center of gravity ($x, y, z$), and principal moments of inertia ($I_{xx}, I_{yy}, I_{zz}$).

5. **3D Solid FEA Simulation**:
   - Automated Tet4/Tet10 tetrahedral mesh generation.
   - 3D elasticity stiffness matrix solution ($12 \times 12$ per element).
   - Preconditioned Conjugate Gradient (PCG) solver with Dirichlet fixture boundary conditions.
   - Cauchy stress components, analytical principal stresses, von Mises equivalent stress, and Factor of Safety (FOS) contour colormap.

6. **2D Engineering Drawings & GD&T**:
   - Multi-view orthographic projection (Front, Top, Right, Isometric) with Hidden Line Removal (HLR).
   - Smart dimensions, extension lines, arrowheads, tolerances.
   - ASME Y14.5 / ISO 1101 GD&T datum feature symbols and Feature Control Frames.
   - Standard drawing sheets (A4, A3, ANSI B) with engineering title blocks.
   - SVG and AutoCAD DXF vector export.

7. **Multi-Component Assembly**:
   - Component insertion and coordinate transformation.
   - Standard mates: Coincident, Distance, Concentric, Parallel, Perpendicular, Angle.
   - Advanced mates: Tangent, Width, Path.
   - Exploded view generation with 3D leader lines.

8. **Export & Import**:
   - Export: **STEP AP214 (faceted)**, **STL (binary & ASCII)**, **OBJ** and **DXF R12** and **IGES 5.3** from the Export dialog; native project files.
   - Import: **STEP**, **IGES 5.3**, **STL**, **DXF**, **OBJ**, and Project JSON.

9. **Keyboard Shortcuts**:
   - `Ctrl+Z` / `Ctrl+Y`: Undo / Redo
   - `Ctrl+S`: Save Project
   - `F5`: Rebuild Feature Tree
   - `L`: Line tool
   - `R`: Rectangle tool
   - `C`: Circle tool
   - `D`: Smart Dimension
   - `E`: Extrude feature
   - `Space`: Reset to Isometric view
   - `Ctrl+1` through `Ctrl+7`: Standard view orientations

---

## 🏃 Running the Application

To start the development server:
```bash
npm run dev
```
Open your browser at `http://localhost:5173/`.

To run the automated verification test suite:
```bash
npm test
```

To build for production:
```bash
npm run build
```
Production assets are generated cleanly in `dist/`.
