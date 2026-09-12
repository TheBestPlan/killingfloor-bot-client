// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TheBestPlan
//
// kfrom - a reader for Killing Floor .rom/.utx/.usx packages (Unreal Engine 2.5, v128/29).
// DataView-based, so it needs no Node Buffer; input is a Uint8Array (browser: File.arrayBuffer(),
// Node: fs.readFileSync). Exposes package parsing, world-BSP geometry, and texture mip extraction.
// The field layouts were worked out by hand against the shipped maps.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.KFRom = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const RF_LoadForServer = 0x00020000;
  const PF_Invisible = 0x00000001, PF_FakeBackdrop = 0x00000080, PF_Portal = 0x04000000;

  function Reader(u8, pos) {
    this.u8 = u8;
    this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    this.pos = pos || 0;
  }
  Reader.prototype = {
    byte() { return this.u8[this.pos++]; },
    i32() { const v = this.dv.getInt32(this.pos, true); this.pos += 4; return v; },
    u32() { const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; },
    u16() { const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; },
    f32() { const v = this.dv.getFloat32(this.pos, true); this.pos += 4; return v; },
    skip(n) { this.pos += n; },
    // UE2 compact index: byte0 bit0x80=sign, bit0x40=continue, low6=value; cont bytes bit0x80=continue + 7 bits.
    cidx() {
      let b = this.u8[this.pos++]; const neg = (b & 0x80) !== 0; let val = b & 0x3f;
      if (b & 0x40) { let sh = 6; for (;;) { b = this.u8[this.pos++]; val |= (b & 0x7f) << sh; sh += 7; if (!(b & 0x80)) break; } }
      return neg ? -val : val;
    },
    latin1(len) { let s = ""; for (let i = 0; i < len; i++) { const c = this.u8[this.pos++]; if (c === 0) { this.pos += len - i - 1; break; } s += String.fromCharCode(c); } return s; },
    vec3() { return [this.f32(), this.f32(), this.f32()]; },
    array(readElem) { const n = this.cidx(); const out = new Array(n); for (let i = 0; i < n; i++) out[i] = readElem(this); return out; },
  };

  function parsePackage(u8) {
    const r = new Reader(u8);
    const tag = r.u32();
    const fileVersion = r.u16(), licenseeVersion = r.u16();
    const packageFlags = r.u32();
    const nameCount = r.u32(), nameOffset = r.u32();
    const exportCount = r.u32(), exportOffset = r.u32();
    const importCount = r.u32(), importOffset = r.u32();
    r.skip(16); // GUID
    const genCount = r.u32();
    for (let i = 0; i < genCount; i++) { r.u32(); r.u32(); }

    r.pos = nameOffset;
    const names = new Array(nameCount);
    for (let i = 0; i < nameCount; i++) { const ln = r.cidx(); names[i] = r.latin1(ln); r.u32(); }

    r.pos = importOffset;
    const imports = new Array(importCount);
    for (let i = 0; i < importCount; i++) {
      const classPackage = r.cidx(), className = r.cidx(), packageIndex = r.i32(), objectName = r.cidx();
      imports[i] = { classPackage: names[classPackage], className: names[className], packageIndex, name: names[objectName] };
    }

    r.pos = exportOffset;
    const exports_ = new Array(exportCount);
    for (let i = 0; i < exportCount; i++) {
      const classIndex = r.cidx(), superIndex = r.cidx(), packageIndex = r.i32();
      const objectName = r.cidx(), objectFlags = r.u32(), serialSize = r.cidx();
      const serialOffset = serialSize > 0 ? r.cidx() : 0;
      exports_[i] = { classIndex, superIndex, packageIndex, name: names[objectName], objectFlags, serialSize, serialOffset };
    }

    const refName = (ref) => {
      if (ref < 0) { const i = -ref - 1; return i < imports.length ? imports[i].name : "import?" + i; }
      if (ref > 0) { const i = ref - 1; return i < exports_.length ? exports_[i].name : "export?" + i; }
      return "None";
    };
    const classOf = (e) => refName(e.classIndex);
    return { u8, header: { tag, fileVersion, licenseeVersion, packageFlags, nameCount, exportCount, importCount }, names, imports, exports: exports_, refName, classOf };
  }

  function findWorldModel(pkg) {
    const models = pkg.exports
      .map((e, i) => ({ i, e }))
      .filter((x) => pkg.classOf(x.e) === "Model" && (x.e.objectFlags & RF_LoadForServer) && x.e.serialSize > 0)
      .sort((a, b) => b.e.serialSize - a.e.serialSize);
    return models.length ? models[0].e : null;
  }

  // World UModel: props("None") + FBox(25) + FSphere(16) + Vectors + Points + Nodes + Surfs + Verts.
  function readModel(pkg, exp) {
    const r = new Reader(pkg.u8, exp.serialOffset);
    r.skip(1 + 25 + 16);
    const vectors = r.array((x) => x.vec3());
    const points = r.array((x) => x.vec3());
    const nodes = r.array((x) => {
      const plane = [x.f32(), x.f32(), x.f32(), x.f32()];
      x.skip(8); x.byte();                 // ZoneMask, NodeFlags
      const iVertPool = x.cidx(), iSurf = x.cidx();
      x.cidx(); x.cidx(); x.cidx(); x.cidx(); x.cidx(); // iBack,iFront,iPlane,iColl,iRender
      x.skip(16);                          // ExclusiveSphereBound
      const iZone0 = x.byte(), iZone1 = x.byte();
      const numVertices = x.byte();
      x.skip(8 + 12);                      // iLeaf[2] + RO/KF trailing 3xINT
      return { plane, iVertPool, iSurf, numVertices, zone: iZone1 || iZone0 };
    });
    const surfs = r.array((x) => {
      const material = x.cidx();
      const polyFlags = x.u32();
      const pBase = x.cidx(), vNormal = x.cidx(), vTextureU = x.cidx(), vTextureV = x.cidx();
      x.cidx(); x.cidx();                  // iLightMap, iBrushPoly
      x.skip(16 + 4);                      // Plane, ShadowMapScale
      return { material, polyFlags, pBase, vNormal, vTextureU, vTextureV };
    });
    const verts = r.array((x) => ({ pVertex: x.cidx(), iSide: x.cidx() }));
    return { name: exp.name, vectors, points, nodes, surfs, verts };
  }

  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  // material ref -> { file, group, name, embedded, cls }. Negative = import (walk Outer chain to the
  // top-level package = .utx filename); positive = embedded export in the map.
  function resolveMaterial(pkg, ref) {
    if (ref === 0) return null;
    if (ref > 0) { const e = pkg.exports[ref - 1]; return e ? { file: null, group: null, name: e.name, embedded: true, cls: pkg.classOf(e) } : null; }
    const im = pkg.imports[-ref - 1];
    if (!im) return null;
    const chain = [];
    let outer = im.packageIndex;
    while (outer < 0) { const p = pkg.imports[-outer - 1]; if (!p) break; chain.push(p.name); outer = p.packageIndex; }
    return { file: chain.length ? chain[chain.length - 1] : null, group: chain.length > 1 ? chain[0] : null, name: im.name, embedded: false, cls: im.className };
  }

  // Build triangles grouped by material. UVs are in texels (divide by texture USize/VSize at upload).
  // includeNode(node) optionally filters nodes (e.g. to split the sky zone from the main level).
  function buildMesh(pkg, model, includeNode) {
    const { vectors, points, nodes, surfs, verts } = model;
    const groups = new Map();
    for (const node of nodes) {
      if (includeNode && !includeNode(node)) continue;
      if (node.numVertices < 3 || node.iSurf < 0 || node.iSurf >= surfs.length) continue;
      const surf = surfs[node.iSurf];
      // drop portals / invisible collision, and FakeBackdrop "sky window" surfaces (the placeholder
      // sky texture) so the real sky-zone backdrop shows through them.
      if (surf.polyFlags & (PF_Invisible | PF_Portal | PF_FakeBackdrop)) continue;
      const base = points[surf.pBase] || [0, 0, 0];
      const uAxis = vectors[surf.vTextureU] || [1, 0, 0];
      const vAxis = vectors[surf.vTextureV] || [0, 1, 0];
      let g = groups.get(surf.material);
      if (!g) { g = { materialRef: surf.material, material: resolveMaterial(pkg, surf.material), polyFlags: 0, positions: [], uvs: [], indices: [], _n: 0 }; groups.set(surf.material, g); }
      g.polyFlags |= surf.polyFlags;
      const ring = [];
      let ok = true;
      for (let j = 0; j < node.numVertices; j++) {
        const fv = verts[node.iVertPool + j]; if (!fv) { ok = false; break; }
        const p = points[fv.pVertex]; if (!p) { ok = false; break; }
        const rel = sub(p, base);
        g.positions.push(p[0], p[1], p[2]);
        g.uvs.push(dot(rel, uAxis), dot(rel, vAxis));
        ring.push(g._n++);
      }
      if (!ok) continue;
      for (let j = 2; j < ring.length; j++) g.indices.push(ring[0], ring[j - 1], ring[j]);
    }
    return groups;
  }

  // --- textures ---------------------------------------------------------------------------------
  const TEXFMT = { 0: "P8", 1: "RGBA7", 2: "RGB16", 3: "DXT1", 4: "RGB8", 5: "RGBA8", 6: "NODATA", 7: "DXT3", 8: "DXT5", 9: "L8", 10: "G16" };

  // Read a Texture export's tagged-property block -> the fields we need.
  function readTextureProps(pkg, exp) {
    const r = new Reader(pkg.u8, exp.serialOffset);
    const props = {};
    for (let guard = 0; guard < 300; guard++) {
      const nameIdx = r.cidx();
      const pname = pkg.names[nameIdx];
      if (pname === "None") break;
      const info = r.byte();
      const type = info & 0x0f, sizeCode = (info >> 4) & 0x07, isArr = (info & 0x80) !== 0;
      if (type === 10) r.cidx();          // struct name
      let size;
      if (sizeCode === 0) size = 1; else if (sizeCode === 1) size = 2; else if (sizeCode === 2) size = 4;
      else if (sizeCode === 3) size = 12; else if (sizeCode === 4) size = 16; else if (sizeCode === 5) size = r.byte();
      else if (sizeCode === 6) { size = r.u16(); } else { size = r.u32(); }
      if (isArr && type !== 3) r.byte();
      const vs = r.pos; let val;
      if (type === 3) val = (info & 0x80) ? true : false;
      else if (type === 1) val = r.byte();
      else if (type === 2) val = r.i32();
      else if (type === 4) val = r.f32();
      else if (type === 5 || type === 6) val = r.cidx();
      else val = null;
      props[pname] = val;
      r.pos = vs + (type === 3 ? 0 : size);
    }
    return { props, mipsPos: r.pos };
  }

  // Decode the base mip of a texture export -> { format, width, height, data:Uint8Array, palette? }.
  // format is the ETextureFormat string; DXT data is uploaded to the GPU compressed (no CPU decode).
  function readTextureMip0(pkg, exp) {
    const { props, mipsPos } = readTextureProps(pkg, exp);
    const fmt = props.Format || 0;
    const r = new Reader(pkg.u8, mipsPos);
    const mipCount = r.cidx();
    if (mipCount <= 0) return null;
    r.i32();                               // SkipPos (lazy-array offset)
    const dataLen = r.cidx();
    const data = pkg.u8.subarray(r.pos, r.pos + dataLen);
    r.pos += dataLen;
    const width = r.i32(), height = r.i32();
    let palette = null;
    if (fmt === 0 && props.Palette) palette = readPalette(pkg, props.Palette);
    return { format: TEXFMT[fmt] || String(fmt), fmtCode: fmt, width, height, data, palette, masked: !!props.bMasked, alpha: !!props.bAlphaTexture };
  }

  function readPalette(pkg, ref) {
    let exp = null;
    if (ref > 0) exp = pkg.exports[ref - 1];
    if (!exp) return null;
    const r = new Reader(pkg.u8, exp.serialOffset);
    r.skip(1);                             // "None" props
    const n = r.cidx();
    const pal = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) { pal[i * 4] = r.byte(); pal[i * 4 + 1] = r.byte(); pal[i * 4 + 2] = r.byte(); pal[i * 4 + 3] = r.byte(); }
    return pal;
  }

  // --- static meshes + actor placement ----------------------------------------------------------
  const RF_HasStack = 0x02000000;

  // Actor records with RF_HasStack are prefixed by an FStateFrame: Node(cidx), StateNode(cidx),
  // ProbeMask(QWORD 8), LatentAction(INT 4), and - only if Node!=0 - Offset(cidx).
  function skipStateFrame(r) {
    const node = r.cidx(); r.cidx(); r.skip(8); r.skip(4); if (node !== 0) r.cidx();
  }

  // Generic UE2 tagged-property block reader (Name/info-byte format). Decodes the scalar + Vector/
  // Rotator values we care about; captures the Materials array; skips everything else by DataSize.
  function readProps(r, pkg) {
    const props = {};
    for (let g = 0; g < 2000; g++) {
      const pname = pkg.names[r.cidx()];
      if (pname === "None" || pname === undefined) break;
      const info = r.byte();
      const type = info & 0x0f, sizeCode = (info >> 4) & 7, isArr = (info & 0x80) !== 0;
      let structName = null;
      if (type === 10) structName = pkg.names[r.cidx()];
      const size = propSize(r, sizeCode);
      if (isArr && type !== 3) r.byte();   // array index (assume <128; rare otherwise)
      const vs = r.pos;
      if (type === 3) props[pname] = (info & 0x80) !== 0;
      else if (type === 1) props[pname] = r.byte();
      else if (type === 2) props[pname] = r.i32();
      else if (type === 4) props[pname] = r.f32();
      else if (type === 5 || type === 6) props[pname] = r.cidx();
      else if (type === 10 && structName === "Vector") props[pname] = [r.f32(), r.f32(), r.f32()];
      else if (type === 10 && structName === "Rotator") props[pname] = [r.i32(), r.i32(), r.i32()];
      else if (type === 9 && pname === "Materials") props._materials = readMaterialsArray(r, pkg);
      else if (type === 10 && pname === "Layers" && !props._layer0) props._layer0 = readLayerStruct(r, pkg);
      r.pos = vs + (type === 3 ? 0 : size);
    }
    return props;
  }
  function propSize(r, sizeCode) {
    if (sizeCode === 0) return 1; if (sizeCode === 1) return 2; if (sizeCode === 2) return 4;
    if (sizeCode === 3) return 12; if (sizeCode === 4) return 16; if (sizeCode === 5) return r.byte();
    if (sizeCode === 6) return r.u16(); return r.u32();
  }
  // Materials: ArrayProperty of FStaticMeshMaterial (each = nested tagged props with a Material ref).
  function readMaterialsArray(r, pkg) {
    const n = r.cidx(); const mats = [];
    for (let i = 0; i < n; i++) {
      let ref = 0;
      for (let g = 0; g < 30; g++) {
        const pn = pkg.names[r.cidx()];
        if (pn === "None" || pn === undefined) break;
        const info = r.byte(); const type = info & 0x0f, sizeCode = (info >> 4) & 7, isArr = (info & 0x80) !== 0;
        if (type === 10) r.cidx();
        const size = propSize(r, sizeCode);
        if (isArr && type !== 3) r.byte();
        const vs = r.pos;
        if (pn === "Material" && type === 5) ref = r.cidx();
        r.pos = vs + (type === 3 ? 0 : size);
      }
      mats.push(ref);
    }
    return mats;
  }

  // First TerrainLayer struct value (nested tagged props) -> base texture + tiling scales.
  function readLayerStruct(r, pkg) {
    let texRef = 0, uScale = 0, vScale = 0;
    for (let g = 0; g < 60; g++) {
      const pn = pkg.names[r.cidx()];
      if (pn === "None" || pn === undefined) break;
      const info = r.byte(); const type = info & 0x0f, sizeCode = (info >> 4) & 7, isArr = (info & 0x80) !== 0;
      if (type === 10) r.cidx();
      const size = propSize(r, sizeCode);
      if (isArr && type !== 3) r.byte();
      const vs = r.pos;
      if (pn === "Texture" && type === 5) texRef = r.cidx();
      else if (pn === "UScale" && type === 4) uScale = r.f32();
      else if (pn === "VScale" && type === 4) vScale = r.f32();
      r.pos = vs + (type === 3 ? 0 : size);
    }
    return { texRef, uScale, vScale };
  }

  // TerrainInfo actor -> heightmap ref + world scale/location + first layer. The heightmap itself
  // (a G16 texture) is resolved by the caller (embedded or external), then fed to buildTerrainMesh.
  function readTerrainInfo(pkg) {
    for (const e of pkg.exports) {
      if (pkg.classOf(e) !== "TerrainInfo" || e.serialSize <= 0) continue;
      const r = new Reader(pkg.u8, e.serialOffset);
      if (e.objectFlags & RF_HasStack) skipStateFrame(r);
      let props; try { props = readProps(r, pkg); } catch (err) { continue; }
      if (!props.TerrainMap) continue;
      return { terrainMapRef: props.TerrainMap, scale: props.TerrainScale || [1, 1, 1], location: props.Location || [0, 0, 0], layer0: props._layer0 || null };
    }
    return null;
  }

  // Heightmap grid -> mesh. heights = Uint16Array(w*h) of G16 samples. Vertex world position uses
  // the standard UE2 terrain mapping (grid centered on Location, Z = (h-32768)*scaleZ/256).
  function buildTerrainMesh(heights, w, h, scale, location, uScale, vScale) {
    const positions = new Float32Array(w * h * 3), uvs = new Float32Array(w * h * 2);
    const ut = uScale > 0 ? 1 / uScale : 1 / 8, vt = vScale > 0 ? 1 / vScale : 1 / 8;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      positions[i * 3] = location[0] + (x - w / 2) * scale[0];
      positions[i * 3 + 1] = location[1] + (y - h / 2) * scale[1];
      positions[i * 3 + 2] = location[2] + (heights[i] - 32768) * scale[2] / 256;
      uvs[i * 2] = x * ut; uvs[i * 2 + 1] = y * vt;
    }
    const indices = new Uint32Array((w - 1) * (h - 1) * 6);
    let o = 0;
    for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) {
      const a = y * w + x, b = a + 1, c = a + w, d = c + 1;
      indices[o++] = a; indices[o++] = c; indices[o++] = b;
      indices[o++] = b; indices[o++] = c; indices[o++] = d;
    }
    return { positions, indices, uvs };
  }

  // UStaticMesh geometry: props(Materials) + FBox+FSphere + Sections + FBox + VertexStream +
  // Color/Alpha + UVStream + IndexStream1 (rest is collision - ignored). Returns null if degenerate.
  function readStaticMesh(pkg, exp) {
    const r = new Reader(pkg.u8, exp.serialOffset);
    const props = readProps(r, pkg);
    r.skip(25 + 16);                                   // UPrimitive FBox + FSphere
    const sections = r.array((x) => { x.i32(); const FirstIndex = x.u16(), FirstVertex = x.u16(), LastVertex = x.u16(); x.u16(); const NumFaces = x.u16(); return { FirstIndex, FirstVertex, LastVertex, NumFaces }; });
    r.skip(25);                                        // BoundingBox again
    const nVert = r.cidx();
    const positions = new Float32Array(nVert * 3);
    for (let i = 0; i < nVert; i++) { positions[i * 3] = r.f32(); positions[i * 3 + 1] = r.f32(); positions[i * 3 + 2] = r.f32(); r.skip(12); } // + normal
    r.i32();                                           // Revision
    for (let s = 0; s < 2; s++) { const nc = r.cidx(); r.skip(nc * 4); r.i32(); }  // Color, Alpha
    const nUV = r.cidx();
    let uvs = null;
    for (let s = 0; s < nUV; s++) { const nd = r.cidx(); const arr = new Float32Array(nd * 2); for (let i = 0; i < nd; i++) { arr[i * 2] = r.f32(); arr[i * 2 + 1] = r.f32(); } r.i32(); r.i32(); if (s === 0) uvs = arr; }
    const nIdx = r.cidx();
    const indices = new Uint16Array(nIdx);
    for (let i = 0; i < nIdx; i++) indices[i] = r.u16();
    if (nVert === 0 || nIdx === 0) return null;
    let maxIdx = 0; for (let i = 0; i < nIdx; i++) if (indices[i] > maxIdx) maxIdx = indices[i];
    if (maxIdx >= nVert) return null;                  // desynced/garbage
    if (!uvs || uvs.length / 2 !== nVert) uvs = null;
    return { name: exp.name, sections, positions, uvs, indices, materials: props._materials || [], nVert };
  }

  // Read every export of the given classes as an actor: its tagged props + Location/Rotation.
  // exportIndex is 1-based (matches positive object refs, e.g. ReachSpec.Start/End).
  function readActors(pkg, classNames) {
    const set = classNames instanceof Set ? classNames : new Set(classNames);
    const out = [];
    for (let i = 0; i < pkg.exports.length; i++) {
      const e = pkg.exports[i];
      if (!set.has(pkg.classOf(e)) || e.serialSize <= 0) continue;
      const r = new Reader(pkg.u8, e.serialOffset);
      if (e.objectFlags & RF_HasStack) skipStateFrame(r);
      let props; try { props = readProps(r, pkg); } catch (err) { continue; }
      out.push({ exportIndex: i + 1, cls: pkg.classOf(e), name: e.name, location: props.Location || null, rotation: props.Rotation || [0, 0, 0], props });
    }
    return out;
  }

  // All StaticMeshActor placements: mesh ref + transform (Unreal units / FRotator).
  function readStaticMeshActors(pkg) {
    const out = [];
    for (const e of pkg.exports) {
      if (pkg.classOf(e) !== "StaticMeshActor" || e.serialSize <= 0) continue;
      const r = new Reader(pkg.u8, e.serialOffset);
      if (e.objectFlags & RF_HasStack) skipStateFrame(r);
      let props; try { props = readProps(r, pkg); } catch (err) { continue; }
      if (!props.StaticMesh || props.bHidden) continue;
      out.push({
        meshRef: props.StaticMesh,
        location: props.Location || [0, 0, 0],
        rotation: props.Rotation || [0, 0, 0],
        drawScale: props.DrawScale != null ? props.DrawScale : 1,
        drawScale3D: props.DrawScale3D || [1, 1, 1],
        prePivot: props.PrePivot || [0, 0, 0],
      });
    }
    return out;
  }

  return { parsePackage, findWorldModel, readModel, buildMesh, resolveMaterial, readTextureMip0, readTextureProps, readProps, readStaticMesh, readStaticMeshActors, readActors, readTerrainInfo, buildTerrainMesh, TEXFMT };
});
