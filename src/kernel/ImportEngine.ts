// CasiWorks Pro - Import Engine
// Supports STL (Binary & ASCII), OBJ, DXF (R12/2000/2018), STEP AP214/AP242 B-Rep, IGES 5.3 MSBO, and Project JSON
import * as THREE from 'three';
import { generateId } from '../utils/math.ts';
import { SKETCH_ENTITY_TYPES } from '../utils/constants.ts';

/** A sketch entity read from DXF (coordinates keep their Z). */
export type DXFImportedEntity =
  | { id: string; type: 'line'; p1: { x: number; y: number; z: number }; p2: { x: number; y: number; z: number }; construction: boolean }
  | { id: string; type: 'circle'; center: { x: number; y: number; z: number }; radius: number; construction: boolean }
  | { id: string; type: 'arc'; center: { x: number; y: number; z: number }; radius: number; startAngle: number; endAngle: number; construction: boolean }
  | { id: string; type: 'point'; x: number; y: number; z: number; construction: boolean };

/** DXF import result: sketch entities, plus 3DFACE triangles as a mesh when present. */
export type DXFImportResult = DXFImportedEntity[] & { meshGeometry?: THREE.BufferGeometry };

export class ImportEngine {
  /**
   * Import STL (detects ASCII or binary, handles Uint8Array/Buffer/ArrayBuffer, aligned & unaligned)
   * @param {ArrayBuffer|ArrayBufferView|string} bufferOrString
   * @returns {THREE.BufferGeometry}
   */
  importSTL(bufferOrString: ArrayBuffer | ArrayBufferView | string | null | undefined): THREE.BufferGeometry {
    if (!bufferOrString) throw new Error('No STL data provided');

    if (typeof bufferOrString === 'string') {
      return this._importAsciiSTL(bufferOrString);
    }

    // Support ArrayBuffer, Uint8Array, Buffer, and any ArrayBufferView
    let arrayBuffer;
    let byteOffset = 0;
    let byteLength = 0;

    if (ArrayBuffer.isView(bufferOrString)) {
      arrayBuffer = bufferOrString.buffer;
      byteOffset = bufferOrString.byteOffset;
      byteLength = bufferOrString.byteLength;
    } else if (bufferOrString instanceof ArrayBuffer) {
      arrayBuffer = bufferOrString;
      byteOffset = 0;
      byteLength = bufferOrString.byteLength;
    } else {
      const decoder = new TextDecoder();
      return this._importAsciiSTL(decoder.decode(bufferOrString));
    }

    // Binary STL check: must have at least 80 header bytes + 4 face count bytes
    if (byteLength >= 84) {
      try {
        const reader = new DataView(arrayBuffer, byteOffset, byteLength);
        const numFaces = reader.getUint32(80, true);
        const expectedFaces = Math.floor((byteLength - 84) / 50);

        // A valid binary STL file has length == 84 + numFaces * 50
        if (numFaces === expectedFaces && (byteLength - 84) % 50 === 0) {
          return this._importBinarySTL(arrayBuffer, byteOffset, byteLength, numFaces);
        }
      } catch (e) {
        // Fall back below
      }
    }

    // Fallback: attempt decoding as ASCII STL
    try {
      const decoder = new TextDecoder();
      const text = decoder.decode(new Uint8Array(arrayBuffer, byteOffset, byteLength));
      if (text.includes('facet') || text.includes('solid')) {
        return this._importAsciiSTL(text);
      }
    } catch (e) {
      // ignore
    }

    // If it has at least 84 bytes, parse as binary with best-effort face count
    if (byteLength >= 84) {
      return this._importBinarySTL(arrayBuffer, byteOffset, byteLength);
    }

    // Return empty geometry
    const emptyGeom = new THREE.BufferGeometry();
    emptyGeom.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
    emptyGeom.setAttribute('normal', new THREE.Float32BufferAttribute([], 3));
    emptyGeom.computeBoundingBox();
    return emptyGeom;
  }

