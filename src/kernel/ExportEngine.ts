// CasiWorks Pro - Export Engine
// Supports STEP AP214/AP242 B-Rep Solids, IGES 5.3 MSBO, STL (Binary & ASCII), OBJ, DXF (R12/2000/2018), and JSON
import * as THREE from 'three';
import { downloadBlob } from '../utils/download.ts';

export interface DXFOptions {
  /** 'R12' | '2000' | '2018' (or the AutoCAD codes AC1009 / AC1015 / AC1032). */
  version?: string;
}
export interface STEPOptions {
  /** Default AP214 (automotive_design). */
  schema?: 'AP214' | 'AP242';
  /** Display colour, 0..1 per channel. */
  colorR?: number;
  colorG?: number;
  colorB?: number;
}
export type IGESOptions = Record<string, never>;

/** 2D sketch entity as written to DXF (accepts the point entity's flat x/y). */
export interface DXFEntity {
  type: string;
  p1?: { x: number; y: number; z?: number };
  p2?: { x: number; y: number; z?: number };
  center?: { x: number; y: number; z?: number };
  radius?: number;
  startAngle?: number;
  endAngle?: number;
  x?: number;
  y?: number;
  z?: number;
}

type Vec3 = [number, number, number];

/** Weld coincident vertices (1e-6 mm) and drop degenerate triangles. */
export function weldMesh(geometry: THREE.BufferGeometry): { points: Vec3[]; triangles: Vec3[] } {
  const pos = geometry.getAttribute('position');
  const index = geometry.index;
  const points: Vec3[] = [];
  const lookup = new Map<string, number>();
  const q = (v: number) => (Math.round(v * 1e6) / 1e6 + 0);
  const vertexId = (i: number): number => {
    const p: Vec3 = [q(pos.getX(i)), q(pos.getY(i)), q(pos.getZ(i))];
    const key = p.join(',');
    let id = lookup.get(key);
    if (id === undefined) {
      id = points.length;
      points.push(p);
      lookup.set(key, id);
    }
    return id;
  };
  const triangles: Vec3[] = [];
  const count = pos ? (index ? index.count : pos.count) : 0;
  for (let t = 0; t + 2 < count; t += 3) {
    const tri: Vec3 = [0, 1, 2].map(k => vertexId(index ? index.getX(t + k) : t + k)) as Vec3;
    if (tri[0] !== tri[1] && tri[1] !== tri[2] && tri[0] !== tri[2]) triangles.push(tri);
  }
  return { points, triangles };
}

function triangleNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  return [n[0] / len, n[1] / len, n[2] / len];
}

/** STEP REAL: always contains a decimal point; no exponent-less precision loss. */
function stepReal(v: number): string {
  if (!Number.isFinite(v)) return '0.';
  const s = (Math.round(v * 1e6) / 1e6 + 0).toString();
  return s.includes('.') || s.includes('e') ? s.replace('e', 'E') : s + '.';
}

/** IGES real: decimal point always present. */
function igesReal(v: number): string {
  if (!Number.isFinite(v)) return '0.0';
  const s = (Math.round(v * 1e6) / 1e6 + 0).toString();
  return s.includes('.') || s.includes('e') ? s.replace('e', 'D') : s + '.0';
}

