import Hyperswarm from 'hyperswarm';
import crypto from 'crypto';
import b4a from 'b4a';
import bs58 from 'bs58';
import Protomux from 'protomux';
import c from 'compact-encoding';
import { BrowserWindow } from 'electron';
import {
    DEV_PUBLIC_KEY,
    APP_VERSION,
    V1_SIGNATURE,
    ROOM_GOSSIP_KIND,
    roomSchema,
    versionSchema
} from './protocol';
import { brushSchema, chatRelaySchema, gameLogSchema, configSchema, gameStateSchema, guessBroadcastSchema, joinReqSchema, playerSchema } from './roomProtocol';
// @ts-ignore
import DHT from 'hyperdht';

let swarm: any = null;

type ModerationMode = 'disabled' | 'blacklist' | 'whitelist';

type ModerationPolicy = {
  mode: ModerationMode;
  blacklist: string[];
  whitelist: string[];
};

let moderationPolicy: ModerationPolicy = {
  mode: 'disabled',
  blacklist: [],
  whitelist: [],
};

let isServerNode = false;
let isLobbyServerJoined = false;

// The Main Process raw dictionary and version tracker
const activeGossipChannels = new Set<any>();

const ROOM_TTL_MS = 30_000;
// const ROOM_REFRESH_MS = 10_000;

type KnownRoomEntry = {
  room: any;
  receivedAt: number;
};

const knownRooms = new Map<string, KnownRoomEntry>();
let latestKnownVersion = APP_VERSION;
let roomPruneTimer: NodeJS.Timeout | null = null;

const getRoomCrypto = (seedHex: string) => {
  // Hash the seed so the room key is different from the lobby key, but consistently reproducible
  const roomSeed = crypto.createHash('sha256').update(seedHex + 'sculptio-room').digest();

  // The DHT Keypair for the actual server
  const roomKeyPair = DHT.keyPair(roomSeed);

  // The Node.js Private Key for signing the gossip
  const pkcs8Header = Buffer.from('302e020100300506032b657004220420', 'hex');
  const pkcs8Key = Buffer.concat([pkcs8Header, roomSeed]);
  const roomPrivateKey = crypto.createPrivateKey({ key: pkcs8Key, format: 'der', type: 'pkcs8' });

  return { roomKeyPair, roomPrivateKey };
};

const getUserCrypto = (seedHex: string) => {
  const userSeed = b4a.from(seedHex, 'hex');
  const userKeyPair = DHT.keyPair(userSeed);

  const pkcs8Header = Buffer.from('302e020100300506032b657004220420', 'hex');
  const pkcs8Key = Buffer.concat([pkcs8Header, userSeed]);
  const userPrivateKey = crypto.createPrivateKey({ key: pkcs8Key, format: 'der', type: 'pkcs8' });

  return { userKeyPair, userPrivateKey };
};

const encodeRoomForSignature = (room: any) => {
  const state = c.state();

  c.uint8.preencode(state, room.kind);
  c.buffer.preencode(state, room.publicKey);
  c.uint32.preencode(state, room.seq);
  c.uint8.preencode(state, room.userLimit);
  c.uint8.preencode(state, room.currPlayers);
  c.string.preencode(state, room.roomName);
  c.string.preencode(state, room.hostName);
  c.buffer.preencode(state, room.hostPublicKey);
  c.uint8.preencode(state, room.hasPassword ? 1 : 0);
  c.string.preencode(state, room.language);
  c.string.preencode(state, room.version);

  state.buffer = b4a.alloc(state.end);

  c.uint8.encode(state, room.kind);
  c.buffer.encode(state, room.publicKey);
  c.uint32.encode(state, room.seq);
  c.uint8.encode(state, room.userLimit);
  c.uint8.encode(state, room.currPlayers);
  c.string.encode(state, room.roomName);
  c.string.encode(state, room.hostName);
  c.uint8.preencode(state, room.hasPassword ? 1 : 0);
  c.string.encode(state, room.language);
  c.string.encode(state, room.version);

  return state.buffer;
};

