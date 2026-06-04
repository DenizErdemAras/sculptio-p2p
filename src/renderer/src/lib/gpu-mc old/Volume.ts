import type {
    Vec3,
    VolumeOptions,
    SDFApplyOptions,
    ApplyShaderOptions,
    PreviewShaderOptions,
    ShaderDefinition,
    EditOperation,
    VolumeUpdateOptions,
    VolumeUpdateStats,
    VolumePreviewUpdateStats,
    VolumeMemoryStats,
} from './types';
import { SharedBuffers, StagingBuffer, VRAMTrash } from './BufferManager';
import { PipelineManager } from './PipelineManager';
import { ChunkManager } from './ChunkManager';
import { ShaderManager } from './ShaderManager';
import { PreviewManager } from './PreviewManager';
import { buildMCPreviewInjection } from './shaders/apply-sdf.wgsl';
import { EDGE_TABLE, TRI_TABLE } from './shaders/tables';

type PreviewPending = {
  bboxDims: Vec3;
  generation: number;
};

export class Volume {
  // ── Public readonly metadata ─────────────────────────────────────────────
  readonly gridSize:  [number, number, number];
  readonly chunkSize: number;
  readonly voxelSize: number;
  readonly gridOrigin:[number, number, number];
  readonly vertexFormat: 'pos3' | 'pos3-norm3';
  readonly floatsPerVert: number;

  // ── Private GPU/CPU state ────────────────────────────────────────────────
  private device:        GPUDevice;
  private shared:        SharedBuffers;
  private pipelines:     PipelineManager;
  private chunks:        ChunkManager;
  private staging:       StagingBuffer;

  private _isoLevel:      number;
  private _smoothNormals: boolean;
  private _densityClamp:  [number, number]; // Added clamping state
  private _densityFormat: 'f32' | 'u16' | 'u8';
  private _invertDensity: boolean;
  private _allocInterval: number;
  
  private _internalGridSize: [number, number, number]; // <-- NEW
  private _pad: number; // <-- NEW
  private previewUniBuf: GPUBuffer;
  private dummyParamsBuf: GPUBuffer;
  private densitySnapshot!: GPUBuffer;
  private _oldPreviewAABB: { min: Vec3, max: Vec3 } | null = null;
  private _lastPreviewMode: number = 0;

  // Shared bind group (group 0) for MC — rebuilt only when isoLevel/smoothNormals change
  private mcSharedBindGroup: GPUBindGroup | null = null;
  // Shared bind group for applyShader (group 0: globalUni + density)
  private sdfSharedBindGroup: GPUBindGroup | null = null;
  // User shader manager — created on first setShader() call
  private shaderManager: ShaderManager | null = null;
  // Preview mesh manager — created on first setShader() call
  private previewManager: PreviewManager | null = null;
  private _previewPending: PreviewPending | null = null;
  private _previewGeneration = 0;
  private _previewSharedBindGroupCache: GPUBindGroup | null = null;
  _onPreviewUpdated?: () => void;

  // ── Construction (use newVolume factory) ─────────────────────────────────
  private constructor(
    device:        GPUDevice,
    gridSize:      [number, number, number],
    chunkSize:     number,
    options:       Required<VolumeOptions>,
    shared:        SharedBuffers,
    pipelines:     PipelineManager,
    chunks:        ChunkManager,
  ) {
    this.device        = device;
    this.gridSize      = gridSize;
    this.chunkSize     = chunkSize;
    this.voxelSize     = 1.0; 

    this._pad = options.capEdges ? 1 : 0;
    this._internalGridSize = [
      gridSize[0] + this._pad * 2,
      gridSize[1] + this._pad * 2,
      gridSize[2] + this._pad * 2
    ];

    this.gridOrigin    = [
      -(this._internalGridSize[0] * this.voxelSize) / 2,
      -(this._internalGridSize[1] * this.voxelSize) / 2,
      -(this._internalGridSize[2] * this.voxelSize) / 2,
    ];

    this.vertexFormat   = options.vertexFormat ?? 'pos3-norm3';
    this.floatsPerVert  = this.vertexFormat === 'pos3' ? 3 : 6;
    this._isoLevel      = options.isoLevel;
    this._smoothNormals = options.smoothNormals;
    this._densityClamp  = options.densityClamp; // Initialize clamp
    this._densityFormat = (options as any).densityFormat ?? 'f32';
    this._invertDensity = (options as any).invertDensity ?? false;
    this._allocInterval = options.allocInterval ?? 1024 * 1024;
    this.shared         = shared;
    this.pipelines      = pipelines;
    this.chunks         = chunks;

    // Use internal grid, not original grid!
    const totalPoints = (this._internalGridSize[0]+1) * (this._internalGridSize[1]+1) * (this._internalGridSize[2]+1);
    
    // Calculate accurate byte size based on chosen compression
    let densityBytes = totalPoints * 4;
    if (this._densityFormat === 'u16') densityBytes = Math.ceil(totalPoints / 2) * 4;
    if (this._densityFormat === 'u8')  densityBytes = Math.ceil(totalPoints / 4) * 4;

    this.staging = new StagingBuffer(device, Math.max(densityBytes, 4096));

    this.previewUniBuf = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.dummyParamsBuf = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    // Snapshot buffer — kept in sync with density after every applyShader/editMatrix.
    // Used by val() in brush shaders so reads see pre-stroke state, not mid-write state.
    this.densitySnapshot = device.createBuffer({
      size: this.shared.density.size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      label: 'density-snapshot',
    });
    // No initial copy needed — density and snapshot both start zeroed by the GPU driver.

    this._writeGlobalUniforms();
    this._buildMCSharedBindGroup();
    this._buildSdfSharedBindGroup();
  }

