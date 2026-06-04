// import { useState, useEffect } from 'react';
import { X, Minus, Maximize } from 'lucide-react';
import Restore from '../assets/icons/restore-icon.svg?react';
import { useContext } from 'react';
import { UIContext } from '../contexts/UIContext';

export default function TitleBar() {
  const ui = useContext(UIContext);
  if (!ui) return;

  return (
    <>
    <span className="titlebar-text">Sculptio</span>
    <div className={`titlebar ${ui.isFullscreen ? (ui.isTitleBarHovered  ? 'fullscreen hovered' : 'fullscreen') : 'hovered'}`}>
      <div className="titlebar-controls titlebar-window-controls">
        <button className="ghost minus" onClick={ui.minimizeWindow} title='Minimize'><Minus /></button>
        {!ui.isFullscreen && <button className="ghost restore" onClick={ui.maximizeWindow} title='Restore'><Restore /></button>}
        <button className="ghost fullscreen" onClick={ui.toggleFullscreen} title='Fullscreen'><Maximize /></button>
        <button className={`${!ui.isFullscreen || ui.isTitleBarHovered ? 'close' : 'ghost'} x`} onClick={ui.closeWindow} title='Close'><X /></button>
      </div>
    </div>
    </>
  );
} 