const sendRoomsToReact = () => {
  const windows = BrowserWindow.getAllWindows();
  if (windows.length > 0) {
    // Format the data cleanly for the UI (Base58 ID, strip signature)
    const formattedRooms = Array.from(knownRooms.values()).map(entry => {
      const room = entry.room;

      return {
        publicKey: bs58.encode(room.publicKey),
        seq: room.seq,
        userLimit: room.userLimit,
        currPlayers: room.currPlayers,
        roomName: room.roomName,
        hostName: room.hostName,
        hostPublicKey:bs58.encode(room.hostPublicKey),
        hasPassword: !!room.hasPassword,
        language: room.language,
        version: room.version
      };
    });

    windows[0].webContents.send('room-list-updated', formattedRooms);
  }
};

const pruneExpiredRooms = () => {
    const now = Date.now();
    let changed = false;

    for (const [pubKeyStr, entry] of knownRooms.entries()) {
        if (now - entry.receivedAt > ROOM_TTL_MS) {
            console.log(`[LOBBY] Room expired: ${entry.room.roomName}`);
            knownRooms.delete(pubKeyStr);
            changed = true;
        }
    }

    if (changed) {
        sendRoomsToReact();
    }
};

const startRoomPruneTimer = () => {
    if (roomPruneTimer) return;

    roomPruneTimer = setInterval(pruneExpiredRooms, 1000);
};

const stopRoomPruneTimer = () => {
    if (!roomPruneTimer) return;

    clearInterval(roomPruneTimer);
    roomPruneTimer = null;
};

const sendVersionToReact = () => {
  const windows = BrowserWindow.getAllWindows();
  if (windows.length > 0) {
    windows[0].webContents.send('version-updated', latestKnownVersion);
  }
};

export const getKeysFromSeed = (seedHex: string) => {
  const seed = b4a.from(seedHex, 'hex');
  const keyPair = DHT.keyPair(seed);
  return {
    publicKey: bs58.encode(keyPair.publicKey),
    secretKey: b4a.toString(keyPair.secretKey, 'hex')
  };
};

type DhtNetworkOptions = {
  selectedNetworkId?: string;
  bootstrapNodes?: string[];
};

const normalizeBootstrapNodes = (nodes: unknown): string[] => {
  if (!Array.isArray(nodes)) return [];

  return nodes
    .map(node => String(node ?? '').trim())
    .filter(Boolean);
};

