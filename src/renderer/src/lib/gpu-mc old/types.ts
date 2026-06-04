export type AdapterMaterialMode = 'standard' | 'camera-normal' | 'world-normal';

export type Vec3 = [number, number, number];

export type EditOperation = 'replace' | 'add' | 'multiply';

export type PreviewMode = 'direct' | 'add-overlay' | 'remove-overlay' | 'combined-overlay';

export type VertexFormat = 'pos3' | 'pos3-norm3';

export type ApplyMode = 'add' | 'set';

export interface VolumeOptions {
  device?: GPUDevice;
  isoLevel?: number;                    // default 0.0
  smoothNormals?: boolean;              // default false
  vertexFormat?: VertexFormat;          // default 'pos3-norm3'
  allocInterval?: number;               // vertex buffer allocation step in bytes, default 1MB
  densityClamp?: [number, number];      // default [0, 1]
  capEdges?: boolean;                   // default false
  enablePreview?: boolean;              // default false
  densityFormat?: 'f32' | 'u16' | 'u8'; // default 'f32'
  invertDensity?: boolean;              // default false
}

// ─── setShader / applyShader ──────────────────────────────────────────────────

/**
 * Passed to setShader(). Keys other than 'WGSL' become named brush entry points.
 *
 * @example
 * {
 *   WGSL: `fn falloff(d: f32) -> f32 { return smoothstep(1.0, 0.0, d); }`,
 *   sphere: `return falloff(clamp(length(pos()), 0.0, 1.0));`,
 *   cube:   `let p = abs(pos()); return falloff(max(p.x, max(p.y, p.z)));`,
 * }
 */
export interface ShaderDefinition {
  /** Raw WGSL injected verbatim — helper functions, constants, etc. */
  WGSL?: string;
  /** Brush name → function body. Each body is wrapped in fn ud_<name>() -> f32. */
  [brushName: string]: string | undefined;
}

/**
 * Passed to applyShader(). Selects which brush to run and how.
 */
export interface ApplyShaderOptions {
  /** Name of the brush to dispatch (must match a key in setShader's first arg). */
  brush: string;

  /**
   * 'add' (default): density[voxel] += brushResult * multiplier  (clamped)
   * 'set':           density[voxel]  = brushResult * multiplier  (clamped)
   */
  mode?: ApplyMode;

  /** Bounding box min in voxel coords. Default: [0,0,0] */
  min?: Vec3;

  /** Bounding box max in voxel coords. Default: gridSize */
  max?: Vec3;

  /**
   * World-space brush center. Shifts the value returned by pos() so that
   * length(pos()) == 0 at this point and == 1 at radius distance.
   */
  offset?: Vec3;

  /**
   * World-space brush radius. pos() is divided by this, so a unit-sphere SDF
   * (length(pos()) <= 1) covers exactly `scale` world units.
   * Default: 1.0
   */
  scale?: number;

  /**
   * Scales the brush output before add/set. For 'add' mode, positive = add
   * material, negative = remove. For 'set' mode, scales the target density.
   * Default: 1.0
   */
  multiplier?: number;

  /**
   * Partial param update. Only the listed keys are changed; others keep their
   * current values. Keys must match names declared in setShader().
   */
params?: Record<string, number>;
}

export interface PreviewShaderOptions {
  brush: string;
  /**
   * Preview display mode.
   *   'direct'         — SDF applied directly to main mesh (no ghost). Default.
   *   'add-overlay'    — real mesh + transparent ghost of added region
   *   'remove-overlay' — subtracted mesh + transparent ghost of removed region  
   *   'combined-overlay' — both add and remove shown simultaneously
   */
  mode?: PreviewMode;
  min?: Vec3;
  max?: Vec3;
  offset?: Vec3;
  scale?: number;
  multiplier?: number;
  isoLevel?: number;
  previewMargin?: number;
  params?: Record<string, number>;
}

// ─── Internal ────────────────────────────────────────────────────────────────

/** Internal options passed to _makeSdfUniformBuffer. */
export interface SDFApplyOptions {
  min?: Vec3;
  max?: Vec3;
  multiplier?: number;
  offset?: Vec3;
  scale?: number;
  mode?: ApplyMode;
}

export interface PreviewOptions extends SDFApplyOptions {
  previewMode?: PreviewMode;
}

// Internal per-chunk state tracked on CPU
export interface ChunkInfo {
  index: number;
  cx: number; cy: number; cz: number;
  cellOffset: Vec3;
  dirty: boolean;
  allocatedVerts: number;
  underusedFrames: number;
  lastVertCount: number;
}

export interface ChunkGPUBuffers {
  vertexBuffer: GPUBuffer;
  vertexCount: number;
  boundingBoxMin: Vec3;
  boundingBoxMax: Vec3;
}

export interface PreviewGPUBuffers {
  primaryBuffer: GPUBuffer;
  primaryCount: number;
  secondaryBuffer: GPUBuffer | null;
  secondaryCount: number;
}

export interface GlobalUniformData {
  gridSize: Vec3;
  chunkSize: number;
  isoLevel: number;
  voxelSize: number;
  smoothNormals: number;
  _pad: number;
  gridOrigin: Vec3;
  _pad2: number;
}

export interface ChunkUniformData {
  chunkOffset: Vec3;
  chunkIndex: number;
  chunkCellSize: Vec3;
  _pad: number;
}




export interface VolumeUpdateOptions {
  measure?: boolean;
}

export interface VolumePreviewUpdateStats {
  requestedVertices: number;
  generatedVertices: number;
  allocatedVertices: number;
  allocatedBytes: number;
  timeMs: number;
}

export interface VolumeMainUpdateStats {
  dirtyChunks: number;
  generatedVertices: number;
  allocatedVertices: number;
  allocatedBytes: number;
  timeMs: number;
}

export interface VolumeUpdateStats {
  totalTimeMs: number;
  skipped?: boolean;
  preview?: VolumePreviewUpdateStats;
  main?: VolumeMainUpdateStats;
}

export interface VolumeMeshMemoryStats {
  chunkCount: number;
  dirtyChunks: number;
  allocatedChunks: number;
  nonEmptyChunks: number;
  allocatedVertices: number;
  liveVertices: number;
  vertexBytes: number;
}

export interface VolumePreviewMemoryStats {
  allocatedVertices: number;
  liveVertices: number;
  vertexBytes: number;
  counterBytes: number;
  stagingBytes: number;
}

export interface VolumeMemoryStats {
  densityBytes: number;
  densitySnapshotBytes: number;
  main: VolumeMeshMemoryStats;
  preview: VolumePreviewMemoryStats;
  counterBytes: number;
  stagingBytes: number;
  fixedBufferBytes: number;
  totalKnownBytes: number;
}