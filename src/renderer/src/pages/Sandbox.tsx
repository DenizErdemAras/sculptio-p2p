// src/renderer/src/pages/Sandbox.tsx
import { useContext } from 'react';
import { LogOut } from 'lucide-react';
import { UIContext } from '../contexts/UIContext';
import Sculptor from '../components/Sculptor';

export default function Sandbox() {
  const ui = useContext(UIContext);

  return (
    <div className="window-content flex-row">
      <div className="titlebar-controls room-titlebar-controls">
        <button
          className="close pad-4 rotate-180"
          onClick={() => ui?.setView('menu')}
        >
          <LogOut />
        </button>

        <span className="title-bar-room-name">Sandbox</span>

        <div style={{ width: '24px' }} />
      </div>

      <div className="game-area centered relative">
        <Sculptor
          mode="solo"
          showTools={true}
          onBrushAction={() => {}}
          onRequestBrushHistory={() => {}}
        />
      </div>
    </div>
  );
}