export const initializeSwarm = (
  seedHex: string,
  networkOptions: DhtNetworkOptions = {}
) => {
  if (swarm) return b4a.toString(swarm.keyPair.publicKey, 'hex');

  const seed = b4a.from(seedHex, 'hex');
  const keyPair = DHT.keyPair(seed);

  const bootstrapNodes = normalizeBootstrapNodes(networkOptions.bootstrapNodes);

  const dhtOptions: any = {
    ephemeral: true
  };

  if (
    networkOptions.selectedNetworkId &&
    networkOptions.selectedNetworkId !== 'default' &&
    bootstrapNodes.length > 0
  ) {
    dhtOptions.bootstrap = bootstrapNodes;
  }

  console.log(`[SYSTEM] Initializing DHT network:`, {
    selectedNetworkId: networkOptions.selectedNetworkId ?? 'default',
    bootstrapNodeCount: bootstrapNodes.length
  });

  const dht = new DHT(dhtOptions);

  swarm = new Hyperswarm({ dht, keyPair });

  startRoomPruneTimer();

  console.log(`[SYSTEM] Swarm Initialized. Local DHT Key: ${bs58.encode(swarm.keyPair.publicKey).substring(0,8)}...`);

  // --- NEW: DEEP NETWORK LOGGING ---
  swarm.on('peer', (_peer: any) => {
    console.log(`[DHT EVENT] Discovered a peer looking for our topic!`);
  });
  
  swarm.on('peer-rejected', (_peer: any, info: any) => {
    console.log(`[DHT EVENT] Peer rejected. Reason: ${info?.reason}`);
  });
  // ---------------------------------

  swarm.on('connection', (socket: any, info: any) => {
    // info.client tells us if WE initiated the connection (true) or if they connected to US (false)
    console.log(`[SWARM] => CONNECTION ESTABLISHED! (Did I initiate? ${info.client})`);
    
    const mux = new Protomux(socket);
    const channel = mux.createChannel({ protocol: 'sculptio-lobby' });

    const versionMsg = channel.addMessage({
      encoding: versionSchema,
      onmessage: (msg: any) => {
        try {
          // Wrap the raw DEV_PUBLIC_KEY in an SPKI header so Node can read it
          const spkiHeader = Buffer.from('302a300506032b6570032100', 'hex');
          const devKeyObj = crypto.createPublicKey({
            key: Buffer.concat([spkiHeader, DEV_PUBLIC_KEY]),
            format: 'der',
            type: 'spki'
          });

          const isValid = crypto.verify(null, b4a.from(msg.version, 'utf-8'), devKeyObj, msg.signature);
          if (isValid && msg.version > latestKnownVersion) {
            console.log(`[VERSION] Network upgraded to version ${msg.version}`);
            latestKnownVersion = msg.version;
            sendVersionToReact();
          }
        } catch (err) {
          console.error(`[VERSION] Handshake verification crashed:`, err);
        }
      }
    });

    const requestRoomsMsg = channel.addMessage({
      encoding: c.buffer,
      onmessage: () => {
        console.log(`[LOBBY] Peer requested rooms. Am I hosting the lobby? ${isServerNode}`);
        if (!isServerNode) return;

        pruneExpiredRooms();

        for (const entry of knownRooms.values()) {
          console.log(`[LOBBY] Sending room: ${entry.room.roomName} to peer.`);
          roomGossipMsg.send(entry.room);
        }
      }
    });

    const roomGossipMsg = channel.addMessage({
      encoding: roomSchema,
      onmessage: (room: any) => {
        console.log(`[LOBBY] Received room gossip: ${room.roomName || '<remove-room>'}`);

        if (room.version > latestKnownVersion) return;

        try {
          const spkiHeader = Buffer.from('302a300506032b6570032100', 'hex');
          const formattedPubKey = crypto.createPublicKey({
            key: Buffer.concat([spkiHeader, room.publicKey]),
            format: 'der',
            type: 'spki'
          });

          const signedBytes = encodeRoomForSignature(room);
          const isValid = crypto.verify(null, signedBytes, formattedPubKey, room.signature);

          console.log(`[LOBBY] Signature valid? ${isValid}`);

          if (!isValid) return;
        } catch (err) {
          console.error(`[LOBBY] Crypto verification crashed:`, err);
          return;
        }

        const pubKeyStr = bs58.encode(room.publicKey);
        const existingEntry = knownRooms.get(pubKeyStr);

        // Ignore stale gossip.
        // If we already know seq 5, seq 4 should not update/remove anything.
        if (existingEntry && room.seq <= existingEntry.room.seq) {
          return;
        }

        if (room.kind === ROOM_GOSSIP_KIND.REMOVE) {
          console.log(`[LOBBY] Remove-room accepted: ${pubKeyStr.substring(0, 8)}...`);

          knownRooms.delete(pubKeyStr);
            sendRoomsToReact();

            if (isServerNode) {
            activeGossipChannels.forEach(peerChannel => peerChannel.send(room));
          }

          return;
        }

        if (room.kind !== ROOM_GOSSIP_KIND.UPSERT) {
            return;
        }

        console.log(`[LOBBY] Room accepted! Sending to React...`);

        knownRooms.set(pubKeyStr, {
          room,
          receivedAt: Date.now()
        });

        sendRoomsToReact();

        if (!isServerNode) return;

        activeGossipChannels.forEach(peerChannel => peerChannel.send(room));
      }
    });

    channel.open();
    activeGossipChannels.add(roomGossipMsg);

    versionMsg.send({ version: APP_VERSION, signature: V1_SIGNATURE });
    
    console.log(`[SWARM] Requesting room list from new peer...`);
    requestRoomsMsg.send(b4a.alloc(1));

    socket.on('close', () => {
      console.log(`[SWARM] Connection closed.`);
      activeGossipChannels.delete(roomGossipMsg);
    });
  });

  return b4a.toString(swarm.keyPair.publicKey, 'hex');
};





