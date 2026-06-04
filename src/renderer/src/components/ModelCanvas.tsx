// src/renderer/src/components/ModelCanvas.tsx
import {
    forwardRef,
    useCallback,
    useEffect,
    useImperativeHandle,
    useMemo,
    useRef,
    useState,
    type Ref
} from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three/webgpu';
import { newVolume, ThreeAdapter } from '../lib/gpu-mc';
import { getBrushBounds, VolumeGrids } from './ModelCanvas.utils';

// --- CONFIGURATION ---
const GRID_SIZE: [number, number, number] = [128, 128, 128];
const CHUNK_SIZE = 32;
const VOXEL_SIZE = 1.0;
const ISO_LEVEL = 0.5;

const COLOR_BACKGROUND = '#232323';

const COLOR_GRID_MAIN = '#888888';
const COLOR_GRID_SECONDARY = '#666666';

const COLOR_MODEL_DEFAULT = 0x00aaff;

const COLOR_PREVIEW_ADD = 0x33ccaa;
const COLOR_PREVIEW_REMOVE = 0xff73a5;
const PREVIEW_STRENGTH = 3;

const NETWORK_TICK_MS = 33;

const CAMERA_STARTING_DISTANCE = 0.75;
const CAMERA_LERP_SPEED = 1;

type Vec3 = [number, number, number];

export type ModelShaderAction = {
    actionId?: number;
    brush: string;
    mode?: string;
    offset?: Vec3;
    min?: Vec3;
    max?: Vec3;
    isoLevel?: number;
    params?: Record<string, number>;
};

interface ModelCanvasProps {
    mode: 'sculptor' | 'guesser';
    currentTool: { type: string; radius: number; strength: number };
    gamePhase?: any;
    showGrids?: boolean;

    remoteBrushAction?: ModelShaderAction | null;
    remoteBrushActionSeq?: number;

    remoteBrushHistoryBatch?: ModelShaderAction[] | null;
    remoteBrushHistoryBatchSeq?: number;

    onBrushAction: (payload: ModelShaderAction) => void;
    onRequestBrushHistory: (startIndex?: number) => void;
}

export interface ModelCanvasHandle {
    reset: (shape?: string, size?: number) => Promise<void>;
    applyStartingShape: (shape?: string, size?: number, broadcast?: boolean) => Promise<void>;
    setGridsVisible: (visible: boolean) => void;
    toggleGrids: () => void;
}

const DEFAULT_SHAPE = 'sphere';

function createStartingShapeAction(
    shape = DEFAULT_SHAPE,
    size = 24
): ModelShaderAction | null {
    const safeSize = Math.max(2, Number(size) || 24);
    const falloff = Math.max(1, safeSize / 6);

    switch (shape) {
        case 'sphere':
            return {
                actionId: Math.floor(Math.random() * 1_000_000),
                brush: 'sphere',
                mode: 'set',
                offset: [0, 0, 0],
                params: {
                    strength: 1,
                    radius: safeSize,
                    falloff
                }
            };

        case 'cube':
            return {
                actionId: Math.floor(Math.random() * 1_000_000),
                brush: 'cube',
                mode: 'set',
                offset: [0, 0, 0],
                params: {
                    strength: 1,
                    radius: safeSize,
                    falloff: Math.max(1, safeSize / 8)
                }
            };

        case 'cylinder':
            return {
                actionId: Math.floor(Math.random() * 1_000_000),
                brush: 'cylinder',
                mode: 'set',
                offset: [0, 0, 0],
                params: {
                    radius: safeSize + 0.1,
                    strength: safeSize * 2,
                    falloff
                }
            };

        case 'torus':
            return {
                actionId: Math.floor(Math.random() * 1_000_000),
                brush: 'torus',
                mode: 'set',
                offset: [0, 0, 0],
                params: {
                    radius: safeSize,
                    strength: safeSize * 0.35,
                    falloff: Math.max(1, safeSize / 8)
                }
            };

        default:
            console.warn(`[ModelCanvas] Unknown starting shape: ${shape}`);
            return null;
    }
}

async function applyShaderAction(
    model: any,
    action: ModelShaderAction,
    updateAfter = true
) {
    model.applyShader({
        brush: action.brush,
        mode: action.mode ?? 'set',
        offset: action.offset ?? [0, 0, 0],
        min: action.min,
        max: action.max,
        isoLevel: action.isoLevel,
        params: action.params ?? {}
    });

    if (updateAfter) {
        await model.update();
    }
}

