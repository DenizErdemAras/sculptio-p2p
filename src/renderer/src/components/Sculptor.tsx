// src/renderer/src/components/Sculptor.tsx
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState
} from 'react';
import ModelCanvas, { type ModelCanvasHandle, type ModelShaderAction } from './ModelCanvas';
import '../assets/Sculptor.css';

export interface SculptorHandle {
  reset: (shape?: string, size?: number) => Promise<void>;
  applyStartingShape: (shape?: string, size?: number, broadcast?: boolean) => Promise<void>;
  setGridsVisible: (visible: boolean) => void;
  toggleGrids: () => void;
}

interface SculptorProps {
  mode: 'sculptor' | 'guesser' | 'solo';
  gamePhase?: any;
  showTools?: boolean;
  showGrids?: boolean;
  editable?: boolean;
  onBrushAction?: (action: ModelShaderAction) => void;
  onRequestBrushHistory?: (startIndex?: number) => void;
  remoteBrushAction?: ModelShaderAction | null; // !!!!!
  remoteBrushActionSeq?: number;
  remoteBrushHistoryBatch?: ModelShaderAction[] | null; // !!!!!
  remoteBrushHistoryBatchSeq?: number;
}

const Sculptor = forwardRef<SculptorHandle, SculptorProps>(function Sculptor({
  mode,
  gamePhase,
  showTools = true,
  showGrids = true,
  onBrushAction,
  onRequestBrushHistory,
  remoteBrushAction,
  remoteBrushActionSeq,
  remoteBrushHistoryBatch,
  remoteBrushHistoryBatchSeq
}, ref) {
  const modelCanvasRef = useRef<ModelCanvasHandle | null>(null);
  const [sculptTool, setSculptTool] = useState({
    type: 'addBrush',
    radius: 10,
    strength: 0.2
  });

  const isEditing = mode === 'sculptor' || mode === 'solo';

  const [gridsVisible, setGridsVisible] = useState(showGrids);

  const [baseShape, setBaseShape] = useState('sphere');
  const [baseShapeSize, _setBaseShapeSize] = useState(24);

  const applyBaseShape = async () => {
    await modelCanvasRef.current?.applyStartingShape(baseShape, baseShapeSize, true);
  };

  useEffect(() => {
    setGridsVisible(showGrids);
  }, [showGrids]);

  useImperativeHandle(ref, () => ({
    reset: async (shape = 'sphere', size = 24) => {
      await modelCanvasRef.current?.reset(shape, size);
    },

    applyStartingShape: async (
      shape = 'sphere',
      size = 24,
      broadcast = true
    ) => {
      await modelCanvasRef.current?.applyStartingShape(shape, size, broadcast);
    },

    setGridsVisible: (visible: boolean) => {
      setGridsVisible(visible);
      modelCanvasRef.current?.setGridsVisible(visible);
    },

    toggleGrids: () => {
      setGridsVisible(prev => {
        const next = !prev;
        modelCanvasRef.current?.setGridsVisible(next);
        return next;
      });
    }
  }), []);

  return (
    <div className="sculptor-area centered">
      <ModelCanvas
        ref={modelCanvasRef}
        mode={isEditing ? 'sculptor' : 'guesser'}
        currentTool={sculptTool}
        gamePhase={gamePhase}
        showGrids={gridsVisible}
        remoteBrushAction={remoteBrushAction}
        remoteBrushActionSeq={remoteBrushActionSeq}
        remoteBrushHistoryBatch={remoteBrushHistoryBatch}
        remoteBrushHistoryBatchSeq={remoteBrushHistoryBatchSeq}
        onBrushAction={onBrushAction || (() => {})}
        onRequestBrushHistory={onRequestBrushHistory || (() => {})}
      />

      {showTools && (
        <div className="sculptor-tools panel transparent flex-row gap-6">
          <div className="flex-column gap-2">
            <div className="flex-row gap-6">
              <select
                className="config-select"
                value={baseShape}
                onChange={(e) => setBaseShape(e.target.value)}
              >
                <option value="sphere">Sphere</option>
                <option value="cube">Cube</option>
                <option value="cylinder">Cylinder</option>
                <option value="torus">Torus</option>
              </select>

              <button
                className="mid light"
                type="button"
                onClick={applyBaseShape}
              >
                Reset
              </button>
            </div>
          </div>

          <div className="flex-column gap-2">
            <label>Radius: {sculptTool.radius}</label>
            <input
              type="range"
              min="2"
              max="20"
              step="1"
              value={sculptTool.radius}
              onChange={(e) => {
                setSculptTool(prev => ({
                  ...prev,
                  radius: Number(e.target.value)
                }));
              }}
            />
          </div>

          <div className="flex-column gap-2">
            <label>Strength: {sculptTool.strength}</label>
            <input
              type="range"
              min="0.1"
              max="1"
              step="0.1"
              value={sculptTool.strength}
              onChange={(e) => {
                setSculptTool(prev => ({
                  ...prev,
                  strength: Number(e.target.value)
                }));
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
});

export default Sculptor;