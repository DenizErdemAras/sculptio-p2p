/**
 * ThreeAdapter — zero-copy GPU vertex buffer integration.
 *
 * Buffer layout is always [px,py,pz, nx,ny,nz] (stride=6 floats = 24 bytes/vert).
 * Flat MC mode writes [px,py,pz, 0,0,0]. Smooth MC mode writes [px,py,pz, nx,ny,nz].
 * The buffer size NEVER changes when toggling smooth mode — no realloc, no race.
 *
 * Smooth toggle just adds/removes the 'normal' attribute on existing geometries
 * and swaps the material. No chunk destruction needed.
 *
 * Backend injection trick:
 *   backend.set(interleavedBuffer, { buffer: gpuBuf, version: 0 })
 *   → Three.js sees the attribute as already uploaded, skips its own upload.
 *   → Our compute-written GPUBuffer is bound directly in setVertexBuffer().
 *   → Only CPU↔GPU transfer: 4-byte vertex counter per dirty chunk.
 *
 * Requires: Three.js r165+ with WebGPURenderer.
 */

/**
 * ThreeAdapter — zero-copy GPU vertex buffer integration.
 */

import type { Volume } from '../Volume';

// We only need 1 float to satisfy the constructor. 
// The actual data is injected from VRAM via the backend.
const DUMMY = new Float32Array(1); 

interface ThreeNS {
  Group:                      new () => import('three').Group;
  Mesh:                       new (g: import('three').BufferGeometry, m: import('three').Material) => import('three').Mesh;
  BufferGeometry:             new () => import('three').BufferGeometry;
  InterleavedBuffer:          new (...a: any[]) => import('three').InterleavedBuffer;
  InterleavedBufferAttribute: new (...a: any[]) => import('three').InterleavedBufferAttribute;
  MeshBasicMaterial:          new (...a: any[]) => import('three').Material;
  MeshStandardMaterial:       new (...a: any[]) => import('three').Material;
  MeshNormalMaterial:         new (...a: any[]) => import('three').Material;
  Sphere:                     new (c?: import('three').Vector3, r?: number) => import('three').Sphere;
  Vector3:                    new (x?: number, y?: number, z?: number) => import('three').Vector3;
  DoubleSide:                 import('three').Side;
}

export type AdapterMaterialMode = 'standard' | 'camera-normal' | 'world-normal';

export interface ThreeAdapterOptions {
  THREE:    ThreeNS;
  renderer: any;
  material?: import('three').Material;
  previewPrimaryMaterial?: import('three').Material;
  previewSecondaryMaterial?: import('three').Material;
}

interface ChunkState {
  mesh:    import('three').Mesh;
  geo:     import('three').BufferGeometry;
  intBuf:  import('three').InterleavedBuffer;         
  posAttr: import('three').InterleavedBufferAttribute; 
  nrmAttr: import('three').InterleavedBufferAttribute | null;
  lastGpuBuf: GPUBuffer | null;
  version: number; // Required to break the WebGPU BindGroup cache
}

export class ThreeAdapter {
  private THREE:    ThreeNS;
  private volume:   Volume;
  private backend:  any;
  private group:    import('three').Group;
  private chunks:   Map<number, ChunkState> = new Map();

  private userMaterial: import('three').Material;
  private previewGroup: import('three').Group;
  private previewMesh: import('three').Mesh | null = null;
  private previewMaterial: import('three').Material;
  private previewVersion = 0;

  private chunksX: number;
  private chunksY: number;

  constructor(volume: Volume, opts: ThreeAdapterOptions) {
    this.THREE    = opts.THREE;
    this.volume   = volume;
    this.backend  = opts.renderer.backend;
    
    this.group    = new opts.THREE.Group();
    this.group.name = 'gpu-mc';
    this.userMaterial = opts.material || new opts.THREE.MeshStandardMaterial({
      color: 0x00aaff, roughness: 0.5, metalness: 0.25
    });

    this.previewGroup = new opts.THREE.Group();
    this.previewGroup.name = 'gpu-mc-preview';

    this.previewMaterial = opts.previewPrimaryMaterial || new this.THREE.MeshStandardMaterial({
      color: 0x44aaff, transparent: true, opacity: 0.35, depthWrite: false,
      side: this.THREE.DoubleSide, roughness: 0.5, metalness: 0.1,
    });

    const ig = (volume as any)._internalGridSize;
    this.chunksX = Math.ceil(ig[0] / volume.chunkSize);
    this.chunksY = Math.ceil(ig[1] / volume.chunkSize);

    volume._onCountersUpdated = () => this._syncAll();
    (volume as any)._onPreviewUpdated = () => this._syncPreview();
  }

  getMesh(): import('three').Group { return this.group; }
  getPreviewMesh(): import('three').Group { return this.previewGroup; }

  setPreviewMaterial(mat: import('three').Material): void {
    this.previewMaterial = mat;
    if (this.previewMesh) this.previewMesh.material = mat;
  }