  // ── Factory ───────────────────────────────────────────────────────────────
  static async create(
    gridSize: [number, number, number],
    chunkSizeArg?: number | null,
    options: VolumeOptions = {},
  ): Promise<Volume> {
    const chunkSize = chunkSizeArg ?? Math.max(gridSize[0], gridSize[1], gridSize[2]);

    const opts: Required<VolumeOptions> & { densityFormat: 'f32'|'u16'|'u8', invertDensity: boolean } = {
      device:        options.device!,
      isoLevel:      options.isoLevel      ?? 0.0,
      smoothNormals: options.smoothNormals ?? false,
      allocInterval: options.allocInterval ?? 1 * 1024 * 1024,
      vertexFormat:  options.vertexFormat  ?? 'pos3-norm3', 
      densityClamp:  options.densityClamp  ?? [0.0, 1.0],
      capEdges:      options.capEdges      ?? false,
      enablePreview: options.enablePreview ?? false,
      densityFormat: (options as any).densityFormat ?? 'f32',
      invertDensity: (options as any).invertDensity ?? false,
    };

    const pad = opts.capEdges ? 1 : 0;
    const internalGrid: [number, number, number] = [
      gridSize[0] + pad * 2,
      gridSize[1] + pad * 2,
      gridSize[2] + pad * 2
    ];

    let device = opts.device;
    if (!device) {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) throw new Error('gpu-mc: WebGPU not available');
      device = await adapter.requestDevice();
    }

    const totalPoints = (internalGrid[0]+1) * (internalGrid[1]+1) * (internalGrid[2]+1);
    const chunksX = Math.ceil(internalGrid[0] / chunkSize);
    const chunksY = Math.ceil(internalGrid[1] / chunkSize);
    const chunksZ = Math.ceil(internalGrid[2] / chunkSize);
    const chunkCount = chunksX * chunksY * chunksZ;

    const shared    = new SharedBuffers(device, totalPoints, chunkCount, TRI_TABLE, EDGE_TABLE, opts.densityFormat);
    const vertexFormat = options.vertexFormat ?? 'pos3-norm3';
    const pipelines = new PipelineManager(device, vertexFormat);
    await pipelines.init(opts.smoothNormals, opts.capEdges, opts.densityFormat, opts.invertDensity);

    const chunks = new ChunkManager(
      device, internalGrid, chunkSize, // Use internalGrid here
      pipelines,
      opts.allocInterval,
      vertexFormat === 'pos3' ? 3 : 6
    );

