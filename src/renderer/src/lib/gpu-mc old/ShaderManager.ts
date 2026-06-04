/**
 * ShaderManager — compiles and manages user-defined shader brushes.
 *
 * A "shader" is a set of named brush functions plus optional raw WGSL helpers.
 * Each brush compiles to one GPUComputePipeline entry point.
 * User parameters are stored in a persistent 64-byte uniform buffer (16 × f32).
 * Partial param updates only touch the named fields — others keep their values.
 */

import { buildShaderSource } from './shaders/apply-sdf.wgsl';

export interface ShaderDefinition {
  /** Raw WGSL helper functions available to all brush bodies. */
  WGSL?: string;
  /** Brush name → function body (just the statements, no fn wrapper). */
  [brushName: string]: string | undefined;
}

const MAX_PARAMS = 16; // fixed — 16 × f32 = 64 bytes, never reallocated

export class ShaderManager {
  private device:         GPUDevice;
  private pipelines:      Map<string, GPUComputePipeline> = new Map();
  private paramIndex:     Map<string, number>             = new Map();
  private paramValues:    Float32Array                    = new Float32Array(MAX_PARAMS);
  private paramBuf:       GPUBuffer;

  private _brushBodies: Record<string, string> = {};
  private _rawWGSL:     string = '';
  private _paramNames:  string[] = [];
  private _prefix:      string = '';

  /** group(1) layout: binding 0 = sdfUni, binding 1 = userParams */
  readonly chunkLayout:   GPUBindGroupLayout;
  private pipelineLayout: GPUPipelineLayout;

  private densityFormat: 'f32' | 'u16' | 'u8';

  constructor(device: GPUDevice, sharedGroup0Layout: GPUBindGroupLayout, densityFormat: 'f32' | 'u16' | 'u8' = 'f32') {
    this.device = device;
    this.densityFormat = densityFormat;

    this.chunkLayout = device.createBindGroupLayout({
      label: 'shader-chunk',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } }, // sdfUni
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } }, // userParams
      ],
    });

    this.pipelineLayout = device.createPipelineLayout({
      label: 'shader-pipeline',
      bindGroupLayouts: [sharedGroup0Layout, this.chunkLayout],
    });

    // Allocated once — size never changes. Reused for the lifetime of the Volume.
    this.paramBuf = device.createBuffer({
      size:  MAX_PARAMS * 4, // 64 bytes
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'user-params',
    });
  }

  // ── Compilation ─────────────────────────────────────────────────────────────

  /**
   * Compile a set of named brush functions into GPU pipelines.
   * Replaces any previously compiled shader.
   */
  async compile(
    shaders:    ShaderDefinition,
    paramNames: string[],
    prefix:     string,
  ): Promise<void> {
    if (paramNames.length > MAX_PARAMS) {
      throw new Error(`gpu-mc: setShader supports at most ${MAX_PARAMS} params, got ${paramNames.length}`);
    }

    // Reset CPU param state — new declaration replaces old
    this.paramIndex.clear();
    this.paramValues = new Float32Array(MAX_PARAMS);
    paramNames.forEach((name, i) => this.paramIndex.set(name, i));
    this.device.queue.writeBuffer(this.paramBuf, 0, this.paramValues.buffer);

    // Separate raw WGSL from brush bodies
    const rawWGSL = shaders.WGSL ?? '';
    const brushBodies: Record<string, string> = {};
    for (const [k, v] of Object.entries(shaders)) {
      if (k !== 'WGSL' && v !== undefined) brushBodies[k] = v;
    }

    if (Object.keys(brushBodies).length === 0) {
      throw new Error('gpu-mc: setShader requires at least one brush (a non-WGSL key)');
    }

    // Store for preview injection
    this._brushBodies = brushBodies;
    this._rawWGSL     = rawWGSL;
    this._paramNames  = paramNames;
    this._prefix      = prefix;

    const src    = buildShaderSource(brushBodies, rawWGSL, paramNames, prefix, this.densityFormat);
    const module = this.device.createShaderModule({ code: src, label: 'user-shader' });
    // One pipeline per entry point — all share the same compiled module
    this.pipelines.clear();
    await Promise.all(
      Object.keys(brushBodies).map(async name => {
        const p = await this.device.createComputePipelineAsync({
          label:  `brush-${name}`,
          layout: this.pipelineLayout,
          compute: { module, entryPoint: `main_${name}` },
        });
        this.pipelines.set(name, p);
      })
    );
  }

  // ── Param management ─────────────────────────────────────────────────────────

  /**
   * Partially update named params and flush to GPU immediately.
   * Keys absent from `partial` are unchanged.
   */
  updateParams(partial: Record<string, number>): void {
    let changed = false;
    for (const [name, value] of Object.entries(partial)) {
      const idx = this.paramIndex.get(name);
      if (idx === undefined) {
        console.warn(`gpu-mc: unknown param "${name}" — declare it in setShader()`);
        continue;
      }
      this.paramValues[idx] = value;
      changed = true;
    }
    if (changed) {
      this.device.queue.writeBuffer(this.paramBuf, 0, this.paramValues.buffer);
    }
  }

  setParam(name: string, value: number): void {
    this.updateParams({ [name]: value });
  }

  getParam(name: string): number | undefined {
    const idx = this.paramIndex.get(name);
    return idx !== undefined ? this.paramValues[idx] : undefined;
  }

  // ── Accessors ────────────────────────────────────────────────────────────────

  getPipeline(name: string): GPUComputePipeline | undefined {
    return this.pipelines.get(name);
  }

  getBrushNames(): string[] {
    return [...this.pipelines.keys()];
  }

  getParamBuffer(): GPUBuffer {
    return this.paramBuf;
  }

  get ready(): boolean {
    return this.pipelines.size > 0;
  }

  /** Returns brush source data needed by Volume to compile MC preview pipelines. */
  getPreviewData() {
    return {
      brushBodies: this._brushBodies,
      rawWGSL:    this._rawWGSL,
      paramNames: this._paramNames,
      prefix:     this._prefix,
    };
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────────

  dispose(): void {
    this.paramBuf.destroy();
    this.pipelines.clear();
  }
}