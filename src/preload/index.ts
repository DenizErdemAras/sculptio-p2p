import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

contextBridge.exposeInMainWorld('api', {
  
  // --- WINDOW CONTROLS ---
  windowMinimize: () => ipcRenderer.send('window-minimize'),
  windowMaximize: () => ipcRenderer.send('window-maximize'),
  windowClose: () => ipcRenderer.send('window-close'),
  windowFullscreen: () => ipcRenderer.send('window-fullscreen'), 
  onFullscreenChange: (callback: (isFullscreen: boolean) => void) => {
    const listener = (_event: any, isFullscreen: boolean) => callback(isFullscreen);
    ipcRenderer.on('fullscreen-changed', listener);
    
    // Return a function that React can call to clean up the listener
    return () => {
      ipcRenderer.removeListener('fullscreen-changed', listener);
    };
  },

  onTitlebarHover: (callback: (isHovering: boolean) => void) => {
    // We remove existing listeners so React strict mode doesn't duplicate them
    ipcRenderer.removeAllListeners('titlebar-hover-state');
    ipcRenderer.on('titlebar-hover-state', (_event, isHovering) => callback(isHovering));
  },

  // --- USER DATA & CRYPTO ---
  readUserData: () => ipcRenderer.invoke('userData-read'),
  writeUserData: (data: Record<string, any>) => ipcRenderer.invoke('userData-write', data),
  getKeys: (seed: string) => ipcRenderer.invoke('get-keys', seed),

  // --- LOBBY NETWORKING ---
  connect: (seedHex: string, networkOptions?: any) => {
    return ipcRenderer.invoke('swarm-connect', seedHex, networkOptions);
  },
  kickPlayer: (pubKeyStr: string, reason?: string) => ipcRenderer.invoke('kick-player', pubKeyStr, reason),
  setModerationPolicy: (policy: any) => ipcRenderer.invoke('set-moderation-policy', policy),
  disconnectAll: () => ipcRenderer.invoke('swarm-disconnect'),

  joinLobby: () => ipcRenderer.invoke('swarm-join-lobby'),
  refreshLobby: () => ipcRenderer.invoke('refresh-lobby'),
  
  // --- GAME ROOM NETWORKING ---
  startRoomServer: (config: any, seedHex: string, profile: any) => ipcRenderer.invoke('swarm-start-server', config, seedHex, profile),
  announceRoom: (config: any, seedHex: string, seq: number) => ipcRenderer.invoke('swarm-announce-room', config, seedHex, seq),
  stopAnnouncingRoom: (seedHex: string, seq: number) => ipcRenderer.invoke('swarm-stop-announcing', seedHex, seq),
  joinRoomServer: (hostPubKeyStr: string, userProfile: any) => ipcRenderer.invoke('swarm-join-room', hostPubKeyStr, userProfile),

  // --- EVENT LISTENERS ---
  onPeerConnected: (callback: (peerKey: string) => void) => {
    const listener = (_event: IpcRendererEvent, value: string) => callback(value);
    ipcRenderer.on('peer-connected', listener);
    
    // Returns a cleanup function for React's useEffect
    return () => ipcRenderer.off('peer-connected', listener);
  },

  onRoomListUpdated: (callback: (rooms: any[]) => void) => {
    const listener = (_event: IpcRendererEvent, rooms: any[]) => callback(rooms);
    ipcRenderer.on('room-list-updated', listener);
    
    return () => ipcRenderer.off('room-list-updated', listener);
  },

  onVersionUpdated: (callback: (version: string) => void) => {
    const listener = (_event: IpcRendererEvent, version: string) => callback(version);
    ipcRenderer.on('version-updated', listener);
    
    return () => ipcRenderer.off('version-updated', listener);
  },

  broadcastToRoom: (msgTypeName: string, payload: any) => ipcRenderer.send('swarm-broadcast', msgTypeName, payload),
  sendToPlayer: (pubKeyStr: string, msgTypeName: string, payload: any) => ipcRenderer.send('swarm-send-to-player', pubKeyStr, msgTypeName, payload),
  sendToServer: (msgTypeName: string, payload: any) => ipcRenderer.send('swarm-send-to-server', msgTypeName, payload),

  updateRoomConfig: (config: any) => ipcRenderer.send('update-room-config', config),

  // --- UNIVERSAL GAME EVENT LISTENER (Node to React) ---
  onRoomEvent: (callback: (eventData: any) => void) => {
    const listener = (_event: any, data: any) => callback(data);
    ipcRenderer.on('room-event', listener);
    return () => ipcRenderer.off('room-event', listener); // Returns the cleanup function
  }
});