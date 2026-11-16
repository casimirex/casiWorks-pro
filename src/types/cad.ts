// CasiWorks Pro - Core domain types
//
// Single source of truth for the shape of CAD data: sketch entities, features,
// mass properties and project files. Units: millimetres, radians inside sketch
// entities (the public API converts from degrees), kg, kg/m³.

import type { AppMode, AppSettings, FeatureType } from '../utils/constants.ts';

// ---------------------------------------------------------------- geometry primitives
export interface Point2 {
  x: number;
  y: number;
}

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

/** A sketch point; `z` is kept when imported from 3D files (e.g. DXF) and ignored by the sketcher. */
export type SketchPoint = Point2 & { z?: number };

/** Standard sketch planes. */
export type SketchPlane = 'Front' | 'Top' | 'Right';

// ---------------------------------------------------------------- sketch entities
interface SketchEntityBase {
  id: string;
  /** Construction geometry is reference-only and never forms a profile. */
  construction?: boolean;
}

export interface LineEntity extends SketchEntityBase {
  type: 'line';
  p1: SketchPoint;
  p2: SketchPoint;
}

export interface CircleEntity extends SketchEntityBase {
  type: 'circle';
  center: SketchPoint;
  radius: number;
}

export interface ArcEntity extends SketchEntityBase {
  type: 'arc';
  center: SketchPoint;
  radius: number;
  /** Radians, counter-clockwise from +X. */
  startAngle: number;
  /** Radians, counter-clockwise from +X. */
  endAngle: number;
}

export interface PointEntity extends SketchEntityBase {
  type: 'point';
  x: number;
  y: number;
  z?: number;
}

export interface SplineEntity extends SketchEntityBase {
  type: 'spline';
  controlPoints: Point2[];
}

export interface EllipseEntity extends SketchEntityBase {
  type: 'ellipse';
  center: SketchPoint;
  radiusX: number;
  radiusY: number;
  /** Radians. */
  rotation: number;
}

/** Every entity the sketcher creates. Rectangles and polygons are stored as lines. */
export type SketchEntity = LineEntity | CircleEntity | ArcEntity | PointEntity | SplineEntity | EllipseEntity;

// ---------------------------------------------------------------- features
export type ExtrudeEndCondition = 'blind' | 'midplane' | 'throughall';

interface FeatureBase {
  id: string;
  name: string;
  suppressed?: boolean;
  visible?: boolean;
  /** Features this one depends on (filled in by the store). */
  parentIds?: string[];
  /** Features that depend on this one (rebuilt by the store from parentIds). */
  childIds?: string[];
  timestamp?: number;
  /** Parameters driven by equations: parameter name → expression (e.g. { depth: '2 * wall' }). */
  expressions?: Record<string, string>;
}

export interface SketchFeature extends FeatureBase {
  type: 'sketch';
  sketchId: string;
  plane: SketchPlane;
}

export interface ExtrudeFeature extends FeatureBase {
  type: 'extrude_boss' | 'extrude_cut';
  sketchId: string;
  depth: number;
  direction?: ExtrudeEndCondition;
  flip?: boolean;
  /** Thin feature: extrude the sketch as a wall of `wallThickness`. */
  thin?: boolean;
  wallThickness?: number;
}

export interface RevolveFeature extends FeatureBase {
  type: 'revolve_boss' | 'revolve_cut';
  sketchId: string;
  /** Degrees. */
  angle: number;
}

export interface SweepFeature extends FeatureBase {
  type: 'sweep_boss' | 'sweep_cut';
  sketchId: string;
  pathPoints?: Point3[];
}

export interface LoftFeature extends FeatureBase {
  type: 'loft_boss' | 'loft_cut';
  /** Sketch ids of the profiles, in order. */
  profiles?: string[];
  height?: number;
}

export interface FilletFeature extends FeatureBase {
  type: 'fillet';
  radius: number;
}

export interface ChamferFeature extends FeatureBase {
  type: 'chamfer';
  distance: number;
}

export interface ShellFeature extends FeatureBase {
  type: 'shell';
  thickness: number;
}

