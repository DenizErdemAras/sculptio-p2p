// ─── Edit Matrix Shader ───────────────────────────────────────────────────────
// Applies a CPU-uploaded patch into the density buffer.

export function buildEditMatrixShader(densityFormat: 'f32' | 'u16' | 'u8' = 'f32'): string {
  return /* wgsl */`
struct Uniforms {
  gridSize:  vec3u,
  _p0:       u32,
  patchSize: vec3u,
  operation: u32,   // 0=replace, 1=add, 2=multiply
  offset:    vec3u,
  _p1:       u32,
  clampMin:  f32,
  clampMax:  f32,
  _p2:       vec2u, // 16-byte alignment padding
}

@group(0) @binding(0) var<uniform> uni: Uniforms;
${densityFormat === 'f32' 
  ? `@group(0) @binding(1) var<storage, read_write> density: array<f32>;` 
  : `@group(0) @binding(1) var<storage, read_write> density: array<atomic<u32>>;`
}
@group(0) @binding(2) var<storage, read>       patchData: array<f32>;

@compute @workgroup_size(8, 8, 4)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id >= uni.patchSize)) { return; }

  let gp = id + uni.offset;
  if (any(gp > uni.gridSize)) { return; } // > not >= because density is (gridSize+1)^3

  let w  = uni.gridSize.x + 1u;
  let h  = uni.gridSize.y + 1u;
  let gi = gp.x + gp.y * w + gp.z * w * h;

  let pi = id.x + id.y * uni.patchSize.x + id.z * uni.patchSize.x * uni.patchSize.y;
  let v  = patchData[pi];

  ${densityFormat === 'f32' ? `
  switch (uni.operation) {
    case 0u: { density[gi]  = v; }
    case 1u: { density[gi] += v; }
    case 2u: { density[gi] *= v; }
    default: {}
  }
  ` : `
  // Atomic CAS Loop
  let blockIdx = gi / ${densityFormat === 'u8' ? '4u' : '2u'};
  let shift = (gi % ${densityFormat === 'u8' ? '4u' : '2u'}) * ${densityFormat === 'u8' ? '8u' : '16u'};
  let mask = ${densityFormat === 'u8' ? '0xFFu' : '0xFFFFu'} << shift;
  let invMask = ~mask;

  var current_u32 = atomicLoad(&density[blockIdx]);
  loop {
    let raw = (current_u32 >> shift) & ${densityFormat === 'u8' ? '0xFFu' : '0xFFFFu'};
    let norm = f32(raw) / ${densityFormat === 'u8' ? '255.0' : '65535.0'};
    let current_f32 = mix(uni.clampMin, uni.clampMax, norm);

    var new_f32 = current_f32;
    switch (uni.operation) {
      case 0u: { new_f32  = v; }
      case 1u: { new_f32 += v; }
      case 2u: { new_f32 *= v; }
      default: {}
    }

    let clamped = clamp(new_f32, uni.clampMin, uni.clampMax);
    let new_norm = (clamped - uni.clampMin) / (uni.clampMax - uni.clampMin);
    let new_raw = u32(new_norm * ${densityFormat === 'u8' ? '255.0' : '65535.0'} + 0.5);
    let new_u32 = (current_u32 & invMask) | ((new_raw & ${densityFormat === 'u8' ? '0xFFu' : '0xFFFFu'}) << shift);

    let exchange = atomicCompareExchangeWeak(&density[blockIdx], current_u32, new_u32);
    if (exchange.exchanged) { break; }
    current_u32 = exchange.old_value;
  }
  `}
}
`;
}