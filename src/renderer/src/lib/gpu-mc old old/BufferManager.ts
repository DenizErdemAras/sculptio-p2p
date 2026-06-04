export const FLOATS_PER_VERT = 6; // always [px,py,pz, nx,ny,nz]
export const BYTES_PER_FLOAT = 4;

export class VRAMTrash {
  private static bins: { buf: GPUBuffer; frame: number }[] = [];
  private static frameCount = 0;

  /** Increments the frame counter and cleans up old buffers. Call this in Volume.update() */
  static tick() {
    this.frameCount++;
    this.empty();
  }

  /** * Schedules a buffer for destruction. 
   * 'device' is optional to maintain compatibility with your existing calls.
   */
  static trash(buf: GPUBuffer, _device?: GPUDevice) {
    this.bins.push({ buf, frame: this.frameCount });
  }

  private static empty() {
    // Keep buffers for 300 frames (~5s at 60fps) to ensure Three.js/GPU are done.
    for (let i = this.bins.length - 1; i >= 0; i--) {
      if (this.frameCount - this.bins[i].frame > 300) {
        this.bins[i].buf.destroy();
        this.bins.splice(i, 1);
      }
    }
  }
}

// ─── ChunkBuffer ──────────────────────────────────────────────────────────────
// Manages one GPU vertex buffer for one chunk.
// Grows by interval, shrinks after sustained underuse.

export class ChunkBuffer {
  buffer:          GPUBuffer | null = null;
  allocatedVerts:  number = 0;

  private device:       GPUDevice;
  private interval:     number;
  private floatsPerVert: number;
  public  onReallocate?: () => void;

  constructor(
    device: GPUDevice,
    allocIntervalBytes: number,
    floatsPerVert: number,
  ) {
    this.device        = device;
    this.floatsPerVert = floatsPerVert;
    this.interval      = Math.max(1, Math.ceil(allocIntervalBytes / (floatsPerVert * BYTES_PER_FLOAT)));
  }

  /** Hysteresis allocation. Call between Count and Generate passes. */
  allocateExact(neededVerts: number): GPUBuffer | null {
    if (neededVerts === 0) {
      if (this.allocatedVerts > 0) this.reallocate(0);
      return null;
    }

    let targetAlloc = this.allocatedVerts;

    // ── Grow: Reallocate to exact interval multiple ──
    if (neededVerts > this.allocatedVerts) {
      targetAlloc = Math.ceil(neededVerts / this.interval) * this.interval;
    } 
    // ── Shrink: Only if needed is BELOW the threshold (allocated - 2*interval) ──
    else if (neededVerts <= this.allocatedVerts - 2 * this.interval) {
      targetAlloc = Math.ceil(neededVerts / this.interval) * this.interval + this.interval;
    }

    if (targetAlloc !== this.allocatedVerts) {
      this.reallocate(targetAlloc);
    }

    return this.buffer;
  }

  private reallocate(verts: number): void {
    const oldBuffer = this.buffer;
    
    if (verts === 0) {
      this.buffer = null;
      this.allocatedVerts = 0;
      if (oldBuffer) VRAMTrash.trash(oldBuffer, this.device);
      this.onReallocate?.();
      return;
    }

    this.buffer = this.device.createBuffer({
      size:  verts * this.floatsPerVert * BYTES_PER_FLOAT, 
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      label: `chunk-verts-${verts}`,
    });
    this.allocatedVerts = verts;

    // No copy logic! Two-pass writes fresh directly into the new buffer.
    if (oldBuffer) VRAMTrash.trash(oldBuffer, this.device);
    this.onReallocate?.();
  }

  dispose(): void {
    this.buffer?.destroy();
    this.buffer = null;
  }
}

// ─── SharedBuffers ────────────────────────────────────────────────────────────
// All GPU buffers that are shared across chunks and live for the Volume lifetime.

export class SharedBuffers {
  readonly density:   GPUBuffer;
  readonly counters:  GPUBuffer;
  readonly triTable:  GPUBuffer;
  readonly edgeTable: GPUBuffer;
  readonly globalUni: GPUBuffer;

  private device: GPUDevice;