export const joinLobby = async () => {
  if (!swarm) throw new Error('Swarm not initialized');
  console.log(`[SYSTEM] Joining Lobby Topic as CLIENT-ONLY...`);

  knownRooms.clear(); 
  sendRoomsToReact();
  
  const topic = crypto.createHash('sha256').update('sculptio-game-lobby-v1').digest();
  const discovery = swarm.join(topic, { client: true, server: false }); 
  
  await discovery.flushed();
  console.log(`[SYSTEM] Lobby discovery flush complete. Waiting for peers...`);
  return b4a.toString(topic, 'hex');
};





export const refreshLobby = async () => {
  if (!swarm) throw new Error('Swarm not initialized');
  console.log(`[SYSTEM] Refreshing Lobby connection...`);

  knownRooms.clear(); 
  sendRoomsToReact();
  
  const topic = crypto.createHash('sha256').update('sculptio-game-lobby-v1').digest();
  await swarm.leave(topic);
  const discovery = swarm.join(topic, { client: true, server: false }); 
  
  await discovery.flushed();
  console.log(`[SYSTEM] Lobby refresh complete. Aggressive lookup finished.`);
  return true;
};





// --- ROOM STATE ---
let roomServer: any = null;
let clientOutMsg: Record<string, any> = {}; // Used when WE are the client
const roomConnections = new Map<string, any>(); // Used when WE are the Host

// Helper to send game events up to React
const sendRoomEventToReact = (eventType: string, payload: any, pubKey?: string) => {
  const windows = BrowserWindow.getAllWindows();
  if (windows.length > 0) {
    windows[0].webContents.send('room-event', { type: eventType, payload, pubKey });
  }
};

const normalizePolicy = (policy: Partial<ModerationPolicy> | null | undefined): ModerationPolicy => {
  const mode = policy?.mode === 'blacklist' || policy?.mode === 'whitelist'
    ? policy.mode
    : 'disabled';

  return {
    mode,
    blacklist: Array.isArray(policy?.blacklist) ? [...new Set(policy.blacklist.filter(Boolean))] : [],
    whitelist: Array.isArray(policy?.whitelist) ? [...new Set(policy.whitelist.filter(Boolean))] : [],
  };
};

const isPeerAllowed = (pubKeyStr: string): boolean => {
  if (moderationPolicy.mode === 'disabled') return true;

  if (moderationPolicy.mode === 'blacklist') {
    return !moderationPolicy.blacklist.includes(pubKeyStr);
  }

  if (moderationPolicy.mode === 'whitelist') {
    return moderationPolicy.whitelist.includes(pubKeyStr);
  }

  return true;
};

const getModerationRejectReason = (): string => {
  if (moderationPolicy.mode === 'blacklist') {
    return 'You are blocked by this room host.';
  }

  if (moderationPolicy.mode === 'whitelist') {
    return 'This room only allows whitelisted players.';
  }

  return 'Connection rejected.';
};

export const setModerationPolicy = (policy: Partial<ModerationPolicy>) => {
  moderationPolicy = normalizePolicy(policy);
  console.log(`[MODERATION] Policy updated:`, {
    mode: moderationPolicy.mode,
    blacklistCount: moderationPolicy.blacklist.length,
    whitelistCount: moderationPolicy.whitelist.length,
  });

  return true;
};

