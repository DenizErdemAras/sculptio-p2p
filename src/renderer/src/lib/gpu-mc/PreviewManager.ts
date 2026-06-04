import { ChunkBuffer, BYTES_PER_FLOAT } from './BufferManager';
import type { PipelineManager } from './PipelineManager';

export class PreviewManager {
    readonly vertBuf: ChunkBuffer;
    readonly counterBuf: GPUBuffer;
    readonly counterStagingBuf: GPUBuffer;
    readonly chunkUniBuf: GPUBuffer;

    vertCount = 0;

    private generateBindGroup: GPUBindGroup | null = null;
    private countBindGroup: GPUBindGroup;

    constructor(
        private device: GPUDevice,
        private pipelines: PipelineManager,
        private floatsPerVert: number,
        allocInterval: number,
    ) {
        this.vertBuf = new ChunkBuffer(device, allocInterval, floatsPerVert);

        this.counterBuf = device.createBuffer({
            size: 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
            label: 'preview-counters',
        });

        this.counterStagingBuf = device.createBuffer({
            size: 4,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
            label: 'preview-counter-staging',
        });

        this.chunkUniBuf = device.createBuffer({
            size: 32,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: 'preview-chunk-uni',
        });

        this.countBindGroup = this.device.createBindGroup({
            label: 'preview-count-bind-group',
            layout: this.pipelines.mcChunkCountLayout,
            entries: [
                { binding: 0, resource: { buffer: this.chunkUniBuf } },
            ],
        });

        this.vertBuf.onReallocate = () => {
            this.generateBindGroup = null;
        };
    }

    get allocatedVerts(): number {
        return this.vertBuf.allocatedVerts;
    }

    get allocatedBytes(): number {
        return this.vertBuf.allocatedVerts * this.floatsPerVert * BYTES_PER_FLOAT;
    }

    ensureCapacity(neededVerts: number): GPUBuffer | null {
        return this.vertBuf.allocateExact(neededVerts);
    }

    writeChunkUniforms(
        bboxMin: [number, number, number],
        bboxDims: [number, number, number],
        meshType = 1,
    ): void {
        // meshType = 1 means Preview / Ghost mesh.
        const data = new Uint32Array([
            bboxMin[0], bboxMin[1], bboxMin[2], 0,
            bboxDims[0], bboxDims[1], bboxDims[2], meshType,
        ]);

        this.device.queue.writeBuffer(this.chunkUniBuf, 0, data);
    }

    buildCountBindGroup(): GPUBindGroup {
        return this.countBindGroup;
    }

    buildGenerateBindGroup(): GPUBindGroup | null {
        if (!this.vertBuf.buffer) {
            this.generateBindGroup = null;
            return null;
        }

        if (!this.generateBindGroup) {
            this.generateBindGroup = this.device.createBindGroup({
                label: 'preview-generate-bind-group',
                layout: this.pipelines.mcChunkLayout,
                entries: [
                    { binding: 0, resource: { buffer: this.chunkUniBuf } },
                    { binding: 1, resource: { buffer: this.vertBuf.buffer } },
                ],
            });
        }

        return this.generateBindGroup;
    }

    getMemoryStats() {
        return {
            allocatedVertices: this.vertBuf.allocatedVerts,
            liveVertices: this.vertCount,
            vertexBytes: this.allocatedBytes,
            counterBytes: Number(this.counterBuf.size),
            stagingBytes: Number(this.counterStagingBuf.size),
        };
    }

    dispose(): void {
        this.vertBuf.dispose();
        this.counterBuf.destroy();
        this.counterStagingBuf.destroy();
        this.chunkUniBuf.destroy();
    }
}