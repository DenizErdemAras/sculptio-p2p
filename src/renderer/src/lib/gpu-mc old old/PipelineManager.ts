import { buildMarchingCubesShader } from './shaders/marching-cubes.wgsl';
import { buildEditMatrixShader } from './shaders/edit-matrix.wgsl';
import { buildRaycastShader } from './shaders/raycast.wgsl';

function hashString(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h.toString(16);
}

const MAX_CACHED = 10;

export class PipelineManager {
  private device: GPUDevice;
  private cache:  Map<string, GPUComputePipeline> = new Map();
  private cacheOrder: string[] = [];

  private _mcCount:    GPUComputePipeline | null = null;
  private _mcGenerate: GPUComputePipeline | null = null;
  private _editMatrix: GPUComputePipeline | null = null;
  private _raycast:    GPUComputePipeline | null = null;

  readonly mcSharedLayout:       GPUBindGroupLayout;
  readonly mcChunkLayout:        GPUBindGroupLayout;
  readonly mcChunkCountLayout:   GPUBindGroupLayout;
  readonly editMatrixLayout:     GPUBindGroupLayout;
  readonly applySdfSharedLayout: GPUBindGroupLayout;
  readonly raycastLayout:        GPUBindGroupLayout;

  readonly mcPipelineLayout:      GPUPipelineLayout;
  readonly mcCountPipelineLayout: GPUPipelineLayout;
  readonly editMatrixPipelineLayout: GPUPipelineLayout;

  private vertexFormat: 'pos3' | 'pos3-norm3';
  private capEdges: boolean = false;

  constructor(device: GPUDevice, vertexFormat: 'pos3' | 'pos3-norm3') {
    this.device = device;
    this.vertexFormat = vertexFormat;

    this.mcSharedLayout = device.createBindGroupLayout({
      label: 'mc-shared',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });

    this.mcChunkLayout = device.createBindGroupLayout({
      label: 'mc-chunk',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });

    this.mcChunkCountLayout = device.createBindGroupLayout({
      label: 'mc-chunk-count',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });

    this.editMatrixLayout = device.createBindGroupLayout({
      label: 'edit-matrix',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      ],
    });

    this.applySdfSharedLayout = device.createBindGroupLayout({
      label: 'apply-sdf-shared',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } }, // globalUni
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }, // density
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } }, // densitySnapshot
      ],
    });

    this.raycastLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });

    this.mcPipelineLayout = device.createPipelineLayout({
      label: 'mc',
      bindGroupLayouts: [this.mcSharedLayout, this.mcChunkLayout],
    });

    this.mcCountPipelineLayout = device.createPipelineLayout({
      label: 'mc-count',
      bindGroupLayouts: [this.mcSharedLayout, this.mcChunkCountLayout],
    });

    this.editMatrixPipelineLayout = device.createPipelineLayout({
      label: 'edit-matrix',
      bindGroupLayouts: [this.editMatrixLayout],
    });
  }

  get raycast(): GPUComputePipeline { return this._raycast!; }

  async init(smoothNormals: boolean, capEdges: boolean = false, densityFormat: 'f32' | 'u16' | 'u8' = 'f32', invertDensity: boolean = false) {
    this.capEdges = capEdges;
    this._mcCount    = await this._compileMC(smoothNormals, undefined, 'count', densityFormat, invertDensity);
    this._mcGenerate = await this._compileMC(smoothNormals, undefined, 'generate', densityFormat, invertDensity);
    
    this._editMatrix = await this.device.createComputePipelineAsync({
      layout: this.editMatrixPipelineLayout,
      compute: { module: this.device.createShaderModule({ code: buildEditMatrixShader(densityFormat) }), entryPoint: 'main' },
    });

    const raycastCode = buildRaycastShader(this.capEdges, densityFormat, invertDensity);
    this._raycast = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.raycastLayout] }),
      compute: { module: this.device.createShaderModule({ code: raycastCode }), entryPoint: 'main' },
    });
  }

  private async _compileMC(smoothNormals: boolean, previewSDF: string | undefined, passType: 'count' | 'generate', densityFormat: 'f32' | 'u16' | 'u8', invertDensity: boolean): Promise<GPUComputePipeline> {
    const src = buildMarchingCubesShader(smoothNormals, previewSDF, this.vertexFormat, this.capEdges, passType, densityFormat, invertDensity);
    const key = hashString(src);
    if (this.cache.has(key)) return this.cache.get(key)!;

    const layout = passType === 'count' ? this.mcCountPipelineLayout : this.mcPipelineLayout;
    const pipeline = await this.device.createComputePipelineAsync({
      label: 'marching-cubes', layout,
      compute: { module: this.device.createShaderModule({ code: src }), entryPoint: 'main' },
    });

    this._cacheSet(key, pipeline);
    return pipeline;
  }

  async recompileMC(smoothNormals: boolean, densityFormat: 'f32' | 'u16' | 'u8' = 'f32', invertDensity: boolean = false): Promise<void> {
    this._mcCount    = await this._compileMC(smoothNormals, undefined, 'count', densityFormat, invertDensity);
    this._mcGenerate = await this._compileMC(smoothNormals, undefined, 'generate', densityFormat, invertDensity);
  }

  private _activePreviewBrush: string | null = null;
  setActivePreviewBrush(brush: string | null) { this._activePreviewBrush = brush; }

  get mcCount(): GPUComputePipeline {
    if (this._activePreviewBrush && this._previewPipelines.has(this._activePreviewBrush)) return this._previewPipelines.get(this._activePreviewBrush)!.count;
    return this._mcCount!;
  }
  get mcGenerate(): GPUComputePipeline {
    if (this._activePreviewBrush && this._previewPipelines.has(this._activePreviewBrush)) return this._previewPipelines.get(this._activePreviewBrush)!.generate;
    return this._mcGenerate!;
  }
  get editMatrix(): GPUComputePipeline { return this._editMatrix!; }

  async compileMCPreview(brushName: string, injection: string, smoothNormals: boolean, densityFormat: 'f32' | 'u16' | 'u8' = 'f32', invertDensity: boolean = false): Promise<void> {
    const countSrc = buildMarchingCubesShader(smoothNormals, injection, this.vertexFormat, this.capEdges, 'count', densityFormat, invertDensity);
    const genSrc   = buildMarchingCubesShader(smoothNormals, injection, this.vertexFormat, this.capEdges, 'generate', densityFormat, invertDensity);

    const count = await this.device.createComputePipelineAsync({
      label: `mc-preview-count-${brushName}`, layout: this.mcCountPipelineLayout,
      compute: { module: this.device.createShaderModule({ code: countSrc }), entryPoint: 'main' },
    });
    const generate = await this.device.createComputePipelineAsync({
      label: `mc-preview-gen-${brushName}`, layout: this.mcPipelineLayout,
      compute: { module: this.device.createShaderModule({ code: genSrc }), entryPoint: 'main' },
    });
    this._previewPipelines.set(brushName, { count, generate });
  }

  private _previewPipelines = new Map<string, { count: GPUComputePipeline, generate: GPUComputePipeline }>();
  clearPreviewPipelines(): void { this._previewPipelines.clear(); }

  private _cacheSet(key: string, p: GPUComputePipeline): void {
    if (this.cacheOrder.length >= MAX_CACHED) this.cache.delete(this.cacheOrder.shift()!);
    this.cache.set(key, p);
    this.cacheOrder.push(key);
  }
}