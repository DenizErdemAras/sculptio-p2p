// src/renderer/src/components/ModelCanvas.utils.ts
import { useMemo, useLayoutEffect, useRef } from 'react';
import * as THREE from 'three/webgpu';
import { uv, fract, abs, min, fwidth, color, float, clamp } from 'three/tsl';

/**
 * Calculates the local 3D bounding box for brush operations.
 * This prevents the GPU from evaluating the entire grid for every stroke.
 */
export const getBrushBounds = (hitPoint: [number, number, number], baseRadius: number, model: any) => {
  const vx = [
    (hitPoint[0] - model.gridOrigin[0]) / model.voxelSize,
    (hitPoint[1] - model.gridOrigin[1]) / model.voxelSize,
    (hitPoint[2] - model.gridOrigin[2]) / model.voxelSize,
  ];

  const pad = baseRadius + 2; 

  return {
    min: [
      Math.max(0, Math.floor(vx[0] - pad)),
      Math.max(0, Math.floor(vx[1] - pad)),
      Math.max(0, Math.floor(vx[2] - pad)),
    ] as [number, number, number],
    max: [
      Math.min(model.gridSize[0], Math.ceil(vx[0] + pad)),
      Math.min(model.gridSize[1], Math.ceil(vx[1] + pad)),
      Math.min(model.gridSize[2], Math.ceil(vx[2] + pad)),
    ] as [number, number, number]
  };
};

interface VolumeGridsProps {
  size: number;
  colorMain: string;
  colorSecondary: string;
}

export function VolumeGrids({ size, colorMain, colorSecondary }: VolumeGridsProps) {
  const floorRef = useRef<THREE.GridHelper>(null);

  useLayoutEffect(() => {
    if (floorRef.current) {
      const material = floorRef.current.material as THREE.LineBasicMaterial;
      material.transparent = true;
      material.opacity = 0.2; // Floor opacity set to 0.3
    }
  }, []);
  
  const gridMaterial = useMemo(() => {
    const mat = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    mat.colorNode = color(colorSecondary);

    // Your 8x8 Math
    const coord = uv().mul(8.0);
    const grid = abs(fract(coord.sub(0.5)).sub(0.5)).div(fwidth(coord));
    const lineDist = min(grid.x, grid.y);
    const edge = min(uv(), float(1.0).sub(uv())).div(fwidth(uv()));
    const finalLine = min(lineDist, min(edge.x, edge.y));
    const alpha = float(1.0).sub(clamp(finalLine.sub(0.01), 0.0, 1.0));
    
    mat.opacityNode = alpha.mul(0.05);
    
    return mat;
  }, [colorSecondary]);

  return (
    <group>
      <gridHelper
        ref={floorRef}
        args={[size * 1.5, 12, colorMain, colorSecondary]} 
        position={[0, -size / 2, 0]} 
      />

      <mesh>
        <boxGeometry args={[size, size, size]} />
        <primitive object={gridMaterial} attach="material" />
      </mesh>
    </group>
  );
}