export interface HoleFeature extends FeatureBase {
  type: 'hole';
  diameter: number;
  depth: number;
  /** Entry point of the hole (default: the origin). */
  position?: Point3;
  /** Drilling direction from the entry point (default +Z). */
  axis?: Point3;
  holeType?: 'simple' | 'counterbore' | 'countersink';
}

export interface LinearPatternFeature extends FeatureBase {
  type: 'linear_pattern';
  count: number;
  spacing: number;
  directionX?: number;
  directionY?: number;
  directionZ?: number;
}

export interface CircularPatternFeature extends FeatureBase {
  type: 'circular_pattern';
  count: number;
  /** Degrees. */
  angle: number;
  axisX?: number;
  axisY?: number;
  axisZ?: number;
}

export interface MirrorFeature extends FeatureBase {
  type: 'mirror';
  plane: SketchPlane;
}

export interface BooleanFeature extends FeatureBase {
  type: 'boolean';
  operation: 'union' | 'subtract' | 'cut' | 'intersect';
  toolFeatureId: string;
}

export interface ReferenceFeature extends FeatureBase {
  type: 'reference_plane' | 'reference_axis';
}

/** A feature as authored or saved (dependency links may be missing). */
export type FeatureData =
  | SketchFeature
  | ExtrudeFeature
  | RevolveFeature
  | SweepFeature
  | LoftFeature
  | FilletFeature
  | ChamferFeature
  | ShellFeature
  | HoleFeature
  | LinearPatternFeature
  | CircularPatternFeature
  | MirrorFeature
  | BooleanFeature
  | ReferenceFeature;

/** A feature held by the store: dependency links are always present. */
export type Feature = FeatureData & { parentIds: string[]; childIds: string[] };

/** Compile-time check: fails to type-check if a FeatureType has no FeatureData variant. */
type AssertNever<T extends never> = T;
export type _AllFeatureTypesCovered = AssertNever<Exclude<FeatureType, FeatureData['type']>>;

/** Map of sketch id → entities. */
export type SketchEntityMap = Record<string, SketchEntity[]>;

// ---------------------------------------------------------------- results
export interface RebuildError {
  featureId: string | null;
  featureName: string | null;
  error: string;
}

export interface InertiaTensor {
  Ixx: number;
  Iyy: number;
  Izz: number;
  /** Product of inertia ∫x·y dm (the tensor off-diagonal is −Ixy). */
  Ixy: number;
  Ixz: number;
  Iyz: number;
}

export interface BoundingBox {
  min: Point3;
  max: Point3;
  size: Point3;
}

export interface MassProperties {
  /** mm³ */
  volume: number;
  /** mm² */
  surfaceArea: number;
  /** kg */
  mass: number;
  /** kg/m³ */
  density: number;
  /** mm */
  centerOfMass: Point3;
  /** kg·mm², about the center of mass */
  momentOfInertia: InertiaTensor;
  /** kg·mm², about the model origin */
  momentOfInertiaAtOrigin: InertiaTensor;
  boundingBox: BoundingBox;
  units: { length: 'mm'; mass: 'kg'; density: 'kg/m^3'; inertia: 'kg*mm^2' };
}

// ---------------------------------------------------------------- documents
/** A built-in example model (see utils/examples.ts). */
export interface ExampleModel {
  documentName: string;
  activeMaterial: string;
  rollbackIndex: number;
  sketchEntities: SketchEntityMap;
  features: FeatureData[];
}

/** The .casiproj file format (version 2). */
export interface ProjectFile {
  version: string;
  documentName: string;
  appMode: AppMode;
  features: FeatureData[];
  sketchEntities: SketchEntityMap;
  sketchConstraints: Record<string, unknown[]>;
  sketchDimensions: Record<string, unknown[]>;
  rollbackIndex: number;
  activeMaterial: string;
  settings: AppSettings;
  assemblyComponents: unknown[];
  mates: unknown[];
  /** Global variables (equations); absent in older files. */
  variables?: Array<{ name: string; expression: string }>;
  timestamp: number;
}