  private _syncPreview(): void {
    const pm = (this.volume as any).previewManager;
    if (!pm) return;

    const count = pm.vertCount;
    const buf = pm.vertBuf.buffer;

    if (count > 0 && buf) {
      if (!this.previewMesh || (this.previewMesh as any).__gpuBuf !== buf) {
        if (this.previewMesh) {
          this.previewGroup.remove(this.previewMesh);
          (this.previewMesh.geometry as any).dispose();
        }

        const geo = new this.THREE.BufferGeometry();

        this._injectBuffer(geo, buf, ++this.previewVersion);

        geo.boundingSphere = new this.THREE.Sphere(
          new this.THREE.Vector3(0, 0, 0),
          Infinity,
        );

        this.previewMesh = new this.THREE.Mesh(geo, this.previewMaterial);
        this.previewMesh.frustumCulled = false;
        (this.previewMesh as any).__gpuBuf = buf;
        this.previewGroup.add(this.previewMesh);
      }

      (this.previewMesh.geometry as any).setDrawRange(0, count);
      this.previewMesh.visible = true;
  } else if (this.previewMesh) {
      this.previewMesh.visible = false;
  }
}

private _injectBuffer(
  geo: import('three').BufferGeometry,
  gpuBuf: GPUBuffer,
  version = 0,
): void {
  const floatsPerVert = this.volume.floatsPerVert;
  const intBuf = new this.THREE.InterleavedBuffer(DUMMY, floatsPerVert);

  // Exact capacity. The old hardcoded 250000 could crop or overstate preview geometry.
  (intBuf as any).count = Number(gpuBuf.size) / (floatsPerVert * 4);

  this.backend.set(intBuf, { buffer: gpuBuf, version });

  const posAttr = new this.THREE.InterleavedBufferAttribute(intBuf, 3, 0);
  geo.setAttribute('position', posAttr as unknown as import('three').BufferAttribute);

  if (floatsPerVert === 6) {
    const normAttr = new this.THREE.InterleavedBufferAttribute(intBuf, 3, 3);
    geo.setAttribute('normal', normAttr as unknown as import('three').BufferAttribute);
  }
  }

  /**
   * Update visual settings without disposing materials mid-render (fixes usedTimes crash).
   */
  setMaterial(newMaterial: import('three').Material): void {
    this.userMaterial = newMaterial;
    for (const [, state] of this.chunks) {
      state.mesh.material = this.userMaterial;
    }
  }

  private _syncAll(): void {
    for (const chunk of this.volume.getRawBuffers()) {
      this._upsert(chunk.info.index, chunk.buffer, chunk.vertCount);
    }
  }

  private _upsert(idx: number, gpuBuf: GPUBuffer | null, vertCount: number): void {
    let state = this.chunks.get(idx);

    // 1. CHUNK IS EMPTY: Hide it to maintain scene stability
    if (vertCount === 0 || !gpuBuf) {
      if (state) {
        state.mesh.visible = false;
        state.geo.setDrawRange(0, 0);
      }
      return;
    }

    // 2. NEW CHUNK: Initialize
    if (!state) {
      state = this._create(idx, gpuBuf);
      this.chunks.set(idx, state);
      this.group.add(state.mesh);
    }

    state.mesh.visible = true;

    // 3. BUFFER REALLOCATED: Hot-swap the backend buffer without dropping the mesh
    if (state.lastGpuBuf !== gpuBuf) {
      const newVersion = state.version + 1;
      
      // Tell the Three.js WebGPU backend to update its BindGroup with the new buffer
      this.backend.set(state.intBuf, { buffer: gpuBuf, version: newVersion });
      
      state.lastGpuBuf = gpuBuf;
      state.version = newVersion;
    }

    // Tell Three.js the exact capacity of the buffer so it never crops the mesh
    (state.intBuf as any).count = gpuBuf.size / (this.volume.floatsPerVert * 4);
    state.geo.setDrawRange(0, vertCount);
  }

  private _create(idx: number, gpuBuf: GPUBuffer, existingMat?: import('three').Material, version: number = 0): ChunkState {
    const geo = new this.THREE.BufferGeometry();
    const floatsPerVert = this.volume.floatsPerVert;
    
    const intBuf = new this.THREE.InterleavedBuffer(DUMMY, floatsPerVert);
    // Initialize count to the exact capacity of the first GPU buffer
    (intBuf as any).count = gpuBuf.size / (floatsPerVert * 4);

    const posAttr = new this.THREE.InterleavedBufferAttribute(intBuf, 3, 0);
    let nrmAttr: import('three').InterleavedBufferAttribute | null = null;
    if (floatsPerVert === 6) {
      nrmAttr = new this.THREE.InterleavedBufferAttribute(intBuf, 3, 3);
    }

    // Inject with an incrementing version to ensure the backend builds a new BindGroup
    this.backend.set(intBuf, { buffer: gpuBuf, version });

    geo.setAttribute('position', posAttr as unknown as import('three').BufferAttribute);
    if (nrmAttr) {
      geo.setAttribute('normal', nrmAttr as unknown as import('three').BufferAttribute);
    }

    // Mathematically calculate the exact 3D center of this specific chunk
    const x = idx % this.chunksX;
    const y = Math.floor(idx / this.chunksX) % this.chunksY;
    const z = Math.floor(idx / (this.chunksX * this.chunksY));
    
    const cs = this.volume.chunkSize * this.volume.voxelSize;
    const origin = this.volume.gridOrigin;
    const cx = origin[0] + (x * cs) + (cs / 2);
    const cy = origin[1] + (y * cs) + (cs / 2);
    const cz = origin[2] + (z * cs) + (cs / 2);

    // Bounding sphere radius of a cube is (side * sqrt(3)) / 2 = side * 0.866
    geo.boundingSphere = new this.THREE.Sphere(new this.THREE.Vector3(cx, cy, cz), cs * 0.866);
    geo.setDrawRange(0, 0);

    const mesh = new this.THREE.Mesh(geo, existingMat || this.userMaterial);
    mesh.name = `gpu-mc-chunk-${idx}`;
    mesh.frustumCulled = true; // Engine is now allowed to cull chunks behind the camera!

    return { mesh, geo, intBuf, posAttr, nrmAttr, lastGpuBuf: gpuBuf, version };
  }
}