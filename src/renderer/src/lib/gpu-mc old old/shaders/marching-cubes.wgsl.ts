/**
 * Returns the Marching Cubes WGSL compute shader source.
 * smoothNormals: whether to emit a normal vec3 after each position vec3.
 * previewSDF: optional WGSL snippet injected as fn previewSDF(p: vec3f) -> f32.
 *             When provided, density is sampled as density + previewSDF(p).
 * previewMode: 0=basic, 1=add-overlay, 2=remove-overlay, 3=combined
 *   basic:          primary mesh with sdf applied (no secondary)
 *   add-overlay:    primary=real mesh, secondary=sdf mesh only where sdf adds
 *   remove-overlay: primary=sdf mesh, secondary=real mesh only where sdf removes
 *   combined:       primary=subtract part, secondary=add part
 */
export function buildMarchingCubesShader(
  smoothNormals: boolean,
  previewSDF?: string,
  vertexFormat: 'pos3' | 'pos3-norm3' = 'pos3-norm3',
  capEdges: boolean = false,
  passType: 'count' | 'generate' = 'generate',
  densityFormat: 'f32' | 'u16' | 'u8' = 'f32',
  invertDensity: boolean = false
): string {
  const stride = vertexFormat === 'pos3' ? 3 : 6;
  
  return /* wgsl */`

struct GlobalUniforms {
  gridSize:     vec3u, chunkSize:    u32,
  isoLevel:     f32,   voxelSize:    f32,
  smoothNorms:  u32,   clampMin:     f32,
  gridOrigin:   vec3f, clampMax:     f32,
}

struct ChunkUniforms {
  chunkOffset:  vec3u, chunkIndex:   u32,
  chunkCells:   vec3u, meshType:     u32, // 0 = Main, 1 = Ghost
}

struct PreviewUniforms {
  offset: vec3f, scale: f32, multiplier: f32, previewMode: u32,
  previewMargin: f32, _p0: f32, applyMin: vec3f, _p1: f32, applyMax: vec3f, isoLevel: f32,
}

@group(0) @binding(0) var<uniform>            gUni:     GlobalUniforms;
${densityFormat === 'f32' ? `@group(0) @binding(1) var<storage, read> density: array<f32>;` : `@group(0) @binding(1) var<storage, read> density: array<u32>;`}
@group(0) @binding(2) var<storage, read>      triTable: array<i32>;
@group(0) @binding(3) var<storage, read>      edgeTable:array<u32>;
@group(0) @binding(4) var<storage, read_write> counters: array<atomic<u32>>;
@group(0) @binding(5) var<uniform>            previewUni: PreviewUniforms;

@group(1) @binding(0) var<uniform>            cUni:     ChunkUniforms;
${passType === 'generate' ? `@group(1) @binding(1) var<storage, read_write> verts:   array<f32>;` : ''}

fn densityIndex(c: vec3u) -> u32 {
  let w = gUni.gridSize.x + 1u; let h = gUni.gridSize.y + 1u;
  return c.x + c.y * w + c.z * w * h;
}

fn getDensity(c: vec3u) -> f32 {
  ${capEdges ? `if (any(c == vec3u(0u)) || any(c == gUni.gridSize)) { return ${invertDensity ? '10000.0' : '-10000.0'}; }` : ''}
  let cc = clamp(c, vec3u(0u), gUni.gridSize);
  let idx = densityIndex(cc);
  
  ${densityFormat === 'f32' ? `return density[idx];` : ''}
  ${densityFormat === 'u16' ? `
  let raw = (density[idx / 2u] >> ((idx % 2u) * 16u)) & 0xFFFFu;
  return mix(gUni.clampMin, gUni.clampMax, f32(raw) / 65535.0);
  ` : ''}
  ${densityFormat === 'u8' ? `
  let raw = (density[idx / 4u] >> ((idx % 4u) * 8u)) & 0xFFu;
  return mix(gUni.clampMin, gUni.clampMax, f32(raw) / 255.0);
  ` : ''}
}

fn sampleDensityFrac(gc: vec3f) -> f32 {
  let lo = vec3u(floor(gc)); let hi = lo + vec3u(1u); let t = fract(gc);
  let d000 = getDensity(vec3u(lo.x, lo.y, lo.z)); let d100 = getDensity(vec3u(hi.x, lo.y, lo.z));
  let d010 = getDensity(vec3u(lo.x, hi.y, lo.z)); let d110 = getDensity(vec3u(hi.x, hi.y, lo.z));
  let d001 = getDensity(vec3u(lo.x, lo.y, hi.z)); let d101 = getDensity(vec3u(hi.x, lo.y, hi.z));
  let d011 = getDensity(vec3u(lo.x, hi.y, hi.z)); let d111 = getDensity(vec3u(hi.x, hi.y, hi.z));
  let d00 = mix(d000, d100, t.x); let d10 = mix(d010, d110, t.x);
  let d01 = mix(d001, d101, t.x); let d11 = mix(d011, d111, t.x);
  let d0 = mix(d00, d10, t.y);    let d1 = mix(d01, d11, t.y);
  return mix(d0, d1, t.z);
}

fn cellToWorld(cellPos: vec3u) -> vec3f { return gUni.gridOrigin + vec3f(cellPos) * gUni.voxelSize; }

fn interpVert(pA: vec3f, pB: vec3f, dA: f32, dB: f32, iso: f32) -> vec3f {
  return pA + clamp((iso - dA) / (dB - dA), 0.0, 1.0) * (pB - pA);
}

${previewSDF ? `
${previewSDF}
var<private> _sdfCurrentWorld: vec3f;
var<private> _sdfCurrentCell: vec3u;
var<private> _sdfContinuousBase: f32;

fn pos() -> vec3f { return (_sdfCurrentWorld - previewUni.offset) / previewUni.scale; }

fn val(offset: vec3i) -> f32 { 
  // NEW: If asking for the center voxel, return the continuously interpolated base density!
  // This prevents the underlying mesh from becoming flat/blocky during normal calculation.
  if (all(offset == vec3i(0))) {
    return _sdfContinuousBase;
  }
  let cc = clamp(vec3i(_sdfCurrentCell) + offset, vec3i(0), vec3i(gUni.gridSize));
  return getDensity(vec3u(cc)); 
}

fn sampleWithPreview(worldPos: vec3f, cellPos: vec3u, baseDensity: f32) -> f32 {
  _sdfCurrentWorld = worldPos;
  _sdfCurrentCell = cellPos;
  _sdfContinuousBase = baseDensity; // Save the smooth continuous value
  
  // sdf() now returns the absolute new density. We calculate the difference!
  let diff = sdf() - baseDensity;
  return baseDensity + diff * previewUni.multiplier;
}
` : `
struct DummyUserParams { data: array<vec4<f32>, 4> }
@group(0) @binding(6) var<uniform> userParams: DummyUserParams;
fn sampleWithPreview(worldPos: vec3f, cellPos: vec3u, baseDensity: f32) -> f32 { return baseDensity; }
`}

// ── NEW: Centralized Effective Density ──────────────────────────────────────
fn effectiveDensity(worldPos: vec3f, cellPos: vec3u, base: f32) -> f32 {
  let mode = previewUni.previewMode;
  if (mode == 0u) { return base; }

  let margin = vec3f(gUni.voxelSize * 2.0);
  if (any(worldPos < previewUni.applyMin - margin) || any(worldPos > previewUni.applyMax + margin)) {
    return base;
  }

  let s = sampleWithPreview(worldPos, cellPos, base);

  if (cUni.meshType == 0u) { 
    if (mode == 4u) { return s; } // basic
    if (mode == 1u) { return base; } // add-overlay
    if (mode == 2u) { return base + min(0.0, s - base); } // remove-overlay
    if (mode == 3u) { return base + min(0.0, s - base); } // combined-overlay
  } else { 
    if (mode == 4u) { return base; } // basic (will be culled anyway)
    if (mode == 1u) { return base + max(0.0, s - base); } // add-overlay
    if (mode == 2u) { return base; } // remove-overlay
    if (mode == 3u) { return base + max(0.0, s - base); } // combined-overlay
  }
  return base;
}

// ── NEW: Normal Calculation properly routed through the SDF! ───────────────
fn sampleEffectiveDensityFrac(gc: vec3f) -> f32 {
  let base = sampleDensityFrac(gc);
  return effectiveDensity(gUni.gridOrigin + gc * gUni.voxelSize, vec3u(round(gc)), base);
}

${smoothNormals ? `
fn computeNormal(worldPos: vec3f) -> vec3f {
  let e = gUni.voxelSize * 0.5;
  let gc = (worldPos - gUni.gridOrigin) / gUni.voxelSize;
  let step = e / gUni.voxelSize;
  let nx = sampleEffectiveDensityFrac(gc + vec3f(step,0.0,0.0)) - sampleEffectiveDensityFrac(gc - vec3f(step,0.0,0.0));
  let ny = sampleEffectiveDensityFrac(gc + vec3f(0.0,step,0.0)) - sampleEffectiveDensityFrac(gc - vec3f(0.0,step,0.0));
  let nz = sampleEffectiveDensityFrac(gc + vec3f(0.0,0.0,step)) - sampleEffectiveDensityFrac(gc - vec3f(0.0,0.0,step));
  return normalize(-vec3f(nx, ny, nz));
}
` : ''}

${passType === 'generate' ? `
fn writeVert(baseIdx: u32, pos: vec3f${vertexFormat === 'pos3-norm3' ? ', norm: vec3f' : ''}) {
  let i = baseIdx * ${stride}u; 
  verts[i+0u]=pos.x; verts[i+1u]=pos.y; verts[i+2u]=pos.z;
  ${vertexFormat === 'pos3-norm3' ? `verts[i+3u]=norm.x; verts[i+4u]=norm.y; verts[i+5u]=norm.z;` : ''}
}
` : ''}

@compute @workgroup_size(8, 8, 4)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let cellPos = cUni.chunkOffset + gid;
  if (any(cellPos >= gUni.gridSize)) { return; }
  if (any(gid >= cUni.chunkCells))   { return; }

  var cc: array<vec3u, 8>;
  cc[0] = cellPos + vec3u(0,0,0); cc[1] = cellPos + vec3u(1,0,0);
  cc[2] = cellPos + vec3u(1,1,0); cc[3] = cellPos + vec3u(0,1,0);
  cc[4] = cellPos + vec3u(0,0,1); cc[5] = cellPos + vec3u(1,0,1);
  cc[6] = cellPos + vec3u(1,1,1); cc[7] = cellPos + vec3u(0,1,1);

  var baseD: array<f32, 8>;
  baseD[0] = getDensity(cc[0]); baseD[1] = getDensity(cc[1]);
  baseD[2] = getDensity(cc[2]); baseD[3] = getDensity(cc[3]);
  baseD[4] = getDensity(cc[4]); baseD[5] = getDensity(cc[5]);
  baseD[6] = getDensity(cc[6]); baseD[7] = getDensity(cc[7]);

  var wc: array<vec3f, 8>;
  wc[0] = cellToWorld(cc[0]); wc[1] = cellToWorld(cc[1]);
  wc[2] = cellToWorld(cc[2]); wc[3] = cellToWorld(cc[3]);
  wc[4] = cellToWorld(cc[4]); wc[5] = cellToWorld(cc[5]);
  wc[6] = cellToWorld(cc[6]); wc[7] = cellToWorld(cc[7]);

  let currentIso = select(gUni.isoLevel, previewUni.isoLevel, cUni.meshType == 1u);

  ${previewSDF ? `
  if (cUni.meshType == 1u) {
    if (previewUni.previewMode == 4u) { return; } // Basic mode has no ghost mesh!
    var changed = false;
    for (var i = 0u; i < 8u; i++) {
      if (abs(sampleWithPreview(wc[i], cc[i], baseD[i]) - baseD[i]) > previewUni.previewMargin) { changed = true; break; }
    }
    if (!changed) { return; }
  }
  ` : ''}

  var d: array<f32, 8>;
  for (var i = 0u; i < 8u; i++) { d[i] = effectiveDensity(wc[i], cc[i], baseD[i]); }

  var cubeIdx = 0u;
  ${invertDensity ? `
  if(d[0]<currentIso){cubeIdx|=1u;} if(d[1]<currentIso){cubeIdx|=2u;}
  if(d[2]<currentIso){cubeIdx|=4u;} if(d[3]<currentIso){cubeIdx|=8u;}
  if(d[4]<currentIso){cubeIdx|=16u;} if(d[5]<currentIso){cubeIdx|=32u;}
  if(d[6]<currentIso){cubeIdx|=64u;} if(d[7]<currentIso){cubeIdx|=128u;}
  ` : `
  if(d[0]>=currentIso){cubeIdx|=1u;} if(d[1]>=currentIso){cubeIdx|=2u;}
  if(d[2]>=currentIso){cubeIdx|=4u;} if(d[3]>=currentIso){cubeIdx|=8u;}
  if(d[4]>=currentIso){cubeIdx|=16u;} if(d[5]>=currentIso){cubeIdx|=32u;}
  if(d[6]>=currentIso){cubeIdx|=64u;} if(d[7]>=currentIso){cubeIdx|=128u;}
  `}
  if (edgeTable[cubeIdx] == 0u) { return; }

  ${passType === 'generate' ? `
  var ev: array<vec3f, 12>;
  if ((edgeTable[cubeIdx] & 1u)   != 0u) { ev[0]  = interpVert(wc[0],wc[1],d[0],d[1], currentIso); }
  if ((edgeTable[cubeIdx] & 2u)   != 0u) { ev[1]  = interpVert(wc[1],wc[2],d[1],d[2], currentIso); }
  if ((edgeTable[cubeIdx] & 4u)   != 0u) { ev[2]  = interpVert(wc[2],wc[3],d[2],d[3], currentIso); }
  if ((edgeTable[cubeIdx] & 8u)   != 0u) { ev[3]  = interpVert(wc[3],wc[0],d[3],d[0], currentIso); }
  if ((edgeTable[cubeIdx] & 16u)  != 0u) { ev[4]  = interpVert(wc[4],wc[5],d[4],d[5], currentIso); }
  if ((edgeTable[cubeIdx] & 32u)  != 0u) { ev[5]  = interpVert(wc[5],wc[6],d[5],d[6], currentIso); }
  if ((edgeTable[cubeIdx] & 64u)  != 0u) { ev[6]  = interpVert(wc[6],wc[7],d[6],d[7], currentIso); }
  if ((edgeTable[cubeIdx] & 128u) != 0u) { ev[7]  = interpVert(wc[7],wc[4],d[7],d[4], currentIso); }
  if ((edgeTable[cubeIdx] & 256u) != 0u) { ev[8]  = interpVert(wc[0],wc[4],d[0],d[4], currentIso); }
  if ((edgeTable[cubeIdx] & 512u) != 0u) { ev[9]  = interpVert(wc[1],wc[5],d[1],d[5], currentIso); }
  if ((edgeTable[cubeIdx] & 1024u)!= 0u) { ev[10] = interpVert(wc[2],wc[6],d[2],d[6], currentIso); }
  if ((edgeTable[cubeIdx] & 2048u)!= 0u) { ev[11] = interpVert(wc[3],wc[7],d[3],d[7], currentIso); }
  ` : ''}

  var numVerts = 0u;
  let base = cubeIdx * 16u;
  for (var i = 0u; i < 15u; i++) {
    if (triTable[base + i] < 0) { break; }
    numVerts++;
  }

  if (numVerts == 0u) { return; }
  ${passType === 'generate' ? 'let startIdx = ' : '_ = '}atomicAdd(&counters[cUni.chunkIndex], numVerts);

  ${passType === 'generate' ? `
  for (var tri = 0u; tri < numVerts / 3u; tri++) {
    let b = base + tri * 3u;
    let p0 = ev[u32(triTable[b + 2u])]; let p1 = ev[u32(triTable[b + 1u])]; let p2 = ev[u32(triTable[b + 0u])];
    
    ${vertexFormat === 'pos3-norm3' ? (smoothNormals ? `
    writeVert(startIdx + tri*3u + 0u, p0, computeNormal(p0));
    writeVert(startIdx + tri*3u + 1u, p1, computeNormal(p1));
    writeVert(startIdx + tri*3u + 2u, p2, computeNormal(p2));
    ` : `
    let faceNorm = normalize(cross(p1 - p0, p2 - p0));
    writeVert(startIdx + tri*3u + 0u, p0, faceNorm);
    writeVert(startIdx + tri*3u + 1u, p1, faceNorm);
    writeVert(startIdx + tri*3u + 2u, p2, faceNorm);
    `) : `
    writeVert(startIdx + tri*3u + 0u, p0);
    writeVert(startIdx + tri*3u + 1u, p1);
    writeVert(startIdx + tri*3u + 2u, p2);
    `}
  }
  ` : ''}
}
`;
}