export class ExportEngine {
  /**
   * Export Three.js BufferGeometry to STL format (Binary or ASCII) with exact normal preservation
   * @param {THREE.BufferGeometry} geometry
   * @param {boolean} binary
   * @returns {Blob}
   */
  exportSTL(geometry: THREE.BufferGeometry | null | undefined, binary = true): Blob {
    if (!geometry) throw new Error('No geometry provided for STL export');
    const geom = geometry.index ? geometry.toNonIndexed() : geometry;
    const pos = geom.getAttribute('position');
    const numTriangles = pos ? Math.floor(pos.count / 3) : 0;

    // Facet normals are always computed from the triangle (stored vertex normals
    // may be smoothed across curved walls, which is wrong for STL facets)
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const facet = (t: number) => {
      a.fromBufferAttribute(pos, t * 3);
      b.fromBufferAttribute(pos, t * 3 + 1);
      c.fromBufferAttribute(pos, t * 3 + 2);
      const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
      const len = n.length();
      return { n: len > 0 ? n.divideScalar(len) : n.set(0, 0, 1), verts: [a, b, c] };
    };
    const finite = (v: number) => (Number.isFinite(v) ? v : 0);

    if (binary) {
      const buffer = new ArrayBuffer(84 + numTriangles * 50);
      const writer = new DataView(buffer);
      // 80-byte header; must not start with "solid" (readers would treat the file as ASCII)
      const header = 'CasiWorks Pro binary STL (millimetres)';
      for (let i = 0; i < 80; i++) writer.setUint8(i, i < header.length ? header.charCodeAt(i) : 0x20);
      writer.setUint32(80, numTriangles, true);
      let offset = 84;
      for (let t = 0; t < numTriangles; t++) {
        const { n, verts } = facet(t);
        for (const v of [n, ...verts]) {
          writer.setFloat32(offset, finite(v.x), true);
          writer.setFloat32(offset + 4, finite(v.y), true);
          writer.setFloat32(offset + 8, finite(v.z), true);
          offset += 12;
        }
        writer.setUint16(offset, 0, true); // attribute byte count
        offset += 2;
      }
      return new Blob([buffer], { type: 'application/sla' });
    }

    const out: string[] = ['solid CasiWorksModel'];
    const f6 = (v: number) => finite(v).toFixed(6);
    for (let t = 0; t < numTriangles; t++) {
      const { n, verts } = facet(t);
      out.push(`  facet normal ${f6(n.x)} ${f6(n.y)} ${f6(n.z)}`, '    outer loop');
      for (const v of verts) out.push(`      vertex ${f6(v.x)} ${f6(v.y)} ${f6(v.z)}`);
      out.push('    endloop', '  endfacet');
    }
    out.push('endsolid CasiWorksModel', '');
    return new Blob([out.join('\n')], { type: 'text/plain' });
  }

  /**
   * Export BufferGeometry to Wavefront OBJ format
   */
  exportOBJ(geometry: THREE.BufferGeometry | null | undefined, objectName = 'CasiWorksModel'): Blob {
    if (!geometry) throw new Error('No geometry for OBJ export');
    let geom = geometry.clone();
    if (geom.index) geom = geom.toNonIndexed();

    if (!geom.getAttribute('normal')) {
      geom.computeVertexNormals();
    }

    const posAttr = geom.getAttribute('position');
    const normalAttr = geom.getAttribute('normal');

    let output = `# CasiWorks Pro Wavefront OBJ Export\n# Object: ${objectName}\n\no ${objectName}\n\n`;

    // Vertices
    for (let i = 0; i < posAttr.count; i++) {
      output += `v ${posAttr.getX(i).toFixed(6)} ${posAttr.getY(i).toFixed(6)} ${posAttr.getZ(i).toFixed(6)}\n`;
    }

    // Normals
    if (normalAttr) {
      output += '\n';
      for (let i = 0; i < normalAttr.count; i++) {
        output += `vn ${normalAttr.getX(i).toFixed(6)} ${normalAttr.getY(i).toFixed(6)} ${normalAttr.getZ(i).toFixed(6)}\n`;
      }
    }

    // Faces
    output += '\ns 1\n';
    for (let i = 0; i < posAttr.count; i += 3) {
      const idx1 = i + 1;
      const idx2 = i + 2;
      const idx3 = i + 3;
      if (normalAttr) {
        output += `f ${idx1}//${idx1} ${idx2}//${idx2} ${idx3}//${idx3}\n`;
      } else {
        output += `f ${idx1} ${idx2} ${idx3}\n`;
      }
    }

    return new Blob([output], { type: 'text/plain' });
  }