// --- THE HOST LOGIC ---
export const startRoomServer = async (roomConfig: any, seedHex: string) => {
  if (!swarm) throw new Error('Swarm not initialized');

  const { roomKeyPair } = getRoomCrypto(seedHex);
  const rawPublicKeyStr = bs58.encode(roomKeyPair.publicKey);

  roomConnections.clear();

  if (roomServer) await roomServer.close();

  roomServer = swarm.dht.createServer((conn: any) => {
    const remotePubKeyStr = bs58.encode(conn.remotePublicKey);
    console.log(`[HOST] Incoming connection from: ${remotePubKeyStr.substring(0,8)}...`);

    console.log(`[HOST] Incoming connection remotePublicKey FULL: ${remotePubKeyStr}`);

    const mux = new Protomux(conn);
    const roomChannel = mux.createChannel({ protocol: 'sculptio-room' });

    // IMPORTANT: Messages MUST be added in the exact same order on Host and Client!
    
    // 1. HOST -> CLIENT (IDs 0-8)
    const outMsg = {
      syncConfig: roomChannel.addMessage({ encoding: configSchema }),
      syncPlayers: roomChannel.addMessage({ encoding: c.array(playerSchema) }),
      syncState: roomChannel.addMessage({ encoding: gameStateSchema }),
      chatRelay: roomChannel.addMessage({ encoding: chatRelaySchema }),
      brushRelay: roomChannel.addMessage({ encoding: brushSchema }),
      wordChoices: roomChannel.addMessage({ encoding: c.array(c.string) }),
      playerGuess: roomChannel.addMessage({ encoding: guessBroadcastSchema }),
      log: roomChannel.addMessage({ encoding: gameLogSchema }),
      systemNotice: roomChannel.addMessage({ encoding: c.string }),
      brushHistoryBatch: roomChannel.addMessage({ encoding: c.array(brushSchema) })
    } as any;

    if (!isPeerAllowed(remotePubKeyStr)) {
      roomChannel.open();

      try {
        outMsg.systemNotice.send(getModerationRejectReason());
      } catch (e) {
        console.error(`[HOST] Failed to send moderation rejection notice:`, e);
      }

      setTimeout(() => conn.destroy(), 200);
      return;
    }

    if (roomConnections.size + 1 >= roomConfig.playerLimit) { 
      roomChannel.open();
      try { outMsg.systemNotice.send("Room is full"); } catch(e) { console.error(e); }
      setTimeout(() => conn.destroy(), 200); 
      return;
    }

    outMsg._conn = conn;

    roomConnections.set(remotePubKeyStr, outMsg);

    // 2. CLIENT -> HOST (IDs 9-14)
    roomChannel.addMessage({ encoding: joinReqSchema, onmessage: (req) => {
      if (!isPeerAllowed(remotePubKeyStr)) {
        console.log(`[HOST] Blocked CLIENT_JOIN_REQ from ${remotePubKeyStr.substring(0, 8)}...`);
        kickPlayer(remotePubKeyStr, getModerationRejectReason());
        return;
      }

      console.log(`[HOST] Received CLIENT_JOIN_REQ:`, req);
      sendRoomEventToReact('CLIENT_JOIN_REQ', req, remotePubKeyStr);
    }});
    
    roomChannel.addMessage({ encoding: c.uint32, onmessage: (index) => {
      sendRoomEventToReact('CLIENT_BRUSH_HISTORY_REQ', index, remotePubKeyStr);
    }});
    
    roomChannel.addMessage({ encoding: c.string, onmessage: (msg) => {
      sendRoomEventToReact('CLIENT_CHAT', msg, remotePubKeyStr);
      // removed relay to add spoiler checking
      // const payload = { publicKey: remotePubKeyStr, message: msg };
      // roomConnections.forEach((peer, _key) => {
      //   try { peer.chatRelay.send(payload); } catch(e) { console.error(`[HOST] Chat Relay Encode Error:`, e); }
      // });
    }});
    
    roomChannel.addMessage({ encoding: c.string, onmessage: (guess) => {
      sendRoomEventToReact('CLIENT_GUESS', guess, remotePubKeyStr);
    }});
    
    roomChannel.addMessage({ encoding: c.uint8, onmessage: (choice) => {
      sendRoomEventToReact('CLIENT_WORD_PICK', choice, remotePubKeyStr);
    }});
    
    roomChannel.addMessage({ encoding: brushSchema, onmessage: (brush) => {
      sendRoomEventToReact('CLIENT_BRUSH', brush, remotePubKeyStr);
      roomConnections.forEach((peer, key) => {
        if (key !== remotePubKeyStr) {
          try { peer.brushRelay.send(brush); } catch(e) { console.error(`[HOST] Brush Relay Encode Error:`, e); }
        }
      });
    }});

    roomChannel.open();

    conn.on('close', () => {
      console.log(`[HOST] Player disconnected: ${remotePubKeyStr.substring(0,8)}...`);
      roomConnections.delete(remotePubKeyStr);
      sendRoomEventToReact('CLIENT_DISCONNECT', null, remotePubKeyStr);
    });
  });

  await roomServer.listen(roomKeyPair);
  console.log(`[HOST] Room Server running. Code: ${rawPublicKeyStr.substring(0,8)}...`);
  return rawPublicKeyStr; 
};

