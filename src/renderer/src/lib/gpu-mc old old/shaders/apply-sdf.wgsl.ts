// ─── apply-sdf.wgsl.ts ────────────────────────────────────────────────────────
// WGSL boilerplate and shader source generator for setShader / applyShader.
//
// SDFUniforms layout (64 bytes):
//   bytes  0-11: offset (vec3f)
//   bytes 12-15: scale (f32)
//   bytes 16-19: multiplier (f32)
//   bytes 20-23: clampMin (f32)
//   bytes 24-27: clampMax (f32)
//   bytes 28-31: mode (u32)   0=add, 1=set
//   bytes 32-47: applyMin (vec3u + u32 pad)
//   bytes 48-63: applyMax (vec3u + u32 pad)

const MAX_PARAMS = 16;

// ─── Boilerplate ──────────────────────────────────────────────────────────────
// Group-0 bindings and shared helper functions injected at the top of every
// compiled shader. Group-1 bindings are added dynamically per compilation.

function getShaderBoilerplate(densityFormat: 'f32' | 'u16' | 'u8') {
  return /* wgsl */`
struct GlobalUniforms {
  gridSize:     vec3u,
  chunkSize:    u32,
  isoLevel:     f32,
  voxelSize:    f32,
  smoothNorms:  u32,
  clampMin:     f32,
  gridOrigin:   vec3f,
  clampMax:     f32,
}

struct SDFUniforms {
  offset:     vec3f,
  scale:      f32,
  multiplier: f32,
  clampMin:   f32,
  clampMax:   f32,
  mode:       u32,
  applyMin:   vec3u,
  _p4:        u32,
  applyMax:   vec3u,
  _p5:        u32,
}

@group(0) @binding(0) var<uniform> gUni: GlobalUniforms;
${densityFormat === 'f32' 
  ? `@group(0) @binding(1) var<storage, read_write> density: array<f32>;\n@group(0) @binding(2) var<storage, read> densityRead: array<f32>;` 
  : `@group(0) @binding(1) var<storage, read_write> density: array<atomic<u32>>;\n@group(0) @binding(2) var<storage, read> densityRead: array<u32>;`
}
@group(1) @binding(0) var<uniform> sUni: SDFUniforms;

var<private> _currentID: vec3u;

fn pos() -> vec3f {
  let worldPos = gUni.gridOrigin + vec3f(_currentID) * gUni.voxelSize;
  return (worldPos - sUni.offset) / sUni.scale;
}

fn val(offset: vec3i) -> f32 {
  let w  = gUni.gridSize.x + 1u;
  let h  = gUni.gridSize.y + 1u;
  let co = vec3i(_currentID) + offset;
  let cc = clamp(co, vec3i(0), vec3i(gUni.gridSize));
  let ci = u32(cc.x) + u32(cc.y) * w + u32(cc.z) * w * h;
  
  // NOW WE READ EXCLUSIVELY FROM THE DOUBLE-BUFFER SNAPSHOT!
  ${densityFormat === 'f32' ? `return densityRead[ci];` : ''}
  
  ${densityFormat === 'u16' ? `
  let blockIdx = ci / 2u;
  let shift = (ci % 2u) * 16u;
  let raw = (densityRead[blockIdx] >> shift) & 0xFFFFu;
  let norm = f32(raw) / 65535.0;
  return mix(gUni.clampMin, gUni.clampMax, norm);
  ` : ''}
  
  ${densityFormat === 'u8' ? `
  let blockIdx = ci / 4u;
  let shift = (ci % 4u) * 8u;
  let raw = (densityRead[blockIdx] >> shift) & 0xFFu;
  let norm = f32(raw) / 255.0;
  return mix(gUni.clampMin, gUni.clampMax, norm);
  ` : ''}
}
`;
}

// ─── Shader source builder ────────────────────────────────────────────────────

