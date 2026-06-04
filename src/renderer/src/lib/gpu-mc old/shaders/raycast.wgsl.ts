export function buildRaycastShader(
  capEdges: boolean, 
  densityFormat: 'f32' | 'u16' | 'u8' = 'f32',
  invertDensity: boolean = false
): string {
  return /* wgsl */`
struct Uniforms {
  origin:     vec3f, _p1: f32,
  dir:        vec3f, _p2: f32,
  gridOrigin: vec3f, _p3: f32,
  gridSize:   vec3u, _p4: u32,
  voxelSize:  f32,
  isoLevel:   f32,
  clampMin:   f32,
  clampMax:   f32,
}

@group(0) @binding(0) var<uniform> uni: Uniforms;
${densityFormat === 'f32' 
  ? `@group(0) @binding(1) var<storage, read> density: array<f32>;` 
  : `@group(0) @binding(1) var<storage, read> density: array<u32>;`
}
@group(0) @binding(2) var<storage, read_write> hitResult: array<f32>;

fn getDensity(coord: vec3i) -> f32 {
  ${capEdges ? `
  // If the ray hits the padded boundary, pretend it's empty air
  if (any(coord <= vec3i(0)) || any(coord >= vec3i(uni.gridSize))) {
    return -10000.0;
  }
  ` : ''}
  let w = uni.gridSize.x + 1u;
  let h = uni.gridSize.y + 1u;
  let idx = u32(coord.x) + u32(coord.y) * w + u32(coord.z) * w * h;
  
  ${densityFormat === 'f32' ? `
  return density[idx];
  ` : ''}
  
  ${densityFormat === 'u16' ? `
  let blockIdx = idx / 2u;
  let shift = (idx % 2u) * 16u;
  let raw = (density[blockIdx] >> shift) & 0xFFFFu;
  let norm = f32(raw) / 65535.0;
  return mix(uni.clampMin, uni.clampMax, norm);
  ` : ''}
  
  ${densityFormat === 'u8' ? `
  let blockIdx = idx / 4u;
  let shift = (idx % 4u) * 8u;
  let raw = (density[blockIdx] >> shift) & 0xFFu;
  let norm = f32(raw) / 255.0;
  return mix(uni.clampMin, uni.clampMax, norm);
  ` : ''}
}

@compute @workgroup_size(1)
fn main() {
  hitResult[0] = 0.0; // Default: No hit

  let gridMin = uni.gridOrigin;
  let gridMax = uni.gridOrigin + vec3f(uni.gridSize) * uni.voxelSize;

  // 1. Slab Method AABB Intersection
  let invDir = 1.0 / uni.dir;
  let t0 = (gridMin - uni.origin) * invDir;
  let t1 = (gridMax - uni.origin) * invDir;

  let tmin_vec = min(t0, t1);
  let tmax_vec = max(t0, t1);

  let tMin = max(max(tmin_vec.x, tmin_vec.y), tmin_vec.z);
  let tMax = min(min(tmax_vec.x, tmax_vec.y), tmax_vec.z);

  // If the ray completely misses the grid bounding box, exit instantly
  if (tMax < max(0.0, tMin)) {
     return; 
  }

  // 2. Fast Grid Stepping
  let stepSize = uni.voxelSize * 0.25; // Small step for accuracy, but loops are vastly reduced!
  var t = max(0.0, tMin);
  var prev_t = t;
  var prev_density = -10000.0;
  var first_step = true;

  for (var i = 0u; i < 5000u; i++) {
    if (t > tMax + stepSize) { break; } // Check boundary, then break

    let p = uni.origin + uni.dir * t;
    let localPos = (p - uni.gridOrigin) / uni.voxelSize;
    let coord = vec3i(round(localPos));
    let curr_density = getDensity(coord);

    if (!first_step) {
      // 3. Detect Surface Crossing
      ${invertDensity ? `
      let crossed = (prev_density >= uni.isoLevel && curr_density < uni.isoLevel);
      ` : `
      let crossed = (prev_density < uni.isoLevel && curr_density >= uni.isoLevel);
      `}

      if (crossed) {
         // 4. Linear Interpolation for Sub-Voxel Perfection
         let frac = (uni.isoLevel - prev_density) / (curr_density - prev_density);
         let hit_t = prev_t + (t - prev_t) * frac;
         let hit_p = uni.origin + uni.dir * hit_t;

         hitResult[0] = 1.0; // Hit true
         hitResult[1] = hit_p.x;
         hitResult[2] = hit_p.y;
         hitResult[3] = hit_p.z;
         return;
      }
    }

    prev_density = curr_density;
    prev_t = t;
    first_step = false;
    t += stepSize;
  }
}
`;
}