    return new Volume(device, gridSize, chunkSize, opts, shared, pipelines, chunks);
  }

  // ── Getters / Setters ─────────────────────────────────────────────────────
  get isoLevel(): number { return this._isoLevel; }
  set isoLevel(v: number) { this.setIsoLevel(v); }

  setIsoLevel(v: number): void {
    this._isoLevel = v;
    this._writeGlobalUniforms();
    this.chunks.markAllDirty();
  }

  get densityClamp(): [number, number] { return this._densityClamp; }
  set densityClamp(v: [number, number]) { this.setDensityClamp(v); }

  setDensityClamp(v: [number, number]): void {
    this._densityClamp = [v[0], v[1]];
  }

  async setSmooth(enabled: boolean): Promise<void> {
    if (enabled && this.vertexFormat === 'pos3') {
      console.warn("gpu-mc: Cannot enable smooth normals on a volume initialized with 'pos3' format.");
      return;
    }
    if (this._smoothNormals === enabled) return;
    this._smoothNormals = enabled;
    this._writeGlobalUniforms();
    
    // 1. Recompile the base MC pipelines
    await this.pipelines.recompileMC(enabled, this._densityFormat, this._invertDensity);

    // 2. Recompile all the custom preview pipelines!
    if (this.shaderManager) {
      const { brushBodies, rawWGSL, paramNames: pNames, prefix: pfx } = this.shaderManager.getPreviewData();
      this.pipelines.clearPreviewPipelines();
      await Promise.all(
        Object.entries(brushBodies).map(([name, body]) => {
          const injection = buildMCPreviewInjection(name, body, rawWGSL, pNames, pfx);
          return this.pipelines.compileMCPreview(
            name, injection, this._smoothNormals, this._densityFormat, this._invertDensity,
          );
        })
      );
    }

    this.chunks.rebuildAllBindGroups();
    this.chunks.markAllDirty();
  }

  // ── editMatrix ────────────────────────────────────────────────────────────
  editMatrix(
    data:      Float32Array,
    dims:      Vec3,
    offset:    Vec3  = [0, 0, 0],
    operation: EditOperation = 'replace',
  ): void {
    const opIdx = { replace: 0, add: 1, multiply: 2 }[operation];
    if (opIdx === undefined) throw new Error(`gpu-mc: unknown operation "${operation}"`);

    const patchBuf = this.device.createBuffer({
      size:  data.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: 'patch',
    });
    this.device.queue.writeBuffer(patchBuf, 0, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));

    const uni = new ArrayBuffer(64);
    const u32 = new Uint32Array(uni);
    const f32 = new Float32Array(uni);
    
    u32[0] = this._internalGridSize[0]; u32[1] = this._internalGridSize[1]; u32[2] = this._internalGridSize[2]; u32[3] = 0;
    u32[4] = dims[0];          u32[5] = dims[1];           u32[6] = dims[2];           u32[7] = opIdx;
    u32[8] = offset[0];        u32[9] = offset[1];         u32[10]= offset[2];         u32[11]= 0;
    f32[12]= this._densityClamp[0]; f32[13]= this._densityClamp[1]; f32[14]= 0;        f32[15]= 0;
    
    const uniBuf = this.device.createBuffer({
      size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'edit-uni',
    });
    this.device.queue.writeBuffer(uniBuf, 0, uni);

    const bindGroup = this.device.createBindGroup({
      layout: this.pipelines.editMatrixLayout,
      entries: [
        { binding: 0, resource: { buffer: uniBuf   } },
        { binding: 1, resource: { buffer: this.shared.density } },
        { binding: 2, resource: { buffer: patchBuf } },
      ],
    });

    const encoder = this.device.createCommandEncoder();
    const pass    = encoder.beginComputePass();
    pass.setPipeline(this.pipelines.editMatrix);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(
      Math.ceil(dims[0] / 8),
      Math.ceil(dims[1] / 8),
      Math.ceil(dims[2] / 4),
    );
    pass.end();
    // Sync snapshot so subsequent brush val() calls see the updated density.
    encoder.copyBufferToBuffer(this.shared.density, 0, this.densitySnapshot, 0, this.shared.density.size);
    this.device.queue.submit([encoder.finish()]);

    this.device.queue.onSubmittedWorkDone().then(() => {
      patchBuf.destroy();
      uniBuf.destroy();
    });

    const maxCoord: Vec3 = [
      offset[0] + dims[0],
      offset[1] + dims[1],
      offset[2] + dims[2],
    ];
    this.chunks.markDirtyInAABB(offset, maxCoord);
  }

  // ── setShader ─────────────────────────────────────────────────────────────

  /**
   * Compile a set of named brush functions. Returns a promise that resolves
   * once all GPU pipelines are ready (typically 5–50ms).
   *
   * @param shaders     Object whose keys are brush names and values are WGSL
   *                    function bodies. The special key 'WGSL' is injected
   *                    verbatim as raw helper code before the brush functions.
   * @param paramNames  Ordered list of named f32 parameters (max 16).
   * @param prefix      Variable name prefix for params in WGSL. Default 'param'.
   *                    Access as e.g. param.radius.
   *
   * @example
   * await model.setShader({
   *   WGSL: `fn falloff(d: f32) -> f32 { return smoothstep(1.0, 0.0, d); }`,
   *   sphere: `return falloff(clamp(length(pos()), 0.0, 1.0));`,
   *   cube:   `let p = abs(pos()); return falloff(max(p.x, max(p.y, p.z)));`,
   * }, ['radius', 'strength'], 'param');
   */
  async setShader(
    shaders:    ShaderDefinition,
    paramNames: string[] = [],
    prefix      = 'param',
  ): Promise<void> {
    if (!this.shaderManager) {
      this.shaderManager = new ShaderManager(this.device, this.pipelines.applySdfSharedLayout, this._densityFormat);
    }
    await this.shaderManager.compile(shaders, paramNames, prefix);

    // Rebind the shared group now that the real param buffer exists!
    this._buildMCSharedBindGroup();

    if (!this.previewManager) {
      this.previewManager = new PreviewManager(
        this.device, this.pipelines, this.floatsPerVert, this._allocInterval,
      );
    }

    const { brushBodies, rawWGSL, paramNames: pNames, prefix: pfx } = this.shaderManager.getPreviewData();
    this.pipelines.clearPreviewPipelines();
    await Promise.all(
      Object.entries(brushBodies).map(([name, body]) => {
        const injection = buildMCPreviewInjection(name, body, rawWGSL, pNames, pfx);
        return this.pipelines.compileMCPreview(
          name, injection, this._smoothNormals, this._densityFormat, this._invertDensity,
        );
      })
    );
  }

  // ── applyShader ───────────────────────────────────────────────────────────

  /**
   * Dispatch a named brush to the GPU. Synchronous — dispatches and returns
   * immediately. Call model.update() to remesh affected chunks.
   *
   * @param opts  Which brush to run, spatial bounds, and optional param updates.
   */
  applyShader(opts: ApplyShaderOptions): void {
    if (!this.shaderManager?.ready) {
      console.warn('gpu-mc: call setShader() before applyShader()'); return;
    }

    const pipeline = this.shaderManager.getPipeline(opts.brush);
    if (!pipeline) {
      console.warn(`gpu-mc: unknown brush "${opts.brush}". Available: ${this.shaderManager.getBrushNames().join(', ')}`);
      return;
    }

    // Partial param update — only specified keys change
    if (opts.params) {
      this.shaderManager.updateParams(opts.params);
    }

    const userMin = opts.min ?? [0, 0, 0];
    const userMax = opts.max ?? this.gridSize as Vec3;
    const min: Vec3 = [userMin[0]+this._pad, userMin[1]+this._pad, userMin[2]+this._pad];
    const max: Vec3 = [userMax[0]+this._pad, userMax[1]+this._pad, userMax[2]+this._pad];

    const sdfUniBuf = this._makeSdfUniformBuffer(opts, min, max);

    const bindGroup = this.device.createBindGroup({
      layout: this.shaderManager.chunkLayout,
      entries: [
        { binding: 0, resource: { buffer: sdfUniBuf } },
        { binding: 1, resource: { buffer: this.shaderManager.getParamBuffer() } },
      ],
    });

    const dimX = (max[0] - min[0]) + 1;
    const dimY = (max[1] - min[1]) + 1;
    const dimZ = (max[2] - min[2]) + 1;

    const encoder = this.device.createCommandEncoder();
    const pass    = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.sdfSharedBindGroup!);
    pass.setBindGroup(1, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(dimX/8), Math.ceil(dimY/8), Math.ceil(dimZ/4));
    pass.end();
    
    // INSTANTLY sync the snapshot so the next brush stroke reads the new geometry!
    encoder.copyBufferToBuffer(this.shared.density, 0, this.densitySnapshot, 0, this.shared.density.size);
    this.device.queue.submit([encoder.finish()]);

    this.device.queue.onSubmittedWorkDone().then(() => sdfUniBuf.destroy());
    this.chunks.markDirtyInAABB(min, max);
  }

  // ── setParam ──────────────────────────────────────────────────────────────

  /**
   * Update a single named param without dispatching. Use applyShader() to apply.
   */
  setParam(name: string, value: number): void {
    this.shaderManager?.setParam(name, value);
  }

  /**
   * Get the current value of a named param.
   */
  getParam(name: string): number | undefined {
    return this.shaderManager?.getParam(name);
  }

  // ── previewShader ─────────────────────────────────────────────────────────

  previewShader(opts: PreviewShaderOptions): void {
    if (!this.shaderManager?.ready || !this.previewManager) return;

    if (opts.params) this.shaderManager.updateParams(opts.params);


    const userMin = opts.min ?? [0, 0, 0];
    const userMax = opts.max ?? this.gridSize as Vec3;

    const min: Vec3 = [
      userMin[0] + this._pad,
      userMin[1] + this._pad,
      userMin[2] + this._pad,
    ];

    const max: Vec3 = [
      userMax[0] + this._pad,
      userMax[1] + this._pad,
      userMax[2] + this._pad,
    ];

    const bboxDims: Vec3 = [
      max[0] - min[0] + 1,
      max[1] - min[1] + 1,
      max[2] - min[2] + 1,
    ];

    if (bboxDims[0] <= 0 || bboxDims[1] <= 0 || bboxDims[2] <= 0) {
        this.clearPreview();
        return;
    }

    // Mark old and new AABBs dirty so chunks remesh with/without the SDF.
    if (this._oldPreviewAABB) {
        this.chunks.markDirtyInAABB(this._oldPreviewAABB.min, this._oldPreviewAABB.max);
    }

    this.chunks.markDirtyInAABB(min, max);
    this._oldPreviewAABB = { min, max };

    const modeMap: Record<string, number> = {
      'add-overlay': 1,
      'remove-overlay': 2,
      'combined-overlay': 3,
      'direct': 4,
    };

    const mode = modeMap[opts.mode ?? 'direct'] ?? 4;
    this._lastPreviewMode = mode;

    const f32 = new Float32Array(16);
    const u32 = new Uint32Array(f32.buffer);

    f32[0] = opts.offset?.[0] ?? 0;
    f32[1] = opts.offset?.[1] ?? 0;
    f32[2] = opts.offset?.[2] ?? 0;
    f32[3] = opts.scale ?? 1.0;
    f32[4] = opts.multiplier ?? 1.0;
    u32[5] = mode;
    f32[6] = opts.previewMargin ?? 0.001;

    f32[8] = min[0] * this.voxelSize + this.gridOrigin[0];
    f32[9] = min[1] * this.voxelSize + this.gridOrigin[1];
    f32[10] = min[2] * this.voxelSize + this.gridOrigin[2];

    f32[12] = max[0] * this.voxelSize + this.gridOrigin[0];
    f32[13] = max[1] * this.voxelSize + this.gridOrigin[1];
    f32[14] = max[2] * this.voxelSize + this.gridOrigin[2];

    f32[15] = opts.isoLevel ?? this._isoLevel;

    this.device.queue.writeBuffer(this.previewUniBuf, 0, f32.buffer);

    // Select the preview brush. PipelineManager.mcCount/mcGenerate will now
    // return that brush's preview count/generate pipelines.
    this.pipelines.setActivePreviewBrush(opts.brush);

    this.previewManager.writeChunkUniforms(min, bboxDims, 1);

    const generation = ++this._previewGeneration;

    const encoder = this.device.createCommandEncoder();
    encoder.clearBuffer(this.previewManager.counterBuf);

    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipelines.mcCount);
    pass.setBindGroup(0, this._buildPreviewSharedBindGroup());
    pass.setBindGroup(1, this.previewManager.buildCountBindGroup());
    pass.dispatchWorkgroups(
      Math.ceil(bboxDims[0] / 8),
      Math.ceil(bboxDims[1] / 8),
      Math.ceil(bboxDims[2] / 4),
    );
    pass.end();

    encoder.copyBufferToBuffer(
      this.previewManager.counterBuf,
      0,
      this.previewManager.counterStagingBuf,
      0,
      4,
    );

    this.device.queue.submit([encoder.finish()]);

    this._previewPending = {
      bboxDims,
      generation,
    };
  }

  clearPreview(): void {
    // Modes 2 (remove), 3 (combined), and 4 (direct) all deform the main mesh.
    const needsRemesh =
      this._lastPreviewMode === 2 ||
      this._lastPreviewMode === 3 ||
    this._lastPreviewMode === 4;

    if (this._oldPreviewAABB) {
      this.chunks.markDirtyInAABB(this._oldPreviewAABB.min, this._oldPreviewAABB.max);
      this._oldPreviewAABB = null;
    }

    this._previewGeneration++;
    this._previewPending = null;

    this.pipelines.setActivePreviewBrush(null);
    this.device.queue.writeBuffer(this.previewUniBuf, 20, new Uint32Array([0]));

    if (this.previewManager) {
      this.previewManager.vertCount = 0;
    }

    this._lastPreviewMode = 0;
    this._onPreviewUpdated?.();

    if (needsRemesh) {
      this.update();
    }
  }

  // ── update ────────────────────────────────────────────────────────────────
  private _isMeshing = false;

  async update(): Promise<void>;