  /**
   * Export 2D sketch entities and/or 3D wireframe mesh to AutoCAD DXF format
   * Supports versions: 'R12' (AC1009), '2000' (AC1015), '2018' (AC1032)
   * @param {Array|THREE.BufferGeometry} entitiesOrGeometry
   * @param {Object} options
   * @returns {Blob}
   */
  exportDXF(entitiesOrGeometry: THREE.BufferGeometry | Array<DXFEntity | null> | null | undefined, options: DXFOptions = {}): Blob {
    // R12 by default: this writer emits the R12 structure (no handles, classes or
    // object tables), which newer AutoCAD versions reject when labelled 2000+.
    const version = (options.version || 'R12').toUpperCase();
    let acadVer = 'AC1009';
    if (version === '2000' || version === 'AC1015') acadVer = 'AC1015';
    else if (version === '2018' || version === 'AC1032') acadVer = 'AC1032';

    // Defensive coordinate formatting: handles negative decimals, zero without -0, and guards against NaNs
    const formatCoord = (val: number | string | undefined) => {
      const num = typeof val === 'number' ? val : parseFloat(String(val));
      if (isNaN(num) || !isFinite(num)) return '0.0000';
      const fixed = num.toFixed(4);
      return (fixed === '-0.0000' || fixed === '-0') ? '0.0000' : fixed;
    };

    let dxf = `0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\n${acadVer}\n9\n$INSUNITS\n70\n4\n0\nENDSEC\n`;
    dxf += `0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n70\n1\n0\nLAYER\n2\n0\n70\n0\n62\n7\n6\nCONTINUOUS\n0\nENDTAB\n0\nENDSEC\n`;
    dxf += `0\nSECTION\n2\nENTITIES\n`;

    // Handle 3D geometry export as DXF 3DFACE
    const isGeometry = (v: unknown): v is THREE.BufferGeometry =>
      !!v && typeof v === 'object' && (('isBufferGeometry' in v && !!v.isBufferGeometry) || 'getAttribute' in v);
    if (isGeometry(entitiesOrGeometry)) {
      let geom = entitiesOrGeometry.clone();
      if (geom.index) geom = geom.toNonIndexed();
      const pos = geom.getAttribute('position');

      if (pos && pos.count >= 3) {
        for (let i = 0; i < pos.count; i += 3) {
          const x1 = formatCoord(pos.getX(i)), y1 = formatCoord(pos.getY(i)), z1 = formatCoord(pos.getZ(i));
          const x2 = formatCoord(pos.getX(i + 1)), y2 = formatCoord(pos.getY(i + 1)), z2 = formatCoord(pos.getZ(i + 1));
          const x3 = formatCoord(pos.getX(i + 2)), y3 = formatCoord(pos.getY(i + 2)), z3 = formatCoord(pos.getZ(i + 2));

          dxf += `0\n3DFACE\n8\n0\n`;
          dxf += `10\n${x1}\n20\n${y1}\n30\n${z1}\n`;
          dxf += `11\n${x2}\n21\n${y2}\n31\n${z2}\n`;
          dxf += `12\n${x3}\n22\n${y3}\n32\n${z3}\n`;
          dxf += `13\n${x3}\n23\n${y3}\n33\n${z3}\n`; // Quad face closed on 3rd vertex
        }
      }
    } else if (Array.isArray(entitiesOrGeometry)) {
      // 2D sketch entities
      for (const ent of entitiesOrGeometry) {
        if (!ent) continue;
        if (ent.type === 'line' && ent.p1 && ent.p2) {
          dxf += `0\nLINE\n8\n0\n`;
          dxf += `10\n${formatCoord(ent.p1.x)}\n20\n${formatCoord(ent.p1.y)}\n30\n${formatCoord(ent.p1.z || 0.0)}\n`;
          dxf += `11\n${formatCoord(ent.p2.x)}\n21\n${formatCoord(ent.p2.y)}\n31\n${formatCoord(ent.p2.z || 0.0)}\n`;
        } else if (ent.type === 'circle' && ent.center) {
          dxf += `0\nCIRCLE\n8\n0\n`;
          dxf += `10\n${formatCoord(ent.center.x)}\n20\n${formatCoord(ent.center.y)}\n30\n${formatCoord(ent.center.z || 0.0)}\n`;
          dxf += `40\n${formatCoord(ent.radius || 10.0)}\n`;
        } else if (ent.type === 'arc' && ent.center) {
          dxf += `0\nARC\n8\n0\n`;
          dxf += `10\n${formatCoord(ent.center.x)}\n20\n${formatCoord(ent.center.y)}\n30\n${formatCoord(ent.center.z || 0.0)}\n`;
          dxf += `40\n${formatCoord(ent.radius || 10.0)}\n`;
          const sDeg = formatCoord(((ent.startAngle || 0) * 180) / Math.PI);
          const eDeg = formatCoord(((ent.endAngle || 0) * 180) / Math.PI);
          dxf += `50\n${sDeg}\n51\n${eDeg}\n`;
        } else if (ent.type === 'rect' && ent.p1 && ent.p2) {
          // Closed 4-line rectangle
          const pts = [
            { x: ent.p1.x, y: ent.p1.y },
            { x: ent.p2.x, y: ent.p1.y },
            { x: ent.p2.x, y: ent.p2.y },
            { x: ent.p1.x, y: ent.p2.y },
          ];
          for (let k = 0; k < 4; k++) {
            const next = pts[(k + 1) % 4];
            dxf += `0\nLINE\n8\n0\n`;
            dxf += `10\n${formatCoord(pts[k].x)}\n20\n${formatCoord(pts[k].y)}\n30\n0.0000\n`;
            dxf += `11\n${formatCoord(next.x)}\n21\n${formatCoord(next.y)}\n31\n0.0000\n`;
          }
        } else if (ent.type === 'point' && ent.x !== undefined) {
          dxf += `0\nPOINT\n8\n0\n`;
          dxf += `10\n${formatCoord(ent.x)}\n20\n${formatCoord(ent.y)}\n30\n${formatCoord(ent.z || 0.0)}\n`;
        }
      }
    }

    dxf += `0\nENDSEC\n0\nEOF\n`;
    return new Blob([dxf], { type: 'application/dxf' });
  }