// --- REACT COMMAND PIPES WITH DEEP LOGGING ---

export const broadcastToRoom = (msgTypeName: string, payload: any) => {
  console.log(`[HOST->ALL] Broadcasting '${msgTypeName}' with payload:`, payload);
  roomConnections.forEach((peer) => {
    const targetMsg = peer[msgTypeName];
    if (targetMsg) {
      try {
        targetMsg.send(payload);
      } catch(err) {
        console.error(`[CRITICAL ENCODE ERROR] Failed to broadcast '${msgTypeName}'. Payload mismatch with schema!`, err);
      }
    }
  });
};

export const sendToPlayer = (pubKeyStr: string, msgTypeName: string, payload: any) => {
  console.log(`[HOST->CLIENT] Sending '${msgTypeName}' to ${pubKeyStr.substring(0,8)} with payload:`, payload);
  const peer = roomConnections.get(pubKeyStr);
  if (peer) {
    const targetMsg = peer[msgTypeName];
    if (targetMsg) {
      try {
        targetMsg.send(payload);
      } catch(err) {
        console.error(`[CRITICAL ENCODE ERROR] Failed to send '${msgTypeName}'. Payload mismatch with schema!`, err);
      }
    }
  }
};


// --- THE CLIENT LOGIC ---

export const joinRoomServer = (hostPubKeyStr: string, userProfile: any) => {
  return new Promise((resolve, reject) => {
    if (!swarm) return reject(new Error('Swarm not initialized'));

    try {
      const hostKeyBuffer = bs58.decode(hostPubKeyStr);
      const conn = swarm.dht.connect(hostKeyBuffer, { keyPair: swarm.keyPair });

      conn.once('open', () => {
        console.log(`[CLIENT] Connected to Host Socket!`);
        const mux = new Protomux(conn);
        const roomChannel = mux.createChannel({ protocol: 'sculptio-room' });

        // IMPORTANT: Messages MUST be added in the exact same order on Host and Client!
        
        // 1. HOST -> CLIENT (IDs 0-8)
        const bindHostListener = (encoding: any, eventName: string) => {
          roomChannel.addMessage({ encoding, onmessage: (payload) => {
            console.log(`[CLIENT] Received ${eventName}:`, payload);
            sendRoomEventToReact(eventName, payload, hostPubKeyStr);
          }});
        };

        bindHostListener(configSchema, 'HOST_SYNC_CONFIG');
        bindHostListener(c.array(playerSchema), 'HOST_SYNC_PLAYERS');
        bindHostListener(gameStateSchema, 'HOST_SYNC_STATE');
        bindHostListener(chatRelaySchema, 'HOST_CHAT_RELAY');
        bindHostListener(brushSchema, 'HOST_BRUSH_RELAY'); 
        bindHostListener(c.array(c.string), 'HOST_WORD_CHOICES');
        bindHostListener(guessBroadcastSchema, 'HOST_PLAYER_GUESS');
        bindHostListener(gameLogSchema, 'HOST_LOG');
        bindHostListener(c.string, 'HOST_SYSTEM_NOTICE');
        bindHostListener(c.array(brushSchema), 'HOST_BRUSH_HISTORY_BATCH');

        // 2. CLIENT -> HOST (IDs 9-14)
        clientOutMsg = {
          CLIENT_JOIN_REQ: roomChannel.addMessage({ encoding: joinReqSchema }),
          CLIENT_BRUSH_HISTORY_REQ: roomChannel.addMessage({ encoding: c.uint32 }),
          CLIENT_CHAT: roomChannel.addMessage({ encoding: c.string }),
          CLIENT_GUESS: roomChannel.addMessage({ encoding: c.string }),
          CLIENT_WORD_PICK: roomChannel.addMessage({ encoding: c.uint8 }),
          CLIENT_BRUSH: roomChannel.addMessage({ encoding: brushSchema })
        };

        roomChannel.open();

        console.log(`[CLIENT] Sending CLIENT_JOIN_REQ with profile:`, userProfile);
        try {
          clientOutMsg.CLIENT_JOIN_REQ.send(userProfile);
        } catch(err) {
          console.error(`[CRITICAL ENCODE ERROR] Failed to send CLIENT_JOIN_REQ!`, err);
        }

        resolve(true); 
      });

      conn.once('error', (err: any) => reject(new Error(`Connection failed: ${err.message}`)));
      conn.once('close', () => {
        clientOutMsg = {};
        console.log(`[CLIENT] Socket to Host was closed.`);
        sendRoomEventToReact('HOST_DISCONNECTED', null);
      });

    } catch (err) {
      reject(new Error('Invalid Room Code'));
    }
  });
};

