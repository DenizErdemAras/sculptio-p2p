import { ChunkBuffer } from './BufferManager';
import type { PipelineManager } from './PipelineManager';

export class PreviewManager {
  readonly vertBuf: ChunkBuffer;
  readonly counterBuf: GPUBuffer;
  readonly counterStagingBuf: GPUBuffer;
  readonly chunkUniBuf: GPUBuffer;
  vertCount = 0;

  constructor(private device: GPUDevice, private pipelines: PipelineManager, floatsPerVert: number, allocInterval: number) {
    this.vertBuf = new ChunkBuffer(device, allocInterval, floatsPerVert);
    this.counterBuf = device.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST, label: 'preview-counters' });
    this.counterStagingBuf = device.createBuffer({ size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, label: 'preview-counter-staging' });
    this.chunkUniBuf = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'preview-chunk-uni' });
  }

  ensureCapacity(worstCaseVerts: number): void {
    this.vertBuf.allocateExact(worstCaseVerts);
  }

  writeChunkUniforms(bboxMin: [number, number, number], bboxDims: [number, number, number]): void {
    // meshType = 1 (Preview Ghost Mesh)
    const p = new Uint32Array([bboxMin[0], bboxMin[1], bboxMin[2], 0, bboxDims[0], bboxDims[1], bboxDims[2], 1]);
    this.device.queue.writeBuffer(this.chunkUniBuf, 0, p);
  }

  buildCountBindGroup(): GPUBindGroup {
    // Count pass only needs the chunk uniform — no vertex buffer.
    return this.device.createBindGroup({
      layout: this.pipelines.mcChunkCountLayout,
      entries: [
        { binding: 0, resource: { buffer: this.chunkUniBuf } },
      ],
    });
  }

  buildBindGroup(): GPUBindGroup {
    return this.device.createBindGroup({
      layout: this.pipelines.mcChunkLayout,
      entries: [
        { binding: 0, resource: { buffer: this.chunkUniBuf } },
        { binding: 1, resource: { buffer: this.vertBuf.buffer! } },
      ],
    });
  }

  dispose(): void {
    this.vertBuf.dispose();
    this.counterBuf.destroy();
    this.counterStagingBuf.destroy();
    this.chunkUniBuf.destroy();
  }
}