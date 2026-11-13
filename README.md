# CasiWorks Pro — Professional 3D CAD Engineering Suite

**CasiWorks Pro** is a professional, web-based 3D CAD application for mechanical design. Built with precision mechanical engineering standards, modern WebGL/Three.js rendering, a full Boundary Representation (B-Rep) topological kernel, an industrial-grade Levenberg-Marquardt 2D constraint solver, multi-body kinematic assembly mates, 3D solid linear static FEA simulation, 2D engineering drawings with GD&T, and ISO standard CAD data exchange (STEP AP214/AP242, IGES 5.3, STL, DXF).

---

## 🏛️ System Architecture

```
casiworks/
├── index.html                    # Application entry HTML with branded splash screen
├── package.json                  # Dependencies & scripts
├── vite.config.js                # Vite build configuration
├── src/
│   ├── main.jsx                  # React 18 bootstrap
│   ├── App.jsx                   # Central application logic & reactive model rebuild loop
│   ├── index.css                 # Dark engineering UI styling
│   │
│   ├── store/
│   │   └── cadStore.js           # Zustand + Immer reactive state management (undo/redo, tree, modes)
│   │
│   ├── kernel/                   # Core Geometry & Topology Kernel
│   │   ├── Topology.js           # B-Rep data structure: Vertex, Edge, CoEdge, Loop, Face, Shell, SolidBody
│   │   ├── BRep.js               # Solid modeling: Extrude, Revolve, Sweep, Loft, Fillet, Chamfer, Shell, CSG Booleans
│   │   ├── GeometryEngine.js     # Unified geometry API & Three.js BufferGeometry conversion
│   │   ├── SketchEngine.js       # 2D geometry creation, offsets, mirroring, graph closure detection
│   │   ├── ConstraintSolver.js   # Levenberg-Marquardt 2D solver with QR decomposition, rank & DOF analysis
│   │   ├── MaterialLibrary.js    # Engineering materials (Steels, Al, Ti, Plastics) with physical constants
│   │   ├── ExportEngine.js       # STEP AP214/AP242 B-Rep, IGES 5.3 MSBO, STL (Binary/ASCII), DXF, OBJ
│   │   └── ImportEngine.js       # STEP, IGES 5.3, Binary/ASCII STL, AutoCAD DXF, and Project JSON parser
│   │
│   ├── features/
│   │   └── FeatureEngine.js      # Parametric feature tree rebuild engine (history rollback & regeneration)
│   │
│   ├── assembly/
│   │   └── AssemblyManager.js    # Multi-body solver: Standard & Advanced mates (Tangent, Width, Path), Exploded Views
│   │
│   ├── simulation/
│   │   ├── FEAEngine.js          # 3D Solid FEA: Tet4/Tet10 meshing, 12x12 stiffness matrix, PCG solver, Cauchy tensor
│   │   └── ResultsViewer.jsx     # Simulation HUD: von Mises contour colormap, Cauchy stress inspector, FOS
│   │
│   ├── drawings/
│   │   ├── DrawingEngine.js      # 2D Orthographic projections, Hidden Line Removal (HLR), GD&T, SVG/DXF export
│   │   └── DrawingViewModal.jsx  # Interactive engineering drawing sheet viewer modal
│   │
│   ├── viewport/                 # High-Performance 3D Viewport
│   │   ├── Viewport3D.jsx        # R3F Canvas, OrbitControls, Reference Planes, Shading, Sharp Edges
│   │   ├── ViewportPicker.js     # Raycaster, 3D to sketch plane projection, vertex & edge snapping
│   │
│   ├── components/
│   │   ├── layout/
│   │   │   ├── CommandManager.jsx # Ribbon toolbar (Features, Sketch, Surfaces, Assembly, Drawing, FEA)
│   │   │   ├── FeatureTree.jsx    # Feature Tree (history, planes, suppression, rollback)
│   │   │   ├── PropertyPanel.jsx  # Contextual property panel with parameter binding and debounced updates
│   │   │   ├── StatusBar.jsx      # MMGS units, grid/snap toggles, tool status
│   │   │   └── MainLayout.jsx     # Master flex layout
│   │   ├── dialogs/
│   │   │   ├── ExportDialog.jsx   # Multi-format CAD export (STEP, IGES, STL, DXF, OBJ)
│   │   │   ├── MaterialDialog.jsx # Searchable material database with physical properties
│   │   │   └── MassPropsDialog.jsx# Exact Volume, Mass, Center of Mass, Moments of Inertia
│   │   └── common/
│   │       └── NumericInput.jsx   # High-precision engineering spinner input with units
│   │
│   └── utils/
│       ├── math.js               # Linear algebra, BSP CSG polygon clipping, trigonometry
│       ├── constants.js          # Theme constants, tool IDs, material properties
│       ├── examples.js           # 8 production-grade parametric CAD example models
│       ├── debounce.js           # Debounce utility for responsive UI sliders
│       ├── projectFile.js        # Shared project save / open / new (.casiproj)
│       └── shortcuts.js          # Industry-standard keyboard shortcuts
└── tests/
    └── casiworks.test.js          # Automated verification tests (node --test)
```