  constructor(
    device: GPUDevice,
    densityPointCount: number, // (X+1)*(Y+1)*(Z+1)
    chunkCount: number,
    triTableData:  Int32Array,
    edgeTableData: Uint32Array,
    densityFormat: 'f32' | 'u16' | 'u8' = 'f32'
  ) {
    this.device = device;

    let densityBytes = densityPointCount * 4;
    if (densityFormat === 'u16') densityBytes = Math.ceil(densityPointCount / 2) * 4;
    if (densityFormat === 'u8')  densityBytes = Math.ceil(densityPointCount / 4) * 4;

    this.density = device.createBuffer({
      size:  densityBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      label: 'density',
    });

    // One atomic<u32> per chunk — read back after meshing for drawRange
    this.counters = device.createBuffer({
      size:  chunkCount * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      label: 'counters',
    });

    this.triTable = device.createBuffer({
      size:  triTableData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: 'triTable',
    });
    device.queue.writeBuffer(this.triTable, 0, triTableData.buffer.slice(triTableData.byteOffset, triTableData.byteOffset + triTableData.byteLength));

    this.edgeTable = device.createBuffer({
      size:  edgeTableData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: 'edgeTable',
    });
    device.queue.writeBuffer(this.edgeTable, 0, edgeTableData.buffer.slice(edgeTableData.byteOffset, edgeTableData.byteOffset + edgeTableData.byteLength));

    // 48 bytes: gridSize(3u+pad), isoLevel, voxelSize, smoothNorms, pad, gridOrigin(3f+pad)
    this.globalUni = device.createBuffer({
      size:  48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'globalUni',
    });
  }

  writeGlobalUniforms(opts: {
    gridSize:     [number,number,number];
    chunkSize:    number;
    isoLevel:     number;
    voxelSize:    number;
    smoothNormals:boolean;
    gridOrigin:   [number,number,number];
    clampMin:     number;
    clampMax:     number;
  }): void {
    const buf = new ArrayBuffer(48);
    const u32 = new Uint32Array(buf);
    const f32 = new Float32Array(buf);
    u32[0] = opts.gridSize[0]; u32[1] = opts.gridSize[1]; u32[2] = opts.gridSize[2];
    u32[3] = opts.chunkSize;
    f32[4] = opts.isoLevel;
    f32[5] = opts.voxelSize;
    u32[6] = opts.smoothNormals ? 1 : 0;
    f32[7] = opts.clampMin;
    f32[8] = opts.gridOrigin[0]; f32[9] = opts.gridOrigin[1]; f32[10] = opts.gridOrigin[2];
    f32[11] = opts.clampMax;
    this.device.queue.writeBuffer(this.globalUni, 0, buf);
  }

  /** Zero a specific chunk's counter before dispatch. */
  clearCounter(chunkIndex: number): void {
    this.device.queue.writeBuffer(this.counters, chunkIndex * 4, new Uint32Array([0]));
  }

  dispose(): void {
    this.density.destroy();
    this.counters.destroy();
    this.triTable.destroy();
    this.edgeTable.destroy();
    this.globalUni.destroy();
  }
}

// ─── StagingBuffer ────────────────────────────────────────────────────────────
// Reusable MAP_READ buffer for reading counters back to CPU.

export class StagingBuffer {
  private device:  GPUDevice;
  private buffer:  GPUBuffer;
  readonly size:   number;

  constructor(device: GPUDevice, size: number) {
    this.device = device;
    this.size   = size;
    this.buffer = device.createBuffer({
      size,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      label: 'staging',
    });
  }

  async readUint32Array(src: GPUBuffer, srcOffset: number, count: number): Promise<Uint32Array> {
    const byteCount = count * 4;
    const encoder   = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(src, srcOffset, this.buffer, 0, byteCount);
    this.device.queue.submit([encoder.finish()]);
    await this.buffer.mapAsync(GPUMapMode.READ, 0, byteCount);
    const copy = new Uint32Array(this.buffer.getMappedRange(0, byteCount).slice(0));
    this.buffer.unmap();
    return copy;
  }

  async readBufferBytes(src: GPUBuffer, byteLength: number): Promise<Uint8Array> {
    const staging = this.device.createBuffer({
      size:  byteLength,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      label: 'staging-tmp',
    });
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(src, 0, staging, 0, byteLength);
    this.device.queue.submit([encoder.finish()]);
    
    await staging.mapAsync(GPUMapMode.READ, 0, byteLength);
    const copy = new Uint8Array(staging.getMappedRange(0, byteLength).slice(0));
    staging.unmap();
    staging.destroy();
    
    return copy;
  }

  async readFloat32Array(src: GPUBuffer, count: number): Promise<Float32Array> {
    const byteCount = count * 4;
    // Allocate a per-call staging buffer sized exactly to what we need.
    // The shared staging buffer may be too small for large chunk readbacks.
    const staging = this.device.createBuffer({
      size:  byteCount,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      label: 'staging-tmp',
    });
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(src, 0, staging, 0, byteCount);
    this.device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ, 0, byteCount);
    const copy = new Float32Array(staging.getMappedRange(0, byteCount).slice(0));
    staging.unmap();
    staging.destroy();
    return copy;
  }

  dispose(): void { this.buffer.destroy(); }
}