import type { Vec3, ChunkInfo } from './types';
import { ChunkBuffer, BYTES_PER_FLOAT } from './BufferManager';
import type { PipelineManager } from './PipelineManager';

// Per-chunk GPU resources that don't live in SharedBuffers
export interface ChunkResources {
  info:           ChunkInfo;
  buffer:         ChunkBuffer;
  uniformBuf:     GPUBuffer;   // ChunkUniforms (32 bytes)
  bindGroup:      GPUBindGroup | null; // Generate pass group
  countBindGroup: GPUBindGroup;        // Count pass group (no verts)
}

export class ChunkManager {
  private device:        GPUDevice;
  private chunks:        ChunkResources[] = [];
  private pipelines:     PipelineManager;
  private allocInterval: number;

  readonly gridSize:  [number, number, number];
  readonly chunkSize: number;
  readonly chunksX:   number;
  readonly chunksY:   number;
  readonly chunksZ:   number;
  readonly chunkCount:number;

  constructor(
    device:        GPUDevice,
    gridSize:      [number, number, number],
    chunkSize:     number,
    pipelines:     PipelineManager,
    allocInterval: number,
    public floatsPerVert: number,
  ) {
    this.device        = device;
    this.gridSize      = gridSize;
    this.chunkSize     = chunkSize;
    this.pipelines     = pipelines;
    this.allocInterval = allocInterval;

    this.chunksX    = Math.ceil(gridSize[0] / chunkSize);
    this.chunksY    = Math.ceil(gridSize[1] / chunkSize);
    this.chunksZ    = Math.ceil(gridSize[2] / chunkSize);
    this.chunkCount = this.chunksX * this.chunksY * this.chunksZ;

    this._initChunks();
  }

  private _initChunks(): void {
    let idx = 0;
    for (let cz = 0; cz < this.chunksZ; cz++) {
      for (let cy = 0; cy < this.chunksY; cy++) {
        for (let cx = 0; cx < this.chunksX; cx++) {
          const info: ChunkInfo = {
            index: idx,
            cx, cy, cz,
            cellOffset: [cx * this.chunkSize, cy * this.chunkSize, cz * this.chunkSize],
            dirty: true,
            allocatedVerts: 0,
            lastVertCount: 0,
          } as ChunkInfo; // cast to ignore underusedFrames if it exists in types

          const chunkBuf = new ChunkBuffer(
            this.device,
            this.allocInterval,
            this.floatsPerVert,
          );

          // 32-byte ChunkUniforms: chunkOffset(3u), chunkIndex(u32), chunkCells(3u), isSecondary(u32)
          const uniformBuf = this.device.createBuffer({
            size:  32,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: `chunk-uni-${idx}`,
          });
          this._writeChunkUniforms(uniformBuf, info, false);

          const countBindGroup = this.device.createBindGroup({
            label: `mc-count-${idx}`,
            layout: this.pipelines.mcChunkCountLayout,
            entries: [{ binding: 0, resource: { buffer: uniformBuf } }],
          });

          const res: ChunkResources = { info, buffer: chunkBuf, uniformBuf, bindGroup: null, countBindGroup };
          chunkBuf.onReallocate = () => this._rebuildBindGroup(res);

          this.chunks.push(res);
          idx++;
        }
      }
    }
  }

  private _writeChunkUniforms(buf: GPUBuffer, info: ChunkInfo, isSecondary: boolean): void {
    const data = new Uint32Array(8);
    data[0] = info.cellOffset[0];
    data[1] = info.cellOffset[1];
    data[2] = info.cellOffset[2];
    data[3] = info.index;
    // Actual cells this chunk covers (may be smaller at grid boundary)
    data[4] = Math.min(this.chunkSize, this.gridSize[0] - info.cellOffset[0]);
    data[5] = Math.min(this.chunkSize, this.gridSize[1] - info.cellOffset[1]);
    data[6] = Math.min(this.chunkSize, this.gridSize[2] - info.cellOffset[2]);
    data[7] = isSecondary ? 1 : 0;
    this.device.queue.writeBuffer(buf, 0, data);
  }

  private _rebuildBindGroup(res: ChunkResources): void {
    if (!res.buffer.buffer) {
      res.bindGroup = null;
      return;
    }
    res.bindGroup = this.device.createBindGroup({
      label:  `mc-chunk-${res.info.index}`,
      layout: this.pipelines.mcChunkLayout,
      entries: [
        { binding: 0, resource: { buffer: res.uniformBuf } },
        { binding: 1, resource: { buffer: res.buffer.buffer } },
      ],
    });
  }

  // ─── Dirty marking ──────────────────────────────────────────────────────────

  markAllDirty(): void {
    for (const r of this.chunks) r.info.dirty = true;
  }