---

## 🔬 What Actually Works (Verified Production Architecture)

CasiWorks Pro implements real, verified engineering algorithms rather than superficial UI mocks. The architecture is tested and verified across 8 core engineering pillars:

### 1. Real Feature Tree & Parametric Dependency Graph
- **Directed Acyclic Graph (DAG)**: Features maintain explicit `parentIds` and `childIds` associations. Sketches act as foundational parents to extrusions, cuts, revolves, sweeps, lofts, fillets, and chamfers.
- **Rollback Bar**: The feature history tree features an interactive rollback bar (`rollbackIndex`). Dragging or clicking any position rolls back evaluation to that historical state without destroying downstream feature definitions, allowing upstream parameter adjustments that recalculate downstream upon roll-forward.
- **Cascading Suppress & Unsuppress**: Suppressing an upstream feature automatically cascades suppression through all downstream children in the dependency chain. Conversely, unsuppressing a downstream feature automatically restores any required parent features.
- **Live Rebuild Loop**: Powered by Zustand and Immer, model mutations trigger `rebuildModel` in `FeatureEngine.js`. The engine sequentially regenerates solid bodies, computes `THREE.EdgesGeometry` for crisp feature edge contours, updates bounding boxes, and recalculates physical mass properties.

### 2. Industrial-Strength 2D Constraint Solver
- **Levenberg-Marquardt with Householder QR Decomposition**: Built in `src/kernel/ConstraintSolver.js`, the solver computes a 2nd-order central-difference numerical Jacobian $\mathbf{J}$ ($m_{\text{constraints}} \times n_{\text{vars}}$) and solves the augmented least-squares system via Householder QR decomposition with column pivoting:
  $$\min \left\| \begin{bmatrix} \mathbf{J} \\ \sqrt{\lambda} \mathbf{I} \\ \sqrt{\mu} \mathbf{I} \end{bmatrix} \Delta \mathbf{x} - \begin{bmatrix} -\mathbf{r} \\ \mathbf{0} \\ -\sqrt{\mu}(\mathbf{x} - \mathbf{x}_0) \end{bmatrix} \right\|_2^2$$
  where $\lambda$ is an adaptive Levenberg-Marquardt damping factor and $\mu$ is Tikhonov regularization anchoring the solution to initial geometry.
- **Degrees of Freedom (DOF) Analysis**: Evaluates numerical rank of $\mathbf{J}$ from diagonal elements of $\mathbf{R}$ after QR column pivoting. Computes remaining degrees of freedom:
  $$\text{DOF} = n_{\text{vars}} - \text{rank}(\mathbf{J})$$
  and classifies sketch state into `under_constrained`, `fully_constrained`, or `over_constrained`.
- **Over-Constrained & Conflict Diagnostics**: Distinguishes between redundant constraints (linearly dependent equations with zero residual) and inconsistent/conflicting constraints (non-zero residual, e.g. conflicting dimensions), returning diagnostic objects `{ type: 'conflict', constraintIds: [...] }`.
- **Complete Constraint Catalog**: `COINCIDENT`, `HORIZONTAL`, `VERTICAL`, `PARALLEL`, `PERPENDICULAR`, `EQUAL`, `FIX`, `MIDPOINT`, `CONCENTRIC`, `COLINEAR`, `TANGENT`, `DIMENSION` (distance, radius, diameter), `ANGLE`, and `SYMMETRIC`.

### 3. Boundary Representation (B-Rep) Topology Kernel
- **Topological Data Structure** (`src/kernel/Topology.js`):
  - `Vertex`: 0D topological element representing a geometric point, tracking incident edges.
  - `Edge`: 1D topological boundary bounded by start/end vertices, binding to geometric curves (`LineCurve`, `ArcCurve`, `NurbsCurve`).
  - `CoEdge`: Directed half-edge inside loops, tracking forward/reverse orientation, loop parent, face parent, next/prev pointers, and mate partner references.
  - `Loop`: Closed sequence of directed coedges, classifying outer boundary wires vs inner hole wires, computing area via Stokes' theorem.
  - `Face`: 2D bounded surface (`PlaneSurface`, `CylinderSurface`, `ConeSurface`, `TorusSurface`, `SphereSurface`), outer loop, hole loops, orientation, normal calculation, and ear-clipping triangulation with hole bridging.
  - `Shell`: Connected collection of stitched faces, 2-manifold check (each edge shared by exactly 2 faces with opposite orientations), Euler characteristic ($\chi = V - E + F$), genus ($G = (2 - \chi) / 2$), and volume via divergence theorem.
  - `SolidBody`: 3D topological manifold solid bounded by one outer shell and internal cavity void shells. Verifies the Euler-Poincaré formula:
    $$V - E + F = 2(S - G)$$
    where $S$ is the number of shells and $G$ is the total genus.