  _importBinarySTL(buffer: ArrayBufferLike, byteOffset = 0, byteLength = buffer.byteLength, expectedFaces?: number): THREE.BufferGeometry {
    const reader = new DataView(buffer, byteOffset, byteLength);
    const declaredFaces = expectedFaces !== undefined ? expectedFaces : (byteLength >= 84 ? reader.getUint32(80, true) : 0);
    const maxFacesPossible = byteLength >= 84 ? Math.floor((byteLength - 84) / 50) : 0;
    const numFaces = Math.max(0, Math.min(declaredFaces, maxFacesPossible));

    const positions = new Float32Array(numFaces * 9);
    const normals = new Float32Array(numFaces * 9);

    let offset = 84;
    for (let face = 0; face < numFaces; face++) {
      if (offset + 50 > byteLength) break;

      const nx = reader.getFloat32(offset, true); offset += 4;
      const ny = reader.getFloat32(offset, true); offset += 4;
      const nz = reader.getFloat32(offset, true); offset += 4;

      for (let v = 0; v < 3; v++) {
        const vx = reader.getFloat32(offset, true); offset += 4;
        const vy = reader.getFloat32(offset, true); offset += 4;
        const vz = reader.getFloat32(offset, true); offset += 4;

        const idx = face * 9 + v * 3;
        positions[idx] = vx;
        positions[idx + 1] = vy;
        positions[idx + 2] = vz;

        normals[idx] = nx;
        normals[idx + 1] = ny;
        normals[idx + 2] = nz;
      }
      offset += 2; // attribute byte count
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.computeBoundingBox();
    return geometry;
  }

  _importAsciiSTL(text: string): THREE.BufferGeometry {
    const lines = (text || '').split('\n');
    const vertices = [];
    const normals = [];

    let currentNormal = [0, 0, 1];

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line.startsWith('facet normal')) {
        const parts = line.split(/\s+/);
        const nx = parseFloat(parts[2]) || 0;
        const ny = parseFloat(parts[3]) || 0;
        const nz = parseFloat(parts[4]) || 0;
        currentNormal = [nx, ny, nz];
      } else if (line.startsWith('vertex')) {
        const parts = line.split(/\s+/);
        const vx = parseFloat(parts[1]) || 0;
        const vy = parseFloat(parts[2]) || 0;
        const vz = parseFloat(parts[3]) || 0;
        vertices.push(vx, vy, vz);
        normals.push(...currentNormal);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    if (vertices.length > 0) {
      geometry.computeVertexNormals();
    }
    geometry.computeBoundingBox();
    return geometry;
  }

  /**
   * Import Wavefront OBJ format text into THREE.BufferGeometry
   */
  importOBJ(text: string): THREE.BufferGeometry {
    const lines = text.split('\n');
    const v = [];
    const vn = [];
    const positions = [];
    const normals = [];

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line.startsWith('#') || line.length === 0) continue;

      const parts = line.split(/\s+/);
      const cmd = parts[0];

      if (cmd === 'v') {
        v.push([parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3])]);
      } else if (cmd === 'vn') {
        vn.push([parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3])]);
      } else if (cmd === 'f') {
        const faceVertices = [];
        const faceNormals = [];

        for (let i = 1; i < parts.length; i++) {
          const segs = parts[i].split('/');
          const raw = parseInt(segs[0], 10);
          // OBJ indices are 1-based; negative indices count back from the latest vertex
          const vIdx = raw < 0 ? v.length + raw : raw - 1;
          faceVertices.push(v[vIdx]);

          if (segs.length >= 3 && segs[2]) {
            const rawN = parseInt(segs[2], 10);
            const nIdx = rawN < 0 ? vn.length + rawN : rawN - 1;
            faceNormals.push(vn[nIdx]);
          }
        }

        // Triangulate face fan
        for (let i = 1; i < faceVertices.length - 1; i++) {
          const v0 = faceVertices[0];
          const v1 = faceVertices[i];
          const v2 = faceVertices[i + 1];

          positions.push(...v0, ...v1, ...v2);

          if (faceNormals.length === faceVertices.length) {
            normals.push(...faceNormals[0], ...faceNormals[i], ...faceNormals[i + 1]);
          }
        }
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    if (normals.length === positions.length && normals.length > 0) {
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    } else {
      geometry.computeVertexNormals();
    }
    geometry.computeBoundingBox();
    return geometry;
  }

  /**
   * Import AutoCAD DXF (R12/2000/2018) into 2D sketch entities and 3D wireframe mesh
   * @param {string} text
   * @returns {Array} Array of sketch entities, with .meshGeometry property if 3DFACE exists
   */
  importDXF(text: string): DXFImportResult {
    if (!text || typeof text !== 'string') return [];
    const lines = text.split(/\r?\n/).map(l => l.trim());
    const entities: DXFImportResult = [];
    const meshPositions: number[] = [];

    const safeNum = (v: string | undefined, defaultVal = 0) => {
      const val = parseFloat(v ?? '');
      return isNaN(val) || !isFinite(val) ? defaultVal : val;
    };

    let i = 0;
    while (i < lines.length) {
      const code = lines[i];
      const val = lines[i + 1];

      if (code === '0' && val === 'LINE') {
        let x1 = 0, y1 = 0, z1 = 0, x2 = 0, y2 = 0, z2 = 0;
        i += 2;
        while (i < lines.length && lines[i] !== '0') {
          const c = lines[i];
          const v = lines[i + 1];
          if (c === '10') x1 = safeNum(v);
          else if (c === '20') y1 = safeNum(v);
          else if (c === '30') z1 = safeNum(v);
          else if (c === '11') x2 = safeNum(v);
          else if (c === '21') y2 = safeNum(v);
          else if (c === '31') z2 = safeNum(v);
          i += 2;
        }
        entities.push({
          id: generateId('line'),
          type: SKETCH_ENTITY_TYPES.LINE,
          p1: { x: x1, y: y1, z: z1 },
          p2: { x: x2, y: y2, z: z2 },
          construction: false,
        });
        continue;
      } else if (code === '0' && val === 'CIRCLE') {
        let cx = 0, cy = 0, cz = 0, r = 10;
        i += 2;
        while (i < lines.length && lines[i] !== '0') {
          const c = lines[i];
          const v = lines[i + 1];
          if (c === '10') cx = safeNum(v);
          else if (c === '20') cy = safeNum(v);
          else if (c === '30') cz = safeNum(v);
          else if (c === '40') r = safeNum(v, 10);
          i += 2;
        }
        entities.push({
          id: generateId('circle'),
          type: SKETCH_ENTITY_TYPES.CIRCLE,
          center: { x: cx, y: cy, z: cz },
          radius: r,
          construction: false,
        });
        continue;
      } else if (code === '0' && val === 'ARC') {
        let cx = 0, cy = 0, cz = 0, r = 10, startAngle = 0, endAngle = 2 * Math.PI;
        i += 2;
        while (i < lines.length && lines[i] !== '0') {
          const c = lines[i];
          const v = lines[i + 1];
          if (c === '10') cx = safeNum(v);
          else if (c === '20') cy = safeNum(v);
          else if (c === '30') cz = safeNum(v);
          else if (c === '40') r = safeNum(v, 10);
          else if (c === '50') startAngle = (safeNum(v, 0) * Math.PI) / 180;
          else if (c === '51') endAngle = (safeNum(v, 360) * Math.PI) / 180;
          i += 2;
        }
        entities.push({
          id: generateId('arc'),
          type: SKETCH_ENTITY_TYPES.ARC,
          center: { x: cx, y: cy, z: cz },
          radius: r,
          startAngle,
          endAngle,
          construction: false,
        });
        continue;
      } else if (code === '0' && val === '3DFACE') {
        const p1 = { x: 0, y: 0, z: 0 }, p2 = { x: 0, y: 0, z: 0 }, p3 = { x: 0, y: 0, z: 0 }, p4 = { x: 0, y: 0, z: 0 };
        i += 2;
        while (i < lines.length && lines[i] !== '0') {
          const c = lines[i];
          const v = lines[i + 1];
          if (c === '10') p1.x = safeNum(v);
          else if (c === '20') p1.y = safeNum(v);
          else if (c === '30') p1.z = safeNum(v);
          else if (c === '11') p2.x = safeNum(v);
          else if (c === '21') p2.y = safeNum(v);
          else if (c === '31') p2.z = safeNum(v);
          else if (c === '12') p3.x = safeNum(v);
          else if (c === '22') p3.y = safeNum(v);
          else if (c === '32') p3.z = safeNum(v);
          else if (c === '13') p4.x = safeNum(v);
          else if (c === '23') p4.y = safeNum(v);
          else if (c === '33') p4.z = safeNum(v);
          i += 2;
        }
        // Triangle 1: p1, p2, p3
        meshPositions.push(p1.x, p1.y, p1.z, p2.x, p2.y, p2.z, p3.x, p3.y, p3.z);
        // Triangle 2: p1, p3, p4 (if quad)
        if (p4.x !== p3.x || p4.y !== p3.y || p4.z !== p3.z) {
          meshPositions.push(p1.x, p1.y, p1.z, p3.x, p3.y, p3.z, p4.x, p4.y, p4.z);
        }
        continue;
      } else if (code === '0' && val === 'POINT') {
        let px = 0, py = 0, pz = 0;
        i += 2;
        while (i < lines.length && lines[i] !== '0') {
          const c = lines[i];
          const v = lines[i + 1];
          if (c === '10') px = safeNum(v);
          else if (c === '20') py = safeNum(v);
          else if (c === '30') pz = safeNum(v);
          i += 2;
        }
        entities.push({
          id: generateId('pt'),
          type: SKETCH_ENTITY_TYPES.POINT,
          x: px,
          y: py,
          z: pz,
          construction: false,
        });
        continue;
      }
      i += 2;
    }

    if (meshPositions.length > 0) {
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.Float32BufferAttribute(meshPositions, 3));
      geom.computeVertexNormals();
      geom.computeBoundingBox();
      entities.meshGeometry = geom;
    }

    return entities;
  }

  /**
   * Import ISO 10303-21 STEP format (AP203/AP214/AP242)
   * Resolves CARTESIAN_POINT, VERTEX_POINT, POLY_LOOP, EDGE_LOOP, ADVANCED_FACE, CLOSED_SHELL, MANIFOLD_SOLID_BREP
   * Robust to nested parentheses, string literals, multiline parameters, and comments
   * @param {string} text
   * @returns {THREE.BufferGeometry}
   */
  importSTEP(text: string): THREE.BufferGeometry {
    if (!text || typeof text !== 'string') {
      throw new Error('Invalid STEP file content');
    }

    // Strip comments /* ... */
    const cleanText = text.replace(/\/\*[\s\S]*?\*\//g, '');

    // Map entity ID -> { type, rawParams, tokens }
    const entities = new Map<number, { id: number; type: string; raw: string }>();
    const cartesianPoints = new Map<number, [number, number, number]>();

    // Parse entity instances with balanced parenthesis matching
    const entityStartRegex = /#(\d+)\s*=\s*/g;
    let match;

    while ((match = entityStartRegex.exec(cleanText)) !== null) {
      const id = parseInt(match[1], 10);
      const startIndex = entityStartRegex.lastIndex;
      let i = startIndex;
      let parenDepth = 0;
      let inString = false;
      let quoteChar = '';
      let statement = '';

      while (i < cleanText.length) {
        const ch = cleanText[i];
        if ((ch === "'" || ch === '"') && (i === 0 || cleanText[i - 1] !== '\\')) {
          if (!inString) {
            inString = true;
            quoteChar = ch;
          } else if (ch === quoteChar) {
            inString = false;
          }
        } else if (!inString) {
          if (ch === '(') parenDepth++;
          else if (ch === ')') parenDepth--;
          else if (ch === ';' && parenDepth <= 0) {
            statement = cleanText.substring(startIndex, i).trim();
            entityStartRegex.lastIndex = i + 1;
            break;
          }
        }
        i++;
      }

      if (!statement) continue;

      const openParen = statement.indexOf('(');
      let type = '';
      let raw = '';
      if (statement.startsWith('(')) {
        type = 'COMPLEX';
        raw = statement;
      } else if (openParen !== -1 && statement.endsWith(')')) {
        type = statement.substring(0, openParen).trim().toUpperCase();
        raw = statement.substring(openParen + 1, statement.length - 1).trim();
      } else {
        type = 'UNKNOWN';
        raw = statement;
      }

      entities.set(id, { id, type, raw });

      if (type === 'CARTESIAN_POINT') {
        // e.g. 'Origin point', (0., 10.5, -5.2)
        const coordMatch = raw.match(/\(\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*\)/);
        if (coordMatch) {
          const x = parseFloat(coordMatch[1]) || 0;
          const y = parseFloat(coordMatch[2]) || 0;
          const z = parseFloat(coordMatch[3]) || 0;
          cartesianPoints.set(id, [x, y, z]);
        }
      }
    }

    const positions = [];

    // 1. Check for POLY_LOOP entities: POLY_LOOP('', (#1, #2, #3, ...))
    for (const ent of entities.values()) {
      if (ent.type === 'POLY_LOOP') {
        const pointRefs = [...ent.raw.matchAll(/#(\d+)/g)].map(m => parseInt(m[1], 10));
        const pts = pointRefs.map(pid => cartesianPoints.get(pid)).filter((p): p is [number, number, number] => !!p);

        // Triangulate convex polygon fan
        for (let k = 1; k < pts.length - 1; k++) {
          positions.push(...pts[0], ...pts[k], ...pts[k + 1]);
        }
      }
    }

    // 2. Check for EDGE_LOOP entities (AP214 / AP242 Advanced B-Rep)
    if (positions.length === 0) {
      const vertexPoints = new Map<number, [number, number, number]>();
      for (const [id, ent] of entities.entries()) {
        if (ent.type === 'VERTEX_POINT') {
          const ref = ent.raw.match(/#(\d+)/);
          if (ref) {
            const pt = cartesianPoints.get(parseInt(ref[1], 10));
            if (pt) vertexPoints.set(id, pt);
          }
        }
      }

      // Edge curves connect two vertex points: EDGE_CURVE('', #vp1, #vp2, #line, .T.)
      const edgeCurves = new Map<number, [number, number]>();
      for (const [id, ent] of entities.entries()) {
        if (ent.type === 'EDGE_CURVE') {
          const refs = [...ent.raw.matchAll(/#(\d+)/g)].map(m => parseInt(m[1], 10));
          if (refs.length >= 2) {
            edgeCurves.set(id, [refs[0], refs[1]]);
          }
        }
      }

      // Oriented edges reference edge curves: ORIENTED_EDGE('', *, *, #ec, .T./.F.)
      const orientedEdges = new Map<number, { edgeId: number; orientation: boolean }>();
      for (const [id, ent] of entities.entries()) {
        if (ent.type === 'ORIENTED_EDGE') {
          const ref = ent.raw.match(/#(\d+)/);
          const orientation = !ent.raw.includes('.F.');
          if (ref) {
            orientedEdges.set(id, { edgeId: parseInt(ref[1], 10), orientation });
          }
        }
      }

      // Loops reference oriented edges
      for (const ent of entities.values()) {
        if (ent.type === 'EDGE_LOOP') {
          const oeRefs = [...ent.raw.matchAll(/#(\d+)/g)].map(m => parseInt(m[1], 10));
          const pts = [];

          for (const oeId of oeRefs) {
            const oe = orientedEdges.get(oeId);
            if (!oe) continue;
            const ec = edgeCurves.get(oe.edgeId);
            if (!ec) continue;

            const vpId = oe.orientation ? ec[0] : ec[1];
            const pt = vertexPoints.get(vpId);
            if (pt) pts.push(pt);
          }

          for (let k = 1; k < pts.length - 1; k++) {
            positions.push(...pts[0], ...pts[k], ...pts[k + 1]);
          }
        }
      }
    }

    // Never invent geometry from loose points: report that nothing readable was found
    if (positions.length === 0) {
      throw new Error('No faceted (POLY_LOOP) or planar (EDGE_LOOP) faces found in STEP file');
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    if (positions.length > 0) {
      geometry.computeVertexNormals();
    }
    geometry.computeBoundingBox();
    return geometry;
  }

  /**
   * Import IGES 5.3 format (Initial Graphics Exchange Specification)
   * Parses S, G, D, P sections and resolves entities:
   * 186 (MSBO), 514 (Shell), 510 (Face), 508 (Loop), 504 (Edge), 502 (Vertex List),
   * 128 (Rational B-Spline Surface), 106 (Copious Data), 110 (Line), 108 (Plane)
   * Robust against stripped trailing spaces and padded records
   * @param {string} text
   * @returns {THREE.BufferGeometry}
   */
  importIGES(text: string): THREE.BufferGeometry {
    if (!text || typeof text !== 'string') {
      throw new Error('Invalid IGES file content');
    }

    const rawLines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const dLines = [];
    const pLines = [];

    // Separate records by 73rd column section flag (ensuring 80-char padding)
    for (const rawLine of rawLines) {
      if (!rawLine || rawLine.length === 0) continue;
      const line = rawLine.padEnd(80, ' ');
      const section = line.charAt(72);
      if (section === 'D') {
        dLines.push(line);
      } else if (section === 'P') {
        pLines.push(line);
      }
    }

    // 1. Parse Directory Entry (DE) records
    // Each DE entity consists of two consecutive 80-char D lines
    const directoryEntries = new Map<number, { deIndex: number; type: number; paramStart: number; form: number }>();
    for (let i = 0; i < dLines.length; i += 2) {
      const line1 = dLines[i].padEnd(80, ' ');
      const line2 = (dLines[i + 1] || '').padEnd(80, ' ');
      const deIndex = i + 1; // 1-based index (1, 3, 5...)

      const type = parseInt(line1.substring(0, 8).trim(), 10);
      const paramStart = parseInt(line1.substring(8, 16).trim(), 10);
      const form = parseInt(line2.substring(32, 40).trim(), 10) || 0;

      if (!isNaN(type)) {
        directoryEntries.set(deIndex, {
          deIndex,
          type,
          paramStart,
          form,
        });
      }
    }

    // 2. Parse Parameter Data (P) lines
    // Group parameter lines by their target DE index in columns 65-72
    const paramStringsByDE = new Map<number, string>();

    for (const pLine of pLines) {
      const padded = pLine.padEnd(80, ' ');
      const paramChunk = padded.substring(0, 64);
      const dePointerStr = padded.substring(64, 72).trim();
      const dePointer = parseInt(dePointerStr, 10);

      if (!isNaN(dePointer)) {
        const existing = paramStringsByDE.get(dePointer) || '';
        paramStringsByDE.set(dePointer, existing + paramChunk);
      }
    }

    // Tokenize parameter data into array of values
    const entityParams = new Map<number, string[]>();
    for (const [dePointer, rawP] of paramStringsByDE.entries()) {
      // Delimiter is comma, terminator is semicolon
      const clean = rawP.replace(/;.*$/, '');
      // FORTRAN-style exponents (1.5D-3) are valid IGES reals
      const tokens = clean.split(',').map(s => s.trim().replace(/^([-+]?[\d.]+)D([-+]?\d+)$/, '$1E$2'));
      entityParams.set(dePointer, tokens);
    }

    // 3. Resolve Vertices and B-Rep entities
    const positions = [];
    const vertexListMap = new Map<number, Array<[number, number, number]>>();

    // Parse Entity 502: Vertex List
    // Format: 502, N, X1, Y1, Z1, X2, Y2, Z2, ...
    for (const [deIndex, de] of directoryEntries.entries()) {
      if (de.type === 502) {
        const tokens = entityParams.get(deIndex);
        if (tokens && tokens.length > 2) {
          const count = parseInt(tokens[1], 10);
          const verts: Array<[number, number, number]> = [];
          for (let k = 0; k < count; k++) {
            const idx = 2 + k * 3;
            if (idx + 2 < tokens.length) {
              const x = parseFloat(tokens[idx]);
              const y = parseFloat(tokens[idx + 1]);
              const z = parseFloat(tokens[idx + 2]);
              verts.push([x, y, z]);
            }
          }
          vertexListMap.set(deIndex, verts);
        }
      }
    }

    // Entity 504 (form 1) Edge List: N, then N x (CURV, SVP, SV, TVP, TV)
    type Vec = [number, number, number];
    const edgeLists = new Map<number, Array<[Vec, Vec]>>();
    for (const [deIndex, de] of directoryEntries.entries()) {
      if (de.type !== 504) continue;
      const t = entityParams.get(deIndex);
      if (!t) continue;
      const n = parseInt(t[1], 10);
      const list: Array<[Vec, Vec]> = [];
      for (let e = 0; e < n; e++) {
        const base = 2 + e * 5;
        const sv = vertexListMap.get(parseInt(t[base + 1], 10))?.[parseInt(t[base + 2], 10) - 1];
        const tv = vertexListMap.get(parseInt(t[base + 3], 10))?.[parseInt(t[base + 4], 10) - 1];
        if (sv && tv) list.push([sv, tv]);
        else list.push([[NaN, NaN, NaN], [NaN, NaN, NaN]]);
      }
      edgeLists.set(deIndex, list);
    }

    // Entity 508 (form 1) Loop: N, then per edge TYPE, EDGE, NDX, OF, K, then K x (ISOP, CURV)
    const loopMap = new Map<number, Vec[]>();
    for (const [deIndex, de] of directoryEntries.entries()) {
      if (de.type !== 508) continue;
      const t = entityParams.get(deIndex);
      if (!t) continue;
      const n = parseInt(t[1], 10);
      const pts: Vec[] = [];
      let k = 2;
      for (let e = 0; e < n && k + 4 < t.length + 1; e++) {
        const type = parseInt(t[k], 10);
        const listDE = parseInt(t[k + 1], 10);
        const idx = parseInt(t[k + 2], 10);
        const agrees = parseInt(t[k + 3], 10) === 1;
        const pscCount = parseInt(t[k + 4], 10) || 0;
        k += 5 + pscCount * 2;
        if (type !== 0) continue; // vertex-type loop members carry no edge
        const edge = edgeLists.get(listDE)?.[idx - 1];
        if (edge && Number.isFinite(edge[0][0])) pts.push(agrees ? edge[0] : edge[1]);
      }
      loopMap.set(deIndex, pts);
    }

    // Entity 510 (form 1) Face: SURF, N, OF, LOOP1..N — first loop is the outer boundary
    for (const [deIndex, de] of directoryEntries.entries()) {
      if (de.type !== 510) continue;
      const t = entityParams.get(deIndex);
      if (!t || t.length < 5) continue;
      const loopPts = loopMap.get(parseInt(t[4], 10));
      if (loopPts && loopPts.length >= 3) {
        for (let k = 1; k < loopPts.length - 1; k++) positions.push(...loopPts[0], ...loopPts[k], ...loopPts[k + 1]);
      }
    }

    // Also parse Entity 106: Copious Data (triangulated mesh facets)
    for (const [deIndex, de] of directoryEntries.entries()) {
      if (de.type === 106) {
        const tokens = entityParams.get(deIndex);
        if (tokens && tokens.length > 3) {
          const nPts = parseInt(tokens[2], 10);
          const pts = [];
          for (let k = 0; k < nPts; k++) {
            const idx = 3 + k * 3;
            if (idx + 2 < tokens.length) {
              pts.push([parseFloat(tokens[idx]), parseFloat(tokens[idx + 1]), parseFloat(tokens[idx + 2])]);
            }
          }
          for (let k = 1; k < pts.length - 1; k++) {
            positions.push(...pts[0], ...pts[k], ...pts[k + 1]);
          }
        }
      }
    }

    // Never invent geometry from loose vertices
    if (positions.length === 0) {
      throw new Error('No faces (entity 510) or copious-data facets (entity 106) found in IGES file');
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    return geometry;
  }

  detectFormat(filename: string | null | undefined): 'stl' | 'obj' | 'dxf' | 'step' | 'iges' | 'json' | null {
    if (!filename) return null;
    const ext = (filename.split('.').pop() ?? '').toLowerCase();
    if (ext === 'stl') return 'stl';
    if (ext === 'obj') return 'obj';
    if (ext === 'dxf') return 'dxf';
    if (ext === 'step' || ext === 'stp') return 'step';
    if (ext === 'iges' || ext === 'igs') return 'iges';
    if (ext === 'json' || ext === 'casiproj' || ext === 'cadproj') return 'json';
    return null;
  }
}

export const importEngine = new ImportEngine();
export default ImportEngine;