  /**
   * ISO 10303-21 STEP file with the solid as a faceted B-rep (FACETED_BREP of
   * triangular POLY_LOOP faces over shared points). This is the standard STEP
   * representation for a triangulated solid; it is exact for the mesh but not
   * for the original curved surfaces (those need the exact kernel, Phase 2).
   * Every triangle is written — there is no face limit.
   */
  exportSTEP(geometry: THREE.BufferGeometry | null | undefined, modelName = 'CASIWORKS_PART', options: STEPOptions = {}): Blob {
    if (!geometry) throw new Error('No geometry for STEP export');
    const { points, triangles } = weldMesh(geometry);
    const name = String(modelName || 'CASIWORKS_PART').replace(/[^a-zA-Z0-9_-]/g, '_');
    const ap242 = options.schema === 'AP242';
    const schema = ap242
      ? "AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF { 1 0 10303 442 1 1 4 }"
      : 'AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }';
    const apName = ap242 ? 'ap242_managed_model_based_3d_engineering' : 'automotive_design';
    const timestamp = new Date().toISOString().slice(0, 19);
    const color = [options.colorR ?? 0.22, options.colorG ?? 0.74, options.colorB ?? 0.97].map(c => stepReal(Math.min(1, Math.max(0, c))));

    const out: string[] = [];
    out.push('ISO-10303-21;', 'HEADER;',
      `FILE_DESCRIPTION(('CasiWorks Pro faceted solid (triangulated mesh, ${triangles.length} faces)'),'2;1');`,
      `FILE_NAME('${name}.stp','${timestamp}',(''),(''),'CasiWorks Pro','CasiWorks Pro STEP writer','');`,
      `FILE_SCHEMA(('${schema}'));`, 'ENDSEC;', 'DATA;',
      "#1=APPLICATION_CONTEXT('mechanical design');",
      `#2=APPLICATION_PROTOCOL_DEFINITION('international standard','${apName}',${ap242 ? 2014 : 2000},#1);`,
      "#3=PRODUCT_CONTEXT('',#1,'mechanical');",
      `#4=PRODUCT('${name}','${name}','',(#3));`,
      "#5=PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(#4));",
      "#6=PRODUCT_DEFINITION_FORMATION('','',#4);",
      "#7=PRODUCT_DEFINITION_CONTEXT('part definition',#1,'design');",
      "#8=PRODUCT_DEFINITION('design','',#6,#7);",
      "#9=PRODUCT_DEFINITION_SHAPE('','',#8);",
      '#10=SHAPE_DEFINITION_REPRESENTATION(#9,#11);',
      `#11=FACETED_BREP_SHAPE_REPRESENTATION('${name}',(#12,#13),#14);`,
      "#12=AXIS2_PLACEMENT_3D('',#15,#16,#17);",
      `#13=FACETED_BREP('${name}',#18);`,
      "#14=(GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#19)) GLOBAL_UNIT_ASSIGNED_CONTEXT((#20,#21,#22)) REPRESENTATION_CONTEXT('',''));",
      "#15=CARTESIAN_POINT('',(0.,0.,0.));",
      "#16=DIRECTION('',(0.,0.,1.));",
      "#17=DIRECTION('',(1.,0.,0.));",
    );

    // Shared points, then one FACE per triangle
    let id = 30;
    const pointIds = points.map(() => id++);
    const body: string[] = points.map((p, i) => `#${pointIds[i]}=CARTESIAN_POINT('',(${stepReal(p[0])},${stepReal(p[1])},${stepReal(p[2])}));`);
    const faceIds: number[] = [];
    for (const [a, b, c] of triangles) {
      const loop = id++;
      const bound = id++;
      const face = id++;
      body.push(
        `#${loop}=POLY_LOOP('',(#${pointIds[a]},#${pointIds[b]},#${pointIds[c]}));`,
        `#${bound}=FACE_OUTER_BOUND('',#${loop},.T.);`,
        `#${face}=FACE('',(#${bound}));`,
      );
      faceIds.push(face);
    }

    out.push(`#18=CLOSED_SHELL('',(${faceIds.map(f => '#' + f).join(',')}));`,
      "#19=UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-06),#20,'distance_accuracy_value','');",
      '#20=(LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.));',
      '#21=(NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.));',
      '#22=(NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT());',
      ...body);

    // Colour (presentation)
    const [cRgb, cFill, cFillStyle, cArea, cSide, cUsage, cAssign, cStyled, cPres] = Array.from({ length: 9 }, () => id++);
    out.push(
      `#${cRgb}=COLOUR_RGB('',${color.join(',')});`,
      `#${cFill}=FILL_AREA_STYLE_COLOUR('',#${cRgb});`,
      `#${cFillStyle}=FILL_AREA_STYLE('',(#${cFill}));`,
      `#${cArea}=SURFACE_STYLE_FILL_AREA(#${cFillStyle});`,
      `#${cSide}=SURFACE_SIDE_STYLE('',(#${cArea}));`,
      `#${cUsage}=SURFACE_STYLE_USAGE(.BOTH.,#${cSide});`,
      `#${cAssign}=PRESENTATION_STYLE_ASSIGNMENT((#${cUsage}));`,
      `#${cStyled}=STYLED_ITEM('',(#${cAssign}),#13);`,
      `#${cPres}=MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION('',(#${cStyled}),#14);`,
      'ENDSEC;', 'END-ISO-10303-21;', '');
    return new Blob([out.join('\n')], { type: 'application/step' });
  }