  /**
   * Mark chunks whose cell AABB overlaps the given density-point AABB.
   * min/max are in density-point coordinates (0..gridSize[i]).
   */
  markDirtyInAABB(min: Vec3, max: Vec3): void {
    const cs = this.chunkSize;
    const cxMin = Math.max(0, Math.floor(min[0] / cs));
    const cyMin = Math.max(0, Math.floor(min[1] / cs));
    const czMin = Math.max(0, Math.floor(min[2] / cs));
    const cxMax = Math.min(this.chunksX - 1, Math.floor(max[0] / cs));
    const cyMax = Math.min(this.chunksY - 1, Math.floor(max[1] / cs));
    const czMax = Math.min(this.chunksZ - 1, Math.floor(max[2] / cs));

    for (let cz = czMin; cz <= czMax; cz++)
      for (let cy = cyMin; cy <= cyMax; cy++)
        for (let cx = cxMin; cx <= cxMax; cx++)
          this.chunks[cx + cy * this.chunksX + cz * this.chunksX * this.chunksY].info.dirty = true;
  }

  // ─── Two-Pass Meshing Dispatch ───────────────────────────────────────────────

  /** Pass 1: Dispatch Count compute shader on dirty chunks */
  dispatchCount(
    encoder: GPUCommandEncoder,
    sharedBindGroup: GPUBindGroup,
  ): ChunkResources[] {
    const dispatched: ChunkResources[] = [];

    for (const res of this.chunks) {
      if (!res.info.dirty) continue;

      const nx = Math.min(this.chunkSize, this.gridSize[0] - res.info.cellOffset[0]);
      const ny = Math.min(this.chunkSize, this.gridSize[1] - res.info.cellOffset[1]);
      const nz = Math.min(this.chunkSize, this.gridSize[2] - res.info.cellOffset[2]);

      const pass = encoder.beginComputePass();
      pass.setPipeline(this.pipelines.mcCount);
      pass.setBindGroup(0, sharedBindGroup);
      pass.setBindGroup(1, res.countBindGroup);
      pass.dispatchWorkgroups(
        Math.ceil(nx / 8),
        Math.ceil(ny / 8),
        Math.ceil(nz / 4),
      );
      pass.end();

      dispatched.push(res);
    }

    return dispatched;
  }

  /** Pass 2: Allocate perfectly and Dispatch Generate shader */
  allocateAndDispatchGenerate(
    encoder: GPUCommandEncoder,
    sharedBindGroup: GPUBindGroup,
    dispatched: ChunkResources[],
    counts: Uint32Array
  ): void {
    for (let i = 0; i < dispatched.length; i++) {
      const res = dispatched[i];
      const neededVerts = counts[res.info.index];
      res.info.lastVertCount = neededVerts;
      res.info.dirty = false;

      // 1. Exact Allocation (Hysteresis)
      res.buffer.allocateExact(neededVerts);
      res.info.allocatedVerts = res.buffer.allocatedVerts;

      // 2. Generate Dispatch
      if (neededVerts > 0 && res.buffer.buffer) {
        if (!res.bindGroup) this._rebuildBindGroup(res);

        const nx = Math.min(this.chunkSize, this.gridSize[0] - res.info.cellOffset[0]);
        const ny = Math.min(this.chunkSize, this.gridSize[1] - res.info.cellOffset[1]);
        const nz = Math.min(this.chunkSize, this.gridSize[2] - res.info.cellOffset[2]);

        const pass = encoder.beginComputePass();
        pass.setPipeline(this.pipelines.mcGenerate);
        pass.setBindGroup(0, sharedBindGroup);
        pass.setBindGroup(1, res.bindGroup!);
        pass.dispatchWorkgroups(
          Math.ceil(nx / 8),
          Math.ceil(ny / 8),
          Math.ceil(nz / 4),
        );
        pass.end();
      }
    }
  }

  /** Returns all chunk vertex buffers and their current vert counts. */
  getAll(): Array<{ buffer: GPUBuffer | null; vertCount: number; info: ChunkInfo }> {
    return this.chunks.map(r => ({
      buffer:    r.buffer.buffer,
      vertCount: r.info.lastVertCount,
      info:      r.info,
    }));
  }

  /** Rebuild all bind groups (e.g. after smoothNormals toggle changes pipeline layout). */
  rebuildAllBindGroups(): void {
    for (const res of this.chunks) this._rebuildBindGroup(res);
  }

  getMemoryStats() {
    let allocatedVertices = 0;
    let liveVertices = 0;
    let allocatedChunks = 0;
    let nonEmptyChunks = 0;
    let dirtyChunks = 0;

    for (const res of this.chunks) {
      allocatedVertices += res.buffer.allocatedVerts;
      liveVertices += res.info.lastVertCount;

      if (res.buffer.allocatedVerts > 0) allocatedChunks++;
      if (res.info.lastVertCount > 0) nonEmptyChunks++;
        if (res.info.dirty) dirtyChunks++;
    }

    return {
      chunkCount: this.chunkCount,
      dirtyChunks,
      allocatedChunks,
      nonEmptyChunks,
      allocatedVertices,
      liveVertices,
      vertexBytes: allocatedVertices * this.floatsPerVert * BYTES_PER_FLOAT,
    };
  }

  dispose(): void {
    for (const r of this.chunks) {
      r.buffer.dispose();
      r.uniformBuf.destroy();
    }
    this.chunks = [];
  }
}