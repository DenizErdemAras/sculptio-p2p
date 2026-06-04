/// <reference types="vite/client" />

export type ModerationMode = 'disabled' | 'blacklist' | 'whitelist';

export interface ModerationPolicy {
  mode: ModerationMode;
  blacklist: string[];
  whitelist: string[];
}

type DhtNetworkOptions = {
  selectedNetworkId?: string;
  bootstrapNodes?: string[];
};

export interface IElectronAPI {
  // --- WINDOW CONTROLS ---
  windowMinimize: () => void;
  windowMaximize: () => void;
  windowClose: () => void;
  windowFullscreen: () => void;
  onFullscreenChange: (callback: (isFullscreen: boolean) => void) => () => void;
  onTitlebarHover: (callback: (isHovering: boolean) => void) => void;
  
  // --- USER DATA & CRYPTO ---
  readUserData: () => Promise<any>;
  writeUserData: (data: Record<string, any>) => Promise<void>;
  getKeys: (seed: string) => Promise<{ publicKey: string, secretKey: string }>;

  // --- LOBBY NETWORKING ---
  connect: (seed: string, networkOptions?: DhtNetworkOptions) => Promise<string>;
  kickPlayer: (pubKeyStr: string, reason?: string) => Promise<boolean>;
  setModerationPolicy: (policy: ModerationPolicy) => Promise<boolean>;
  disconnectAll: () => Promise<boolean>;
  refreshLobby: () => Promise<boolean>;
  joinLobby: () => Promise<string>;

  // --- GAME ROOM LIFECYCLE ---
  // Notice: 'profile' is removed from startRoomServer
  startRoomServer: (config: any, seedHex: string) => Promise<string>;
  announceRoom: (config: any, seedHex: string, seq: number) => Promise<boolean>;
  stopAnnouncingRoom: (seedHex: string, seq: number) => Promise<boolean>;
  joinRoomServer: (hostPubKeyStr: string, userProfile: any) => Promise<boolean>;
  updateRoomConfig: (config: any) => void;

  // --- IN-GAME MESSAGING (Backend commands) ---
  broadcastToRoom: (msgTypeName: string, payload: any) => void;
  sendToPlayer: (pubKeyStr: string, msgTypeName: string, payload: any) => void;
  sendToServer: (msgTypeName: string, payload: any) => void;

  // --- EVENT LISTENERS ---
  onPeerConnected: (callback: (peerKey: string) => void) => () => void;
  onRoomListUpdated: (callback: (rooms: any[]) => void) => () => void;
  onVersionUpdated: (callback: (version: string) => void) => () => void;
  
  // NEW: The universal pipe for all game data
  onRoomEvent: (callback: (eventData: { type: string, payload: any, pubKey?: string }) => void) => () => void;
}

declare global {
  interface Window {
    api: IElectronAPI;
  }
}