  /**
   * IGES 5.3 file with the solid as a Manifold Solid B-Rep Object (entity 186):
   * Vertex List (502/1), Edge List (504/1) with a Line (110) per edge, a Loop
   * (508/1) on a Plane (108/0) per triangle, Faces (510/1), a closed Shell
   * (514/1). Edges are shared between adjacent faces. Every triangle is
   * written — there is no face limit.
   */
  exportIGES(geometry: THREE.BufferGeometry | null | undefined, modelName = 'CASIWORKS_PART', _options: IGESOptions = {}): Blob {
    if (!geometry) throw new Error('No geometry for IGES export');
    const { points, triangles } = weldMesh(geometry);
    const name = String(modelName || 'CASIWORKS_PART').replace(/[,;]/g, '_');

    const pad = (v: unknown, len: number, left = true) => {
      const str = String(v ?? '');
      return (left ? str.padStart(len, ' ') : str.padEnd(len, ' ')).slice(0, len);
    };
    const seq = (section: string, n: number) => section + String(n).padStart(7, ' ');
    const H = (text: string) => `${text.length}H${text}`;

    // Wrap parameters into records of up to `width` characters without
    // splitting a parameter across records.
    const wrap = (params: string[], width: number): string[] => {
      const records: string[] = [];
      let current = '';
      params.forEach((p, i) => {
        const token = p + (i === params.length - 1 ? ';' : ',');
        if (current && current.length + token.length > width) {
          records.push(current);
          current = '';
        }
        current += token;
      });
      if (current) records.push(current);
      return records;
    };

    // ---- Start and Global sections
    const iso = new Date().toISOString();
    const timestamp = `${iso.slice(0, 10).replace(/-/g, '')}.${iso.slice(11, 19).replace(/:/g, '')}`;
    const maxCoord = points.reduce((m, p) => Math.max(m, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2])), 0);
    const startLines = [pad(`CasiWorks Pro IGES 5.3 export: ${name} (manifold solid B-rep of a triangulated mesh)`, 72, false) + seq('S', 1)];
    const global = [
      '1H,', '1H;', H(name), H(`${name}.igs`), H('CasiWorks Pro'), H('CasiWorks Pro IGES writer'),
      '32', '38', '6', '308', '15', // integer bits, single/double precision magnitude & significance
      H(name),        // 12 receiving system product id
      '1.0',          // 13 model space scale
      '2', H('MM'),   // 14-15 units flag and name (millimetres)
      '1', '1.0',     // 16-17 line weight gradations and maximum width
      H(timestamp),   // 18 file generation date
      '0.000001',     // 19 minimum resolution
      igesReal(Math.max(1, maxCoord)), // 20 maximum coordinate value
      H('CasiWorks Pro'), H('CasiWorks Pro'), // 21-22 author and organisation
      '11',           // 23 IGES version 5.3
      '0',            // 24 drafting standard
      H(timestamp),   // 25 model creation date
    ];
    const globalLines = wrap(global, 72).map((r, i) => pad(r, 72, false) + seq('G', i + 1));

    // ---- Directory and Parameter sections
    const dirLines: string[] = [];
    const paramLines: string[] = [];
    const add = (type: number, form: number, params: Array<string | number>, label: string, dependent = true): number => {
      const de = dirLines.length + 1;
      const firstParam = paramLines.length + 1;
      const records = wrap([String(type), ...params.map(String)], 64);
      for (const r of records) paramLines.push(pad(r, 64, false) + pad(de, 8) + seq('P', paramLines.length + 1));
      const status = dependent ? '00010000' : '00000000';
      dirLines.push(
        pad(type, 8) + pad(firstParam, 8) + pad(0, 8) + pad(0, 8) + pad(0, 8) + pad(0, 8) + pad(0, 8) + pad(0, 8) + pad(status, 8) + seq('D', de),
        pad(type, 8) + pad(0, 8) + pad(0, 8) + pad(records.length, 8) + pad(form, 8) + pad('', 8) + pad('', 8) + pad(label, 8, false) + pad(0, 8) + seq('D', de + 1),
      );
      return de;
    };

    // Vertex list (form 1)
    const vertexList = add(502, 1, [points.length, ...points.flatMap(p => p.map(igesReal))], 'VERTICES');

    // Undirected edges, each with a model-space line
    const edgeIndex = new Map<string, number>(); // "min_max" -> 1-based index in the edge list
    const edges: Array<[number, number]> = [];
    for (const tri of triangles) {
      for (let k = 0; k < 3; k++) {
        const a = tri[k];
        const b = tri[(k + 1) % 3];
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        if (!edgeIndex.has(key)) {
          edges.push(a < b ? [a, b] : [b, a]);
          edgeIndex.set(key, edges.length);
        }
      }
    }
    const lineDEs = edges.map(([a, b]) => add(110, 0, [...points[a], ...points[b]].map(igesReal), 'EDGECRV'));
    const edgeList = add(504, 1, [edges.length, ...edges.flatMap(([a, b], i) => [lineDEs[i], vertexList, a + 1, vertexList, b + 1])], 'EDGES');

    // One planar face per triangle
    const faceDEs: number[] = [];
    for (const tri of triangles) {
      const loopParams: Array<string | number> = [3];
      for (let k = 0; k < 3; k++) {
        const a = tri[k];
        const b = tri[(k + 1) % 3];
        const idx = edgeIndex.get(a < b ? `${a}_${b}` : `${b}_${a}`)!;
        // TYPE 0 = edge, edge list, index, orientation (1 agrees with the edge's direction), 0 parameter-space curves
        loopParams.push(0, edgeList, idx, a < b ? 1 : 0, 0);
      }
      const loop = add(508, 1, loopParams, 'LOOP');
      const [pa, pb, pc] = tri.map(i => points[i]);
      const n = triangleNormal(pa, pb, pc);
      const d = n[0] * pa[0] + n[1] * pa[1] + n[2] * pa[2];
      const plane = add(108, 0, [...n, d].map(igesReal).concat(['0', '0.0', '0.0', '0.0', '0.0']), 'PLANE');
      faceDEs.push(add(510, 1, [plane, 1, 1, loop], 'FACE'));
    }

    const shell = add(514, 1, [faceDEs.length, ...faceDEs.flatMap(f => [f, 1])], 'SHELL');
    add(186, 0, [shell, 1, 0], 'SOLID', false);

    const terminate = pad(`S${pad(startLines.length, 7)}G${pad(globalLines.length, 7)}D${pad(dirLines.length, 7)}P${pad(paramLines.length, 7)}`, 72, false) + seq('T', 1);
    const text = [...startLines, ...globalLines, ...dirLines, ...paramLines, terminate].join('\n') + '\n';
    return new Blob([text], { type: 'application/iges' });
  }

  downloadFile(blobOrString: Blob | string, filename: string, mimeType = 'text/plain'): void {
    downloadBlob(blobOrString, filename, mimeType);
  }
}

export const exportEngine = new ExportEngine();
export default ExportEngine;