export function buildShaderSource(
  brushBodies: Record<string, string>,
  rawWGSL:     string,
  paramNames:  string[],
  prefix:      string,
  densityFormat: 'f32' | 'u16' | 'u8' = 'f32'
): string {
  const padCount = MAX_PARAMS - paramNames.length;
  const SHADER_BOILERPLATE = getShaderBoilerplate(densityFormat);

  // User params struct — always 64 bytes (16 f32), named fields first
  const paramStruct = /* wgsl */`
struct ${prefix}_T {
  ${paramNames.map(n => `${n}: f32,`).join('\n  ')}
  ${Array.from({ length: padCount }, (_, i) => `_r${i}: f32,`).join('\n  ')}
}
@group(1) @binding(1) var<uniform> ${prefix}: ${prefix}_T;
`;

  // ud_ wrappers: each brush body is just the statements, we wrap with fn signature
  const wrappers = Object.entries(brushBodies).map(([name, body]) => /* wgsl */`
fn ud_${name}() -> f32 {
  ${body}
}`).join('\n');

  // One entry point per brush — _currentID set before calling ud_ so pos()/val() work
  // One entry point per brush — _currentID set before calling ud_ so pos()/val() work
  const entryPoints = Object.keys(brushBodies).map(name => /* wgsl */`
@compute @workgroup_size(8, 8, 4)
fn main_${name}(@builtin(global_invocation_id) id: vec3u) {
  let gp = sUni.applyMin + id;
  if (any(gp > gUni.gridSize)) { return; }
  if (any(gp > sUni.applyMax)) { return; }

  _currentID = gp;

  let w  = gUni.gridSize.x + 1u;
  let h  = gUni.gridSize.y + 1u;
  let gi = gp.x + gp.y * w + gp.z * w * h;

  let result = ud_${name}();
  let scaled = result * sUni.multiplier;

  ${densityFormat === 'f32' ? `
  if (sUni.mode == 0u) {
    density[gi] = clamp(density[gi] + scaled, sUni.clampMin, sUni.clampMax);
  } else {
    density[gi] = clamp(scaled, sUni.clampMin, sUni.clampMax);
  }
  ` : `
  // Atomic CAS Loop for u8 / u16 packing
  let blockIdx = gi / ${densityFormat === 'u8' ? '4u' : '2u'};
  let shift = (gi % ${densityFormat === 'u8' ? '4u' : '2u'}) * ${densityFormat === 'u8' ? '8u' : '16u'};
  let mask = ${densityFormat === 'u8' ? '0xFFu' : '0xFFFFu'} << shift;
  let invMask = ~mask;

  var current_u32 = atomicLoad(&density[blockIdx]);
  loop {
    let raw = (current_u32 >> shift) & ${densityFormat === 'u8' ? '0xFFu' : '0xFFFFu'};
    let norm = f32(raw) / ${densityFormat === 'u8' ? '255.0' : '65535.0'};
    let current_f32 = mix(gUni.clampMin, gUni.clampMax, norm);

    var new_f32 = 0.0;
    if (sUni.mode == 0u) {
      new_f32 = clamp(current_f32 + scaled, sUni.clampMin, sUni.clampMax);
    } else {
      new_f32 = clamp(scaled, sUni.clampMin, sUni.clampMax);
    }

    // Clamp to storage bounds before repacking
    let clamped_global = clamp(new_f32, gUni.clampMin, gUni.clampMax);
    let new_norm = (clamped_global - gUni.clampMin) / (gUni.clampMax - gUni.clampMin);
    let new_raw = u32(new_norm * ${densityFormat === 'u8' ? '255.0' : '65535.0'} + 0.5);
    let new_u32 = (current_u32 & invMask) | ((new_raw & ${densityFormat === 'u8' ? '0xFFu' : '0xFFFFu'}) << shift);

    let exchange = atomicCompareExchangeWeak(&density[blockIdx], current_u32, new_u32);
    if (exchange.exchanged) {
      break;
    }
    current_u32 = exchange.old_value;
  }
  `}
}`).join('\n');

  return [SHADER_BOILERPLATE, paramStruct, rawWGSL, wrappers, entryPoints].join('\n');
}


// ─── MC Preview injection builder ─────────────────────────────────────────────
// Produces the WGSL string injected as `previewSDF` into buildMarchingCubesShader.
// Contains: PreviewUniforms binding, user params struct+binding, pos()/val() stubs,
// raw WGSL helpers, and fn sdf() wrapping the named brush body.

export function buildMCPreviewInjection(
  _brushName:  string,
  brushBody:  string,
  rawWGSL:    string,
  paramNames: string[],
  prefix:     string,
): string {
  const padCount = 16 - paramNames.length;
  return /* wgsl */`
struct ${prefix}_T {
  ${paramNames.map(n => `${n}: f32,`).join('\n  ')}
  ${Array.from({ length: padCount }, (_, i) => `_r${i}: f32,`).join('\n  ')}
}
@group(0) @binding(6) var<uniform> ${prefix}: ${prefix}_T;

${rawWGSL}

fn sdf() -> f32 {
  ${brushBody}
}
`;
}