async update(options: { measure: false }): Promise<void>;
async update(options: { measure: true }): Promise<VolumeUpdateStats>;
async update(options: VolumeUpdateOptions = {}): Promise<void | VolumeUpdateStats> {
    const measure = options.measure === true;
    const totalStart = this._now();

    const stats: VolumeUpdateStats = {
        totalTimeMs: 0,
    };

    const finish = (): VolumeUpdateStats | void => {
        stats.totalTimeMs = this._now() - totalStart;
        return measure ? stats : undefined;
    };

    VRAMTrash.tick();

    if (this._isMeshing) {
        stats.skipped = true;
        return finish();
    }

    // ── Preview two-pass state machine ─────────────────────────────────────
    if (this._previewPending && this.previewManager) {
      const previewStats = await this._processPreviewPending();

      if (previewStats) {
        stats.preview = previewStats;
      }
    }

    if (this._isMeshing) {
        stats.skipped = true;
        return finish();
    }

    // ── Main mesh: count pass ──────────────────────────────────────────────
    const mainStart = this._now();

    let encoder = this.device.createCommandEncoder();
    encoder.clearBuffer(this.shared.counters);

    const dispatched = this.chunks.dispatchCount(encoder, this.mcSharedBindGroup!);

    if (dispatched.length === 0) {
        return finish();
    }

    encoder.copyBufferToBuffer(
        this.shared.counters,
        0,
        this._counterStagingBuf,
        0,
        this.chunks.chunkCount * 4,
    );

    this.device.queue.submit([encoder.finish()]);

    this._isMeshing = true;

    try {
      await this._counterStagingBuf.mapAsync(
        GPUMapMode.READ,
        0,
        this.chunks.chunkCount * 4,
      );

      const counts = new Uint32Array(
        this._counterStagingBuf
          .getMappedRange(0, this.chunks.chunkCount * 4)
          .slice(0),
      );

      this._counterStagingBuf.unmap();

      let generatedVertices = 0;
      for (const res of dispatched) {
        generatedVertices += counts[res.info.index];
      }

      encoder = this.device.createCommandEncoder();
      encoder.clearBuffer(this.shared.counters);

      this.chunks.allocateAndDispatchGenerate(
        encoder,
        this.mcSharedBindGroup!,
        dispatched,
        counts,
      );

      this.device.queue.submit([encoder.finish()]);
      this._onCountersUpdated?.();

      if (measure) {
        const mem = this.chunks.getMemoryStats();

        stats.main = {
          dirtyChunks: dispatched.length,
          generatedVertices,
          allocatedVertices: mem.allocatedVertices,
          allocatedBytes: mem.vertexBytes,
          timeMs: this._now() - mainStart,
        };
      }
    } finally {
      this._isMeshing = false;
    }

    return finish();
  }

  private async _processPreviewPending(): Promise<VolumePreviewUpdateStats | undefined> {
    const pending = this._previewPending;
    const preview = this.previewManager;

    if (!pending || !preview) {
        return undefined;
    }

    const start = this._now();

    // Consume the pending count result. If a newer preview is requested while
    // this async readback is waiting, previewShader() will set a newer generation.
    this._previewPending = null;
    this._isMeshing = true;

    try {
      await preview.counterStagingBuf.mapAsync(GPUMapMode.READ, 0, 4);

      const raw = new Uint32Array(
        preview.counterStagingBuf.getMappedRange(0, 4).slice(0),
      );

      preview.counterStagingBuf.unmap();

      // Ignore stale readback from an older preview request.
      if (pending.generation !== this._previewGeneration) {
        return undefined;
      }

      const count = raw[0];

      preview.ensureCapacity(count);

      if (count === 0 || !preview.vertBuf.buffer) {
        preview.vertCount = 0;
        this._onPreviewUpdated?.();

        return {
          requestedVertices: count,
          generatedVertices: 0,
          allocatedVertices: preview.allocatedVerts,
          allocatedBytes: preview.allocatedBytes,
          timeMs: this._now() - start,
        };
      }

      const generateBindGroup = preview.buildGenerateBindGroup();

      if (!generateBindGroup) {
        preview.vertCount = 0;
        this._onPreviewUpdated?.();

        return {
          requestedVertices: count,
          generatedVertices: 0,
          allocatedVertices: preview.allocatedVerts,
          allocatedBytes: preview.allocatedBytes,
          timeMs: this._now() - start,
        };
      }

      const encoder = this.device.createCommandEncoder();

      // Required: generate pass uses atomicAdd(counter) as vertex write cursor.
      encoder.clearBuffer(preview.counterBuf);

      const pass = encoder.beginComputePass();
      pass.setPipeline(this.pipelines.mcGenerate);
      pass.setBindGroup(0, this._buildPreviewSharedBindGroup());
      pass.setBindGroup(1, generateBindGroup);
      pass.dispatchWorkgroups(
        Math.ceil(pending.bboxDims[0] / 8),
        Math.ceil(pending.bboxDims[1] / 8),
        Math.ceil(pending.bboxDims[2] / 4),
      );
      pass.end();

      this.device.queue.submit([encoder.finish()]);

      // The count pass already told us how many vertices will be generated.
      // Rendering after update() submits later commands to the same queue,
      // so the generate pass runs before the render pass.
      preview.vertCount = count;
      this._onPreviewUpdated?.();

      return {
        requestedVertices: count,
        generatedVertices: count,
        allocatedVertices: preview.allocatedVerts,
        allocatedBytes: preview.allocatedBytes,
        timeMs: this._now() - start,
      };
    } finally {
      this._isMeshing = false;
    }
  }

  private _counterStagingBuf!: GPUBuffer;
  _onCountersUpdated?: () => void;

  // Persistent raycast buffers — allocated once, reused every call
  private _raycastUniBuf!:     GPUBuffer;
  private _raycastHitBuf!:     GPUBuffer;
  private _raycastStagingBuf!: GPUBuffer;

  // ── Raw GPU access ────────────────────────────────────────────────────────
  getRawBuffers() {
    return this.chunks.getAll();
  }

  getMemoryStats(): VolumeMemoryStats {
    const main = this.chunks.getMemoryStats();

    const preview = this.previewManager?.getMemoryStats() ?? {
      allocatedVertices: 0,
      liveVertices: 0,
      vertexBytes: 0,
      counterBytes: 0,
      stagingBytes: 0,
    };

    const densityBytes = Number(this.shared.density.size);
    const densitySnapshotBytes = Number(this.densitySnapshot.size);

    const counterBytes =
      Number(this.shared.counters.size) +
      preview.counterBytes;

    const stagingBytes =
      this.staging.size +
      (this._counterStagingBuf ? Number(this._counterStagingBuf.size) : 0) +
      preview.stagingBytes +
      (this._raycastStagingBuf ? Number(this._raycastStagingBuf.size) : 0);

    const fixedBufferBytes =
      Number(this.shared.triTable.size) +
      Number(this.shared.edgeTable.size) +
      Number(this.shared.globalUni.size) +
      Number(this.previewUniBuf.size) +
      Number(this.dummyParamsBuf.size) +
      (this._raycastUniBuf ? Number(this._raycastUniBuf.size) : 0) +
      (this._raycastHitBuf ? Number(this._raycastHitBuf.size) : 0);

    const totalKnownBytes =
      densityBytes +
      densitySnapshotBytes +
      main.vertexBytes +
      preview.vertexBytes +
      counterBytes +
      stagingBytes +
      fixedBufferBytes;

    return {
      densityBytes,
      densitySnapshotBytes,
      main,
      preview,
      counterBytes,
      stagingBytes,
      fixedBufferBytes,
      totalKnownBytes,
    };
  }

  // ── Serialization ─────────────────────────────────────────────────────────
  async serialize(): Promise<Uint8Array> {
    const totalPoints = (this._internalGridSize[0]+1) * (this._internalGridSize[1]+1) * (this._internalGridSize[2]+1);
    
    let byteLength = totalPoints * 4;
    if (this._densityFormat === 'u16') byteLength = Math.ceil(totalPoints / 2) * 4;
    if (this._densityFormat === 'u8')  byteLength = Math.ceil(totalPoints / 4) * 4;
    
    return this.staging.readBufferBytes(this.shared.density, byteLength);
  }

  deserialize(data: ArrayBufferView): void {
    // ArrayBufferView allows the user to pass Uint8Array, Float32Array, etc.
    this.device.queue.writeBuffer(this.shared.density, 0, data.buffer, data.byteOffset, data.byteLength);
    this.chunks.markAllDirty();
  }

  // ── CPU readback (slow, for export) ──────────────────────────────────────
  async toArray(): Promise<{ positions: Float32Array; normals?: Float32Array }> {
    const all = this.chunks.getAll().filter(c => c.buffer && c.vertCount > 0);
    const floatsPerVert = this.floatsPerVert; 
    const totalVerts = all.reduce((s, c) => s + c.vertCount, 0);
    const positions = new Float32Array(totalVerts * 3);
    const normals: Float32Array | undefined = this._smoothNormals ? new Float32Array(totalVerts * 3) : undefined;

    let cursor = 0;
    for (const c of all) {
      const raw = await this.staging.readFloat32Array(c.buffer!, c.vertCount * floatsPerVert);
      for (let i = 0; i < c.vertCount; i++) {
        const base = i * floatsPerVert;
        positions[(cursor + i) * 3 + 0] = raw[base + 0];
        positions[(cursor + i) * 3 + 1] = raw[base + 1];
        positions[(cursor + i) * 3 + 2] = raw[base + 2];
        if (normals) {
          normals[(cursor + i) * 3 + 0] = raw[base + 3];
          normals[(cursor + i) * 3 + 1] = raw[base + 4];
          normals[(cursor + i) * 3 + 2] = raw[base + 5];
        }
      }
      cursor += c.vertCount;
    }
    const result: { positions: Float32Array; normals?: Float32Array } = { positions };
    if (normals) result.normals = normals;
    return result;
  }

  // ── raycast ────────────────────────────────────────────────────────────────
  async raycast(origin: [number, number, number], dir: [number, number, number]): Promise<[number, number, number] | null> {
    // Reuse persistent buffers — no allocation per call
    const uni = new Float32Array(20);
    uni[0] = origin[0]; uni[1] = origin[1]; uni[2] = origin[2];
    uni[4] = dir[0];    uni[5] = dir[1];    uni[6] = dir[2];
    uni[8] = this.gridOrigin[0]; uni[9] = this.gridOrigin[1]; uni[10] = this.gridOrigin[2];
    const u32 = new Uint32Array(uni.buffer);
    u32[12] = this._internalGridSize[0];
    u32[13] = this._internalGridSize[1];
    u32[14] = this._internalGridSize[2];
    uni[16] = this.voxelSize;
    uni[17] = this._isoLevel;
    uni[18] = this._densityClamp[0];
    uni[19] = this._densityClamp[1];

    this.device.queue.writeBuffer(this._raycastUniBuf, 0, uni);

    // Zero the hit result so stale data from previous call can't bleed through
    this.device.queue.writeBuffer(this._raycastHitBuf, 0, new Uint32Array(4));

    const bindGroup = this.device.createBindGroup({
      layout: this.pipelines.raycastLayout,
      entries: [
        { binding: 0, resource: { buffer: this._raycastUniBuf } },
        { binding: 1, resource: { buffer: this.shared.density } },
        { binding: 2, resource: { buffer: this._raycastHitBuf } },
      ],
    });

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipelines.raycast);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(this._raycastHitBuf, 0, this._raycastStagingBuf, 0, 16);
    this.device.queue.submit([encoder.finish()]);

    await this._raycastStagingBuf.mapAsync(GPUMapMode.READ);
    const result = new Float32Array(this._raycastStagingBuf.getMappedRange().slice(0));
    this._raycastStagingBuf.unmap();

    return result[0] > 0.5 ? [result[1], result[2], result[3]] : null;
  }

  // ── Dispose ───────────────────────────────────────────────────────────────
  dispose(): void {
    this.chunks.dispose();
    this.shared.dispose();
    this.staging.dispose();
    this.shaderManager?.dispose();
    this.previewManager?.dispose();
    this.previewUniBuf.destroy();
    this.dummyParamsBuf.destroy();
    this.densitySnapshot.destroy();
    this._counterStagingBuf?.destroy();
    this._raycastUniBuf?.destroy();
    this._raycastHitBuf?.destroy();
    this._raycastStagingBuf?.destroy();
  }
  
  // ── Private helpers ───────────────────────────────────────────────────────

  private _writeGlobalUniforms(): void {
    this.shared.writeGlobalUniforms({
      gridSize:     this._internalGridSize,
      chunkSize:    this.chunkSize,
      isoLevel:     this._isoLevel,
      voxelSize:    this.voxelSize,
      smoothNormals:this._smoothNormals,
      gridOrigin:   this.gridOrigin,
      clampMin:     this._densityClamp[0],
      clampMax:     this._densityClamp[1],
    });
  }

  private _now(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  private _buildMCSharedBindGroup(): void {
    // Also invalidate the preview bind group cache — binding 6 (param buffer)
    // may have changed if setShader() was just called for the first time.
    this._previewSharedBindGroupCache = null;
    this.mcSharedBindGroup = this.device.createBindGroup({
      layout: this.pipelines.mcSharedLayout,
      entries: [
        { binding: 0, resource: { buffer: this.shared.globalUni  } },
        { binding: 1, resource: { buffer: this.shared.density    } },
        { binding: 2, resource: { buffer: this.shared.triTable   } },
        { binding: 3, resource: { buffer: this.shared.edgeTable  } },
        { binding: 4, resource: { buffer: this.shared.counters   } },
        { binding: 5, resource: { buffer: this.previewUniBuf } },
        { binding: 6, resource: { buffer: this.shaderManager ? this.shaderManager.getParamBuffer() : this.dummyParamsBuf } },
      ],
    });
  }

  private _buildPreviewSharedBindGroup(): GPUBindGroup {
    // Built once and cached. The buffers it references never change identity —
    // only their *contents* change (via writeBuffer), which doesn't require
    // rebuilding the bind group.
    if (!this._previewSharedBindGroupCache) {
      this._previewSharedBindGroupCache = this.device.createBindGroup({
        layout: this.pipelines.mcSharedLayout,
        entries: [
          { binding: 0, resource: { buffer: this.shared.globalUni  } },
          { binding: 1, resource: { buffer: this.shared.density    } },
          { binding: 2, resource: { buffer: this.shared.triTable   } },
          { binding: 3, resource: { buffer: this.shared.edgeTable  } },
          { binding: 4, resource: { buffer: this.previewManager!.counterBuf } },
          { binding: 5, resource: { buffer: this.previewUniBuf } },
          { binding: 6, resource: { buffer: this.shaderManager ? this.shaderManager.getParamBuffer() : this.dummyParamsBuf } },
        ],
      });
    }
    return this._previewSharedBindGroupCache;
  }

  private _buildSdfSharedBindGroup(): void {
    this.sdfSharedBindGroup = this.device.createBindGroup({
      layout: this.pipelines.applySdfSharedLayout,
      entries: [
        { binding: 0, resource: { buffer: this.shared.globalUni } },
        { binding: 1, resource: { buffer: this.shared.density   } },
        { binding: 2, resource: { buffer: this.densitySnapshot  } }, // Wire the snapshot!
      ],
    });
  }

  private _makeSdfUniformBuffer(opts: SDFApplyOptions, min: Vec3, max: Vec3): GPUBuffer {
    // SDFUniforms — 64 bytes, matches WGSL struct in apply-sdf.wgsl.ts
    //   bytes  0-11: offset (vec3f)
    //   bytes 12-15: scale (f32)
    //   bytes 16-19: multiplier (f32)
    //   bytes 20-23: clampMin (f32)
    //   bytes 24-27: clampMax (f32)
    //   bytes 28-31: mode (u32)  0=add, 1=set
    //   bytes 32-47: applyMin (vec3u + pad)
    //   bytes 48-63: applyMax (vec3u + pad)
    const buf = new ArrayBuffer(64);
    const f32 = new Float32Array(buf);
    const u32 = new Uint32Array(buf);
    const off = opts.offset ?? [0, 0, 0];

    f32[0] = off[0]; f32[1] = off[1]; f32[2] = off[2];  // offset
    f32[3] = opts.scale      ?? 1.0;                      // scale
    f32[4] = opts.multiplier ?? 1.0;                      // multiplier
    f32[5] = this._densityClamp[0];                       // clampMin
    f32[6] = this._densityClamp[1];                       // clampMax
    u32[7] = opts.mode === 'set' ? 1 : 0;                 // mode (default: add)

    u32[8]  = min[0]; u32[9]  = min[1]; u32[10] = min[2]; u32[11] = 0; // applyMin
    u32[12] = max[0]; u32[13] = max[1]; u32[14] = max[2]; u32[15] = 0; // applyMax

    const gpuBuf = this.device.createBuffer({
      size:  64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'sdf-uni',
    });
    this.device.queue.writeBuffer(gpuBuf, 0, buf);
    return gpuBuf;
  }

  _initCounterStaging(): void {
    this._counterStagingBuf = this.device.createBuffer({
      size:  this.chunks.chunkCount * 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      label: 'counter-staging',
    });

    // Raycast persistent buffers — reused every raycast() call
    this._raycastUniBuf = this.device.createBuffer({
      size:  80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'raycast-uni',
    });
    this._raycastHitBuf = this.device.createBuffer({
      size:  16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      label: 'raycast-hit',
    });
    this._raycastStagingBuf = this.device.createBuffer({
      size:  16,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      label: 'raycast-staging',
    });
  }
}

// ─── Public factory ────────────────────────────────────────────────────────────
export async function newVolume(
  gridSize:  [number, number, number],
  chunkSize?: number | null,
  options:    VolumeOptions = {},
): Promise<Volume> {
  const vol = await Volume.create(gridSize, chunkSize, options);
  vol._initCounterStaging();
  return vol;
}