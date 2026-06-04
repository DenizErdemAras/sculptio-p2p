// src/renderer/src/contexts/NetworkContext.tsx
import React, { createContext, useState, useContext, useEffect, useRef } from 'react';
import { UserContext } from './UserContext';
import { UIContext } from './UIContext'; 

export const NetworkContext = createContext<any>(null);
const CURRENT_APP_VERSION = "1.0.0"; 

export const NetworkProvider = ({ children }: { children: React.ReactNode }) => {
  const [status, setStatus] = useState<'offline' | 'connecting' | 'error' | 'lobby' | 'creating_room' | 'in_room'>('offline');
  const [roomConfig, setRoomConfig] = useState<any>(null);
  const { userData, updateUserData } = useContext(UserContext);
  const ui = useContext(UIContext); 

  const [compatibleRooms, setCompatibleRooms] = useState<any[]>([]);
  const [_incompatibleRooms, setIncompatibleRooms] = useState<any[]>([]);
  const [latestKnownVersion, setLatestKnownVersion] = useState(CURRENT_APP_VERSION);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  

  const roomSeqRef = useRef(0);
  const [roomCode, setRoomCode] = useState<string | null>(null);
  const [isHost, setIsHost] = useState(false);

  const joinReturnViewRef = useRef<'menu' | 'lobby'>('lobby');
  const roomJoinAcceptedRef = useRef(false);

  const [remoteBrushAction, setRemoteBrushAction] = useState<any | null>(null);
  const [remoteBrushActionSeq, setRemoteBrushActionSeq] = useState(0);

  const [remoteBrushHistoryBatch, setRemoteBrushHistoryBatch] = useState<any[] | null>(null);
  const [remoteBrushHistoryBatchSeq, setRemoteBrushHistoryBatchSeq] = useState(0);

  type ModerationMode = 'disabled' | 'blacklist' | 'whitelist';

  type ModerationPolicy = {
    mode: ModerationMode;
    blacklist: string[];
    whitelist: string[];
  };

  const getModerationPolicy = (): ModerationPolicy => {
    return {
      mode: userData?.preferences?.moderation?.mode ?? 'disabled',
      blacklist: userData?.preferences?.moderation?.blacklist ?? [],
      whitelist: userData?.preferences?.moderation?.whitelist ?? [],
    };
  };

  const syncModerationPolicyToMain = async (policy = getModerationPolicy()) => {
    if (!window.api?.setModerationPolicy) return;
    await window.api.setModerationPolicy(policy);
  };

  const updateModerationPolicy = async (updates: Partial<ModerationPolicy>) => {
    const current = getModerationPolicy();

    const next: ModerationPolicy = {
      mode: updates.mode ?? current.mode,
      blacklist: updates.blacklist ?? current.blacklist,
      whitelist: updates.whitelist ?? current.whitelist,
    };

    await updateUserData({
      preferences: {
        ...(userData.preferences ?? {}),
        moderation: next,
      }
    });

    await syncModerationPolicyToMain(next);
  };

  const setModerationMode = async (mode: ModerationMode) => {
    await updateModerationPolicy({ mode });
  };

  const blockPublicKey = async (publicKey: string) => {
    const key = publicKey.trim();
    if (!key) return;

    const current = getModerationPolicy();
    const blacklist = Array.from(new Set([...current.blacklist, key]));

    await updateModerationPolicy({ blacklist });
  };

  const unblockPublicKey = async (publicKey: string) => {
    const current = getModerationPolicy();

    await updateModerationPolicy({
      blacklist: current.blacklist.filter(k => k !== publicKey),
    });
  };

  const allowPublicKey = async (publicKey: string) => {
    const key = publicKey.trim();
    if (!key) return;

    const current = getModerationPolicy();
    const whitelist = Array.from(new Set([...current.whitelist, key]));

    await updateModerationPolicy({ whitelist });
  };

  const disallowPublicKey = async (publicKey: string) => {
    const current = getModerationPolicy();

    await updateModerationPolicy({
      whitelist: current.whitelist.filter(k => k !== publicKey),
    });
  };

  const isPublicKeyBlocked = (publicKey: string) => {
    return getModerationPolicy().blacklist.includes(publicKey);
  };

  const isPublicKeyAllowed = (publicKey: string) => {
    const policy = getModerationPolicy();

    if (policy.mode === 'disabled') return true;
    if (policy.mode === 'blacklist') return !policy.blacklist.includes(publicKey);
    if (policy.mode === 'whitelist') return policy.whitelist.includes(publicKey);

    return true;
  };
    
  useEffect(() => {
    if (!window.api) return;
    const removeRoomListener = window.api.onRoomListUpdated((rawRoomList: any[]) => {
      const compatible: any[] = [];
      const incompatible: any[] = [];
      rawRoomList.forEach(room => {
        if (room.version > latestKnownVersion) return; 
        if (room.version === CURRENT_APP_VERSION) compatible.push(room);
        else incompatible.push(room);
      });
      setCompatibleRooms(compatible);
      setIncompatibleRooms(incompatible);
    });

    const removeVersionListener = window.api.onVersionUpdated((newVersion: string) => {
      setLatestKnownVersion(newVersion);
      if (newVersion > CURRENT_APP_VERSION) setUpdateAvailable(true);
    });

    return () => {
      removeRoomListener();
      removeVersionListener();
    };
  }, [latestKnownVersion]);

  useEffect(() => {
    if (!window.api || !userData?.seed) return;

    syncModerationPolicyToMain().catch(console.error);
  }, [
    userData?.seed,
    userData?.preferences?.moderation?.mode,
    userData?.preferences?.moderation?.blacklist,
    userData?.preferences?.moderation?.whitelist,
  ]);

  useEffect(() => {
    if (!window.api) return;

    const removeRoomEventListener = window.api.onRoomEvent((event) => {
      if (
        event.type === 'HOST_SYNC_CONFIG' ||
        event.type === 'HOST_SYNC_PLAYERS' ||
        event.type === 'HOST_SYNC_STATE'
      ) {
        roomJoinAcceptedRef.current = true;
      }

      if (event.type === 'HOST_DISCONNECTED') {
        const returnView = roomJoinAcceptedRef.current
          ? 'menu'
          : joinReturnViewRef.current;

        setRoomCode(null);
        setStatus(returnView === 'lobby' ? 'lobby' : 'offline');
        setIsHost(false);

        setRemoteBrushAction(null);
        setRemoteBrushActionSeq(0);
        setRemoteBrushHistoryBatch(null);
        setRemoteBrushHistoryBatchSeq(0);

        roomJoinAcceptedRef.current = false;
        joinReturnViewRef.current = 'lobby';

        ui?.setView(returnView);
        return;
      }

      if (event.type === 'HOST_BRUSH_RELAY' || event.type === 'CLIENT_BRUSH') {
        setRemoteBrushAction(event.payload);
        setRemoteBrushActionSeq(seq => seq + 1);
        return;
      }

      if (event.type === 'HOST_BRUSH_HISTORY_BATCH') {
        setRemoteBrushHistoryBatch(Array.isArray(event.payload) ? event.payload : []);
        setRemoteBrushHistoryBatchSeq(seq => seq + 1);
      }
    });

    return () => {
      removeRoomEventListener();
    };
  }, [ui]);

  const getSelectedDhtNetworkOptions = () => {
    const dhtPreference = userData?.preferences?.dhtNetwork;

    const selectedNetworkId = dhtPreference?.selectedNetworkId ?? 'default';

    if (selectedNetworkId === 'default') {
      return {
        selectedNetworkId: 'default',
        bootstrapNodes: []
      };
    }

    const selectedNetwork = dhtPreference?.customNetworks?.find(
      (network: any) => network.id === selectedNetworkId
    );

    return {
      selectedNetworkId,
      bootstrapNodes: Array.isArray(selectedNetwork?.bootstrapNodes)
        ? selectedNetwork.bootstrapNodes
        : []
    };
  };

  const ensureNetworkInitialized = async () => {
    if (!userData?.seed) throw new Error("Missing seed.");

    await window.api.connect(userData.seed, getSelectedDhtNetworkOptions());
    await syncModerationPolicyToMain();
  };

  const connectToLobby = async () => {
    try {
      if (!userData?.seed || !ui) return;
      setStatus('connecting');
      ui.setView('lobby');
      await ensureNetworkInitialized();
      await window.api.joinLobby();
      setStatus('lobby');
    } catch (err) {
      setStatus('error');
      ui?.setView('menu');
    }
  };

  const refreshLobbyRooms = async () => {
    try {
      if (!window.api) return;

      setStatus('connecting');
      await window.api.refreshLobby();
      setStatus('lobby');
    } catch (err) {
      console.error(err);
      setStatus('error');
    }
  };

  const disconnectFromNetwork = async () => {
    try {
      if (isHost && roomConfig?.visibilityStatus === 'public') {
        await stopAnnouncingRoom();
      }
      await window.api.disconnectAll();
      setStatus('offline');
      ui?.setView('menu');
      setRoomCode(null);
      roomSeqRef.current = 0;
      setIsHost(false);
      setRemoteBrushAction(null);
      setRemoteBrushActionSeq(0);
      setRemoteBrushHistoryBatch(null);
      setRemoteBrushHistoryBatchSeq(0);
    } catch (err) {
      console.error(err);
    }
  };

  const createAndHostRoom = async (config: any) => {
    try {
      if (!userData?.seed) throw new Error("Missing seed.");

      setStatus('creating_room');

      await ensureNetworkInitialized();

      setRoomConfig(config);
      roomSeqRef.current = 0;
      setIsHost(true);

      const code = await window.api.startRoomServer(config, userData.seed);

      setRoomCode(code);
      setStatus('in_room');
      ui?.setView('room');

      setRemoteBrushAction(null);
      setRemoteBrushActionSeq(0);
      setRemoteBrushHistoryBatch(null);
      setRemoteBrushHistoryBatchSeq(0);
    } catch (err) {
      console.error(err);
    }
  };

  const nextRoomSeq = () => {
    const seq = roomSeqRef.current;
    roomSeqRef.current += 1;
    return seq;
  };

  const announceRoomState = async (freshConfig: any) => {
    try {
      if (!userData?.seed) return;

      const seq = nextRoomSeq();

      await window.api.announceRoom(
        {
          ...freshConfig,
          hostName: userData.username || 'Host'
        },
        userData.seed,
        seq
      );
    } catch (err) {
      console.error(err);
      throw err;
    }
  };

  const stopAnnouncingRoom = async () => {
    try {
      if (!userData?.seed) return;

      const seq = nextRoomSeq();
      await window.api.stopAnnouncingRoom(userData.seed, seq);
    } catch (err) {
    console.error(err);
        throw err;
    }
  };

  const joinRoom = async (
    hostPubKeyStr: string,
    password = "",
    returnToView: 'menu' | 'lobby' = 'lobby'
  ) => {
    try {
      if (!userData) return;

      joinReturnViewRef.current = returnToView;
      roomJoinAcceptedRef.current = false;

      await ensureNetworkInitialized();

      const userProfile = {
        name: userData.username || 'Player',
        password
      };

      await window.api.joinRoomServer(hostPubKeyStr, userProfile);

      setRoomCode(hostPubKeyStr);
      setStatus('in_room');
      ui?.setView('room');
      setIsHost(false);

      setRemoteBrushAction(null);
      setRemoteBrushActionSeq(0);
      setRemoteBrushHistoryBatch(null);
      setRemoteBrushHistoryBatchSeq(0);
    } catch (err) {
      console.error(err);

      setRoomCode(null);
      setStatus(returnToView === 'lobby' ? 'lobby' : 'offline');
      setIsHost(false);
      roomJoinAcceptedRef.current = false;
      joinReturnViewRef.current = 'lobby';

      ui?.setView(returnToView);
      ui?.alert?.('Join Failed', 'Could not join the room. Check the invitation code and password.');
    }
  };

  const sendToServer = (msgTypeName: string, payload: any) => {
    window.api.sendToServer(msgTypeName, payload);
  };

  const sendToPlayer = (pubKeyStr: string, msgTypeName: string, payload: any) => {
    window.api.sendToPlayer(pubKeyStr, msgTypeName, payload);
  };

  const broadcastToRoom = (msgTypeName: string, payload: any) => {
    window.api.broadcastToRoom(msgTypeName, payload);
  };

  const moderationPolicy = getModerationPolicy();
  
  return (
    <NetworkContext.Provider value={{ 
      status, roomCode, roomConfig, isHost,
      compatibleRooms, updateAvailable,

      moderationPolicy,
      setModerationMode,
      updateModerationPolicy,
      blockPublicKey,
      unblockPublicKey,
      allowPublicKey,
      disallowPublicKey,
      isPublicKeyBlocked,
      isPublicKeyAllowed,

      remoteBrushAction,
      remoteBrushActionSeq,
      remoteBrushHistoryBatch,
      remoteBrushHistoryBatchSeq,

      connectToLobby, refreshLobbyRooms, disconnectFromNetwork, createAndHostRoom, 
      announceRoomState, stopAnnouncingRoom, joinRoom,
      sendToServer, sendToPlayer, broadcastToRoom
    }}>
      {children}
    </NetworkContext.Provider>
  );
};