export const sendToServer = (msgTypeName: string, payload: any) => {
  if (!clientOutMsg) return;
  const targetMsg = clientOutMsg[msgTypeName];
  if (targetMsg) {
    console.log(`[CLIENT->HOST] Sending '${msgTypeName}' with payload:`, payload);
    try {
      targetMsg.send(payload);
    } catch(err) {
      console.error(`[CRITICAL ENCODE ERROR] Failed to send '${msgTypeName}'.`, err);
    }
  }
};






export const announceRoom = async (roomConfig: any, seedHex: string, seq: number) => {
  if (!swarm) throw new Error('Swarm not initialized');

  isServerNode = true;
  console.log(`[HOST] Announcing room: ${roomConfig.roomName} (Seq: ${seq})`);

  // Grab our dedicated room identity
  const { roomKeyPair, roomPrivateKey } = getRoomCrypto(seedHex);
  const { userKeyPair } = getUserCrypto(seedHex);
  const currentPlayers = roomConnections.size + 1;

  const roomState = {
    kind: ROOM_GOSSIP_KIND.UPSERT,
    publicKey: roomKeyPair.publicKey,
    seq,
    userLimit: roomConfig.playerLimit || 8,
    currPlayers: currentPlayers,
    roomName: roomConfig.roomName || "Unnamed Room",
    hostName: roomConfig.hostName,
    hostPublicKey: userKeyPair.publicKey,
    hasPassword: !!roomConfig.passwordEnabled && !!String(roomConfig.password ?? "").trim(),
    language: roomConfig.language,
    version: APP_VERSION,
    signature: b4a.alloc(0)
  };

  roomState.signature = crypto.sign(
    null,
    encodeRoomForSignature(roomState),
    roomPrivateKey
  );

  const roomCode = bs58.encode(roomKeyPair.publicKey);

  knownRooms.set(roomCode, {
    room: roomState,
    receivedAt: Date.now()
  });

  sendRoomsToReact();
  
  console.log(`[HOST] Upgrading swarm status to SERVER on lobby topic...`);
  const topic = crypto.createHash('sha256').update('sculptio-game-lobby-v1').digest();

  if (!isLobbyServerJoined) {
    console.log(`[HOST] Joining lobby topic as SERVER...`);

    const discovery = swarm.join(topic, { client: true, server: true });
    await discovery.flushed();

    isLobbyServerJoined = true;

    console.log(`[HOST] Lobby server join flushed. The network can discover this room.`);
  }

  console.log(`[HOST] Broadcasting room gossip to ${activeGossipChannels.size} already-connected peers...`);
  activeGossipChannels.forEach(peerChannel => {
    try {
      peerChannel.send(roomState);
    } catch (err) {
      console.error(`[LOBBY] Failed to broadcast room gossip:`, err);
    }
  });
  
  return true;
};