- **Physical Mass Properties**: Computes exact volume, surface area, center of mass (centroid) via tetrahedral decomposition, and the full 3D moments of inertia tensor:
  $$\mathbf{I} = \begin{bmatrix} I_{xx} & I_{xy} & I_{xz} \\ I_{xy} & I_{yy} & I_{yz} \\ I_{xz} & I_{yz} & I_{zz} \end{bmatrix}$$

### 4. Advanced 3D Solid Modeling Operations
- **Extrude** (`extrudeSolid`): Generates clean solid bodies with top, bottom, and lateral quad faces stitched into a closed shell; supports inner hole wire loops and midplane/symmetric end conditions.
- **Revolve** (`revolveSolid`): Full 360° rotational solids and partial revolutions with automatically capped planar start and end faces.
- **Sweep** (`sweepSolid`): Sweeps arbitrary 2D profiles along 3D space curves using double-reflection **Rotation-Minimizing Frames (RMF)** to eliminate unwanted axial twisting.
- **Loft** (`loftSolid`): Multi-section interpolation between distinct 2D/3D cross-sections with polyline resampling and quad facet bridging.
- **Fillet & Chamfer** (`filletSolid`, `chamferSolid`): Procedural edge rounding and beveling with cylindrical/planar blend face insertion and topological shell re-stitching.
- **Shell** (`shellSolid`): Creates uniform hollow interiors; generates internal cavity void shells with reversed normals for closed bodies, or rim lips for open-face container hollowing.
- **Boolean Operations** (`booleanUnion`, `booleanSubtract`, `booleanIntersect`): Robust polygon and boundary classification using BSP CSG trees, reconstructing clean manifold solids.

### 5. Multi-Body Assembly Mate Engine
- **Kinematic Mates** (`src/assembly/AssemblyManager.js`):
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

### 6. 3D Solid Linear Static FEA Simulation
- **3D Tetrahedral Meshing** (`src/simulation/FEAEngine.js`):
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

### 7. 2D Engineering Drawings Engine
- **Orthographic Projections** (`src/drawings/DrawingEngine.js`):
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

### 8. Full CAD Data Exchange (STEP, IGES, STL, DXF)
- **ISO 10303-21 STEP (AP214 / AP242)**:
  - Full B-Rep solid entities: `MANIFOLD_SOLID_BREP`, `ADVANCED_BREP_SHAPE_REPRESENTATION`, `ORIENTED_EDGE`, `EDGE_LOOP`, `ADVANCED_FACE`, `PLANE` surface definitions, and `MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION` with RGB styling.
  - Bidirectional parser in `ImportEngine.js` reconstructing 3D geometries.
- **IGES 5.3 (Initial Graphics Exchange Specification)**:
  - 80-column fixed records (Start S, Global G, Directory Entry D, Parameter Data P, Terminate T).
  - Supports Entity 186 (Manifold Solid B-Rep Object - MSBO), 514 (Shell), 510 (Face), 508 (Loop), 504 (Edge), 502 (Vertex List), 128 (Rational B-Spline Surface).
  - Bidirectional parser reconstructing faces and meshes.
- **Binary & ASCII STL**:
  - IEEE 754 32-bit floating point normal and triangle arrays with exact coordinate preservation.
- **AutoCAD DXF**:
  - 2D sketch entities (`LINE`, `CIRCLE`, `ARC`, `RECT`, `POINT`) and 3D wireframe mesh (`3DFACE`).
- **Lossless Project JSON**:
  - Full serialization and restoration of feature history, sketch entities, geometric constraints, dimensions, materials, and assembly mates.

---

## 🧪 Verification & Test Suite

CasiWorks Pro is verified through an automated test suite (`tests/casiworks.test.js`) executed with Node.js test runner:

```bash
npm test
```

### Coverage (31 tests, all passing)
- **Constraint solver**: coupled systems, equal/parallel constraints, DOF analysis, conflict detection, numerical edge cases
- **Feature engine**: midplane/through extrudes, rollback, thin features, suppressed-sketch propagation, missing-sketch errors
- **B-Rep topology and solid ops**: Euler-Poincaré, 2-manifold checks, revolve/sweep/loft, fillet/chamfer/shell, boolean CSG
- **Assembly**: coincident, distance, concentric, parallel, perpendicular, tangent, width, path mates; degenerate cases
- **Data exchange**: STL, DXF, STEP AP214/AP242 and IGES 5.3 round-trips; IGES Global-section Hollerith validity
- **FEA**: cantilever deflection vs. Euler-Bernoulli analytical solution, Tet4/Tet10 stiffness and stress tensor
- **Drawings**: orthographic projection with hidden-line removal, dimensions, GD&T, SVG/DXF export
- **Application state**: add/remove/suppress on every built-in example, project save/load round-trip, atomic rejection of invalid files

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
   - Export: **STEP AP214/AP242 B-Rep**, **IGES 5.3 MSBO**, **STL (Binary & ASCII)**, **AutoCAD DXF**, **Wavefront OBJ**, and Native Project JSON.
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