async function applyStartingShape(
    model: any,
    shape = DEFAULT_SHAPE,
    size = 24
) {
    const action = createStartingShapeAction(shape, size);
    if (!action) return;

    model.clearPreview?.();

    await applyShaderAction(model, action, true);
}

function disposeMaterial(material: any) {
    if (!material) return;

    if (Array.isArray(material)) {
        material.forEach(disposeMaterial);
        return;
    }

    material.dispose?.();
}

function disposeThreeObject(object: any) {
    if (!object) return;

    object.traverse?.((child: any) => {
        child.geometry?.dispose?.();
        disposeMaterial(child.material);
    });
}

async function renderWebGPUFrame(renderer: any, scene: any, camera: any) {
    if (typeof renderer.renderAsync === 'function') {
        await renderer.renderAsync(scene, camera);
        return;
    }

    renderer.render(scene, camera);
}

// Internal engine component that sits inside the <Canvas>
function Engine({
    mode,
    currentTool,
    gamePhase,
    showGrids = true,
    remoteBrushAction,
    remoteBrushActionSeq = 0,
    remoteBrushHistoryBatch,
    remoteBrushHistoryBatchSeq = 0,
    onBrushAction,
    onRequestBrushHistory,
    modelCanvasRef
}: ModelCanvasProps & { modelCanvasRef: Ref<ModelCanvasHandle> }) {
    const { scene, camera, gl } = useThree();

    // Refs for logic sync
    const toolRef = useRef(currentTool);
    const modeRef = useRef(mode);
    const onBrushActionRef = useRef(onBrushAction);
    const lastSculptTime = useRef(0);
    const isBusy = useRef(false);
    const isRenderingIdleFrame = useRef(false);

    const inputState = useRef({
        isLMBDown: false,
        isShiftDown: false,
        isCtrlDown: false,
        doCtrlRightClick: false
    });

    const controlsRef = useRef<any>(null);
    const targetOrbitPos = useRef(new THREE.Vector3(0, 0, 0));
    const isLerpingCamera = useRef(false);

    const [volumeReady, setVolumeReady] = useState(false);
    const [gridsVisible, setGridsVisible] = useState(showGrids);
    const modelRef = useRef<any>(null);
    const adapterRef = useRef<any>(null);

    const hasRequestedHistory = useRef(false);
    const gamePhaseRef = useRef(gamePhase);

    const onRequestBrushHistoryRef = useRef(onRequestBrushHistory);

    const pendingRemoteActions = useRef<any[]>([]);
    const pendingRemoteHistoryBatches = useRef<any[][]>([]);
    const isApplyingRemoteQueue = useRef(false);
    const lastRemoteBrushActionSeq = useRef(0);
    const lastRemoteBrushHistoryBatchSeq = useRef(0);

    useEffect(() => {
        gamePhaseRef.current = gamePhase;
    }, [gamePhase]);

    useEffect(() => {
        setGridsVisible(showGrids);
    }, [showGrids]);

    useEffect(() => {
        onRequestBrushHistoryRef.current = onRequestBrushHistory;
    }, [onRequestBrushHistory]);

    useEffect(() => {
        toolRef.current = currentTool;
    }, [currentTool]);

    useEffect(() => {
        onBrushActionRef.current = onBrushAction;
    }, [onBrushAction]);

    // Hologram Materials
    const previewAddMat = useMemo(() => new THREE.MeshStandardMaterial({
        color: COLOR_PREVIEW_ADD,
        transparent: true,
        opacity: 0.3,
        depthWrite: false,
        side: THREE.DoubleSide,
        roughness: 0.4,
        metalness: 0.8
    }), []);

    const previewRemoveMat = useMemo(() => new THREE.MeshStandardMaterial({
        color: COLOR_PREVIEW_REMOVE,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        side: THREE.DoubleSide,
        roughness: 0.7,
        metalness: 0.85
    }), []);

    const waitForModelIdle = useCallback(async () => {
        while (isBusy.current) {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
    }, []);

    const clearInputState = useCallback(() => {
        inputState.current = {
            isLMBDown: false,
            isShiftDown: false,
            isCtrlDown: false,
            doCtrlRightClick: false
        };

        lastSculptTime.current = 0;
    }, []);

    const clearPreview = useCallback(async () => {
        if (!modelRef.current) return;

        modelRef.current.clearPreview?.();

        // Some preview implementations update their own mesh immediately.
        // Some need a frame/update to flush stale preview geometry.
        await modelRef.current.update?.();
    }, []);

    const applyBrushAction = async (
        action: ModelShaderAction,
        updateAfter = true
    ) => {
        if (!modelRef.current) return;

        await applyShaderAction(modelRef.current, action, updateAfter);
    };

    const flushRemoteBrushQueue = useCallback(async () => {
        if (!modelRef.current) return;
        if (modeRef.current !== 'guesser') return;
        if (isApplyingRemoteQueue.current) return;

        isApplyingRemoteQueue.current = true;

        try {
            await waitForModelIdle();

            isBusy.current = true;

            try {
                while (pendingRemoteHistoryBatches.current.length > 0) {
                    const batch = pendingRemoteHistoryBatches.current.shift() ?? [];

                    console.log(
                        `[Late Join] Applying batch with ${batch.length} brush operations`
                    );

                    const applyStart = performance.now();

                    for (const action of batch) {
                        await applyBrushAction(action, false);
                    }

                    const applyEnd = performance.now();

                    console.log(
                        `[Late Join] Brush replay took ${(applyEnd - applyStart).toFixed(2)} ms`
                    );

                    const updateStart = performance.now();

                    const stats = await modelRef.current.update();

                    const updateEnd = performance.now();

                    console.log(
                        `[Late Join] model.update() took ${(updateEnd - updateStart).toFixed(2)} ms`
                    );

                    console.log(
                        `[Late Join] Total batch sync took ${(updateEnd - applyStart).toFixed(2)} ms`
                    );

                    console.log(
                        `[Late Join] Update stats:`,
                        stats
                    );
                }

                while (pendingRemoteActions.current.length > 0) {
                    const action = pendingRemoteActions.current.shift();
                    await applyBrushAction(action, true);
                }
            } finally {
                isBusy.current = false;
            }
        } finally {
            isApplyingRemoteQueue.current = false;
        }
    }, [waitForModelIdle]);

    const applyStartingShapeToModel = useCallback(async (
        shape = DEFAULT_SHAPE,
        size = 24,
        broadcast = false
    ) => {
        if (!modelRef.current) return;

        const action = createStartingShapeAction(shape, size);
        if (!action) return;

        await waitForModelIdle();

        isBusy.current = true;

        try {
            clearInputState();
            modelRef.current.clearPreview?.();

            await applyShaderAction(modelRef.current, action, true);
            await clearPreview();

            if (broadcast) {
                onBrushActionRef.current(action);
            }
        } finally {
            isBusy.current = false;
        }
    }, [waitForModelIdle, clearInputState, clearPreview]);

    const resetModel = useCallback(async (
        shape = DEFAULT_SHAPE,
        size = 24
    ) => {
        await applyStartingShapeToModel(shape, size, false);
    }, [applyStartingShapeToModel]);

    useImperativeHandle(modelCanvasRef, () => ({
        reset: resetModel,

        applyStartingShape: async (
            shape = DEFAULT_SHAPE,
            size = 24,
            broadcast = true
        ) => {
            await applyStartingShapeToModel(shape, size, broadcast);
        },

        setGridsVisible: (visible: boolean) => {
            setGridsVisible(visible);
        },

        toggleGrids: () => {
            setGridsVisible(prev => !prev);
        }
    }), [resetModel, applyStartingShapeToModel]);

    // Remote live brush action from NetworkContext
    useEffect(() => {
        if (!remoteBrushAction) return;
        if (remoteBrushActionSeq === lastRemoteBrushActionSeq.current) return;

        lastRemoteBrushActionSeq.current = remoteBrushActionSeq;
        pendingRemoteActions.current.push(remoteBrushAction);

        void flushRemoteBrushQueue();
    }, [remoteBrushAction, remoteBrushActionSeq, flushRemoteBrushQueue]);

    // Remote history batch from NetworkContext
    useEffect(() => {
        if (!remoteBrushHistoryBatch) return;
        if (remoteBrushHistoryBatchSeq === lastRemoteBrushHistoryBatchSeq.current) return;

        lastRemoteBrushHistoryBatchSeq.current = remoteBrushHistoryBatchSeq;
        pendingRemoteHistoryBatches.current.push(remoteBrushHistoryBatch);

        void flushRemoteBrushQueue();
    }, [remoteBrushHistoryBatch, remoteBrushHistoryBatchSeq, flushRemoteBrushQueue]);

    // Late-join history request
    useEffect(() => {
        if (!volumeReady) return;
        if (modeRef.current !== 'guesser') return;
        if (hasRequestedHistory.current) return;

        const phase = gamePhaseRef.current;
        if (!phase) return;

        if (phase.roomState === 2 && phase.gameState === 1) {
            hasRequestedHistory.current = true;
            onRequestBrushHistoryRef.current(0);
        }
    }, [volumeReady, gamePhase?.roomState, gamePhase?.gameState]);

    useEffect(() => {
        if (gamePhase?.gameState === 0) {
            hasRequestedHistory.current = false;
            pendingRemoteActions.current = [];
            pendingRemoteHistoryBatches.current = [];
        }
    }, [gamePhase?.gameState, gamePhase?.roundNumber]);

    
    useEffect(() => {
        modeRef.current = mode;

        if (mode !== 'guesser') return;

        clearInputState();

        void (async () => {
            await waitForModelIdle();

            isBusy.current = true;

            try {
                await clearPreview();
            } finally {
                isBusy.current = false;
            }
        })();
    }, [mode, clearInputState, clearPreview, waitForModelIdle]);

    // Initialization
    useEffect(() => {
        let isDestroyed = false;

        const initVolume = async () => {
            await (gl as any).init();

            const device = (gl as any).backend.device;

            const model = await newVolume(GRID_SIZE, CHUNK_SIZE, {
                device,
                isoLevel: ISO_LEVEL,
                vertexFormat: 'pos3-norm3',
                enablePreview: true,
                capEdges: true
            });

            if (isDestroyed) {
                model.dispose();
                return;
            }

            const adapter = new ThreeAdapter(model, { THREE, renderer: gl });
            adapter.setMaterial(new THREE.MeshStandardMaterial({
                color: COLOR_MODEL_DEFAULT,
                roughness: 0.5,
                metalness: 0.25
            }));

            scene.add(adapter.getMesh());
            scene.add(adapter.getPreviewMesh());

            const worldSize = GRID_SIZE[0] * VOXEL_SIZE;

            camera.position.set(
                worldSize * CAMERA_STARTING_DISTANCE,
                worldSize * CAMERA_STARTING_DISTANCE,
                worldSize * CAMERA_STARTING_DISTANCE
            );

            camera.lookAt(0, 0, 0);

            await model.setShader({
                addBrush: `
                    let dist = (params.radius - length(pos()) - params.falloff) / params.falloff;
                    return val(vec3(0)) + smoothstep(0.0, 1.0, dist) * params.strength;
                `,

                sphere: `
                    let d = length(pos()) - params.radius;
                    return smoothstep(params.falloff, -params.falloff, d);
                `,

                cube: `
                    let q = abs(pos()) - vec3(params.radius);
                    let outside = length(max(q, vec3(0.0)));
                    let inside = min(max(q.x, max(q.y, q.z)), 0.0);
                    let d = outside + inside;

                    return smoothstep(params.falloff, -params.falloff, d);
                `,

                cylinder: `
                    let p = pos();

                    let transitionHeight = 4.0;
                    let halfHeight = params.strength * 0.5;

                    let radialD = length(p.xz) - params.radius;
                    let cylinderDensity = smoothstep(params.falloff, -params.falloff, radialD);
                    let clampedCylinderDensity = clamp(cylinderDensity, 0.0, 1.0);

                    let solidLimit = halfHeight - transitionHeight;

                    // 1 in body, fades to 0 in the cap transition layer, 0 above/below.
                    let verticalFade = 1.0 - smoothstep(
                        solidLimit,
                        halfHeight,
                        abs(p.y)
                    );

                    // Use unclamped cylinder in the body, clamped cylinder near the cap.
                    let capBlend = smoothstep(
                        solidLimit,
                        halfHeight,
                        abs(p.y)
                    );

                    let density = mix(
                        cylinderDensity,
                        clampedCylinderDensity,
                        capBlend
                    ) * verticalFade;

                    return density;
                `,

                torus: `
                    let p = pos();

                    let q = vec2(
                        length(p.xz) - params.radius,
                        p.y
                    );

                    let d = length(q) - params.strength;

                    return smoothstep(params.falloff, -params.falloff, d);
                `
            }, ['strength', 'radius', 'falloff'], 'params');

            await applyStartingShape(model, 'sphere', 24);

            if (isDestroyed) {
                model.dispose();
                return;
            }

            modelRef.current = model;
            adapterRef.current = adapter;
            setVolumeReady(true);

            void flushRemoteBrushQueue();
        };

        initVolume();

        return () => {
            isDestroyed = true;

            const adapter = adapterRef.current;

            if (adapter) {
                const meshGroup = adapter.getMesh?.();
                const previewGroup = adapter.getPreviewMesh?.();

                if (meshGroup) scene.remove(meshGroup);
                if (previewGroup) scene.remove(previewGroup);

                if (typeof adapter.dispose === 'function') {
                    adapter.dispose();
                } else {
                    disposeThreeObject(meshGroup);
                    disposeThreeObject(previewGroup);
                }
            }

            previewAddMat.dispose?.();
            previewRemoveMat.dispose?.();

            modelRef.current?.dispose?.();

            pendingRemoteActions.current = [];
            pendingRemoteHistoryBatches.current = [];

            adapterRef.current = null;
            modelRef.current = null;
        };
    }, [gl, scene, camera, previewAddMat, previewRemoveMat, flushRemoteBrushQueue]);

    // Sculpt Loop
    useFrame((state) => {
        if (!volumeReady) return;

        const renderFrame = async () => {
            await renderWebGPUFrame(state.gl as any, state.scene, state.camera);
        };

        // 1. Camera Lerp
        if (isLerpingCamera.current && controlsRef.current) {
            controlsRef.current.target.lerp(targetOrbitPos.current, CAMERA_LERP_SPEED);

            if (controlsRef.current.target.distanceTo(targetOrbitPos.current) < 0.1) {
                isLerpingCamera.current = false;
            }
        }

        if (isBusy.current) return;

        const needsTargetRaycast = inputState.current.doCtrlRightClick;
        const isSculptor = modeRef.current === 'sculptor';

        // 2. Idle guesser rendering
        if (!isSculptor && !needsTargetRaycast) {
            if (!isRenderingIdleFrame.current) {
                isRenderingIdleFrame.current = true;

                renderFrame()
                    .catch(console.error)
                    .finally(() => {
                        isRenderingIdleFrame.current = false;
                    });
            }

            return;
        }

        isBusy.current = true;

        (async () => {
            try {
                state.raycaster.setFromCamera(state.pointer, state.camera);

                const origin = state.raycaster.ray.origin.toArray();
                const dir = state.raycaster.ray.direction.toArray();

                // 3. Ctrl + Right Click Targeting
                if (inputState.current.doCtrlRightClick) {
                    inputState.current.doCtrlRightClick = false;

                    const hit = await modelRef.current.raycast(origin, dir);

                    if (hit) {
                        targetOrbitPos.current.set(hit[0], hit[1], hit[2]);
                    } else {
                        targetOrbitPos.current.set(0, 0, 0);
                    }

                    isLerpingCamera.current = true;
                }

                // 4. Brush Logic
                if (isSculptor) {
                    const hitPoint = await modelRef.current.raycast(origin, dir);

                    if (hitPoint) {
                        const r = toolRef.current.radius;
                        let s = toolRef.current.strength;

                        if (inputState.current.isCtrlDown) {
                            s *= 2;
                        }

                        const isRemoving = inputState.current.isShiftDown;
                        const shaderRadius = r * 2;
                        const { min, max } = getBrushBounds(hitPoint, shaderRadius, modelRef.current);

                        adapterRef.current.setPreviewMaterial(
                            isRemoving ? previewRemoveMat : previewAddMat
                        );

                        const previewAction: ModelShaderAction = {
                            brush: 'addBrush',
                            mode: 'combined-overlay',
                            offset: hitPoint as Vec3,
                            min,
                            max,
                            isoLevel: isRemoving ? ISO_LEVEL + 0.001 : ISO_LEVEL + 0.012,
                            params: {
                                strength: s * PREVIEW_STRENGTH * (isRemoving ? -1 : 1),
                                radius: shaderRadius,
                                falloff: r
                            }
                        };

                        modelRef.current.previewShader(previewAction);

                        const now = performance.now();

                        if (
                            inputState.current.isLMBDown &&
                            now - lastSculptTime.current > NETWORK_TICK_MS
                        ) {
                            const action: ModelShaderAction = {
                                actionId: Math.floor(Math.random() * 1_000_000),
                                brush: 'addBrush',
                                mode: 'set',
                                offset: hitPoint as Vec3,
                                min,
                                max,
                                params: {
                                    strength: s * (isRemoving ? -1 : 1),
                                    radius: shaderRadius,
                                    falloff: r
                                }
                            };

                            await applyShaderAction(modelRef.current, action, false);

                            lastSculptTime.current = now;
                            onBrushActionRef.current(action);

                            // console.log(await modelRef.current.getMeshStats());
                        }

                        await modelRef.current.update();
                    } else {
                        modelRef.current.clearPreview();
                    }
                }

                await renderFrame();
            } finally {
                isBusy.current = false; 
            }
        })();
    }, 1);

    // Input Listeners
    useEffect(() => {
        const down = (e: KeyboardEvent) => {
            if (e.key === 'Shift') inputState.current.isShiftDown = true;
            if (e.key === 'Control') inputState.current.isCtrlDown = true;
        };

        const up = (e: KeyboardEvent) => {
            if (e.key === 'Shift') inputState.current.isShiftDown = false;
            if (e.key === 'Control') inputState.current.isCtrlDown = false;
        };

        const mDown = (e: PointerEvent) => {
            if (e.button === 0) {
                inputState.current.isLMBDown = true;
            }

            if (e.button === 2 && inputState.current.isCtrlDown) {
                inputState.current.doCtrlRightClick = true;
            }
        };

        const mUp = (e: PointerEvent) => {
            if (e.button === 0) {
                inputState.current.isLMBDown = false;
            }
        };

        window.addEventListener('keydown', down);
        window.addEventListener('keyup', up);
        window.addEventListener('pointerdown', mDown);
        window.addEventListener('pointerup', mUp);

        return () => {
            window.removeEventListener('keydown', down);
            window.removeEventListener('keyup', up);
            window.removeEventListener('pointerdown', mDown);
            window.removeEventListener('pointerup', mUp);
        };
    }, []);

    return (
        <>
            <OrbitControls
                ref={controlsRef}
                makeDefault
                enableDamping
                mouseButtons={{
                    LEFT: mode === 'sculptor' ? -1 as never : THREE.MOUSE.ROTATE,
                    MIDDLE: THREE.MOUSE.DOLLY,
                    RIGHT: THREE.MOUSE.ROTATE
                }}
            />

            <ambientLight intensity={0.3} />
            <directionalLight position={[100, 100, 50]} intensity={1.5} />
            <directionalLight position={[-60, -30, -60]} intensity={0.5} />
            <hemisphereLight args={[0xffffff, 0xff4400, 0.4]} />

            {gridsVisible && (
                <VolumeGrids
                    size={GRID_SIZE[0] * VOXEL_SIZE}
                    colorMain={COLOR_GRID_MAIN}
                    colorSecondary={COLOR_GRID_SECONDARY}
                />
            )}
        </>
    );
}

const ModelCanvas = forwardRef<ModelCanvasHandle, ModelCanvasProps>(function ModelCanvas(props, ref) {
    const rendererRef = useRef<any>(null);

    useEffect(() => {
        return () => {
            const renderer = rendererRef.current;

            try {
                renderer?.dispose?.();
            } catch (err) {
                console.error('[ModelCanvas] WebGPURenderer dispose() failed:', err);
            }

            rendererRef.current = null;
        };
    }, []);

    return (
        <div style={{ width: '100%', height: '100%', minWidth: 0, minHeight: 0, position: 'relative' }}>
            <Canvas
                className="model-canvas"
                style={{ position: 'absolute', top: 0, left: 0 }}
                shadows
                gl={(canvasProps: any) => {
                    const renderer = new THREE.WebGPURenderer({
                        canvas: canvasProps.canvas,
                        antialias: true,
                        powerPreference: 'high-performance'
                    });

                    rendererRef.current = renderer;

                    return renderer as any;
                }}
            >
                <color attach="background" args={[COLOR_BACKGROUND]} />
                <Engine {...props} modelCanvasRef={ref} />
            </Canvas>
        </div>
    );
});

export default ModelCanvas;