export const stopAnnouncingRoom = async (seedHex: string, seq: number) => {
  if (!swarm || !isServerNode) return false;

  const { roomKeyPair, roomPrivateKey } = getRoomCrypto(seedHex);
  // const { userKeyPair } = getUserCrypto(seedHex);
  const roomCode = bs58.encode(roomKeyPair.publicKey);

const removeState = {
    kind: ROOM_GOSSIP_KIND.REMOVE,
    publicKey: roomKeyPair.publicKey,
    seq,
    userLimit: 0,
    currPlayers: 0,
    roomName: "",
    hostName: "",
    hostPublicKey: "",
    hasPassword: false,
    language: "",
    version: APP_VERSION,
    signature: b4a.alloc(0)
  };

  removeState.signature = crypto.sign(
    null,
    encodeRoomForSignature(removeState),
    roomPrivateKey
  );

  console.log(`[HOST] Broadcasting remove-room gossip: ${roomCode.substring(0, 8)}...`);

  knownRooms.delete(roomCode);
  sendRoomsToReact();

  activeGossipChannels.forEach(peerChannel => {
    try {
        peerChannel.send(removeState);
    } catch (err) {
        console.error(`[LOBBY] Failed to send remove-room gossip:`, err);
    }
  });

  // 1. Stop actively relaying gossip to peers
  isServerNode = false;
  isLobbyServerJoined = false;

  // 2. Step down from being a Server on the lobby topic
  const topic = crypto.createHash('sha256').update('sculptio-game-lobby-v1').digest();

  // Leave the topic completely to drop the server routing
  await swarm.leave(topic);

  // Immediately rejoin purely as a listening client
  swarm.join(topic, { client: true, server: false });

  return true;
};





export const kickPlayer = (pubKeyStr: string, reason: string = "You have been kicked by the host.") => {
  if (!swarm) return;
  console.log(`[HOST] Kicking player ${pubKeyStr.substring(0,8)}... Reason: ${reason}`);
  
  const peer = roomConnections.get(pubKeyStr);
  
  if (peer) {
    // 1. Send the polite warning message
    try {
      peer.systemNotice.send(reason);
    } catch (err) {
      console.error(`[HOST] Failed to send kick notice`, err);
    }

    // 2. Wait 200ms to ensure the message flushes over the network, then kill the socket
    setTimeout(() => {
      if (peer._conn) peer._conn.destroy(); // Sever the physical connection
      roomConnections.delete(pubKeyStr);    // Remove them from the active map
      
      // Tell the Host's React UI that the player disconnected
      sendRoomEventToReact('CLIENT_DISCONNECT', null, pubKeyStr);
    }, 200);
  }
};





export const disconnectAll = async () => {
    knownRooms.clear();
    activeGossipChannels.clear();
    roomConnections.clear();

    stopRoomPruneTimer();

    isServerNode = false;
    isLobbyServerJoined = false;
    roomServer = null;
    clientOutMsg = {};

    if (swarm) {
        console.log("Destroying Swarm and dropping all connections.");
        await swarm.destroy();
        swarm = null;
    }

    return true;
};