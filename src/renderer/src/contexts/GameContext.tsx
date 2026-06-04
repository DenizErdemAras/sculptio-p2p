import React, { createContext, useState, useContext, useEffect, useRef } from 'react';
import { NetworkContext } from './NetworkContext';
import { UserContext } from './UserContext';
import { UIContext } from './UIContext'
import { useGameEngine } from '@renderer/hooks/useGameEngine';

// --- ENUMS & CONSTANTS (Must match roomProtocol.ts) ---
const ROOM_REFRESH_MS = 10_000;

export const ROOM_STATE = {
  WAITING_IN_LOBBY: 0,
  GAME_STARTING: 1,
  GAME_IN_PROGRESS: 2,
  GAME_OVER: 3
};

export const GAME_STATE = {
  WAITING_FOR_WORD: 0,
  SCULPTING: 1,
  TURN_ENDED_TIME: 2,
  TURN_ENDED_GUESSED: 3,
  TURN_ENDED_SKIP: 4,
  TURN_ENDED_DISCONNECT: 5
};

export const CHAT_MESSAGE_TYPE = {
    NORMAL: 0,
    SYSTEM: 1,
    GUESSED: 2
} as const;

export const GAME_LOG_TYPE = {
  NORMAL: 0,
  GUESS: 1,
  CLOSE_GUESS: 2,
  CORRECT_GUESS: 3
} as const;

export type GameLogType = typeof GAME_LOG_TYPE[keyof typeof GAME_LOG_TYPE];

export const GameContext = createContext<any>(null);

export const GameProvider = ({ children }: { children: React.ReactNode }) => {
  const {
    isHost,
    roomConfig,
    announceRoomState,
    stopAnnouncingRoom,
    createAndHostRoom,
    sendToServer,
    sendToPlayer,
    broadcastToRoom,
    blockPublicKey
  } = useContext(NetworkContext);
  const { userData } = useContext(UserContext);
  const ui = useContext(UIContext);

  const [config, setConfig] = useState<any>({});
  const [players, setPlayers] = useState<Record<string, any>>({});
  const [gamePhase, setGamePhase] = useState({
    roomState: ROOM_STATE.WAITING_IN_LOBBY,
    gameState: GAME_STATE.WAITING_FOR_WORD,
    roundNumber: 0,
    sculptorPubKey: "",
    duration: 0
  });
  
  const [chatMessages, setChatMessages] = useState<any[]>([]);
  const [gameLogs, setGameLogs] = useState<any[]>([]);
  
  // Private UI States (Only used if you are Host or Sculptor)
  const [secretWord, setSecretWord] = useState(""); 
  const [wordChoices, setWordChoices] = useState<string[]>([]);

  // --- REFS FOR HOST LOGIC (To bypass stale React closures) ---
  const playersRef = useRef(players);
  const gamePhaseRef = useRef(gamePhase);
  const secretWordRef = useRef(secretWord);
  
  const configRef = useRef(config);
  const wordChoicesRef = useRef(wordChoices);
  
  const brushHistoryRef = useRef<any[]>([]);

  const hasRequestedBrushHistoryRef = useRef(false);

  const [recentGuesses, setRecentGuesses] = useState<any[]>([]);

  // Keep refs perfectly synced with state
  useEffect(() => { playersRef.current = players; }, [players]);
  useEffect(() => { gamePhaseRef.current = gamePhase; }, [gamePhase]);
  useEffect(() => { secretWordRef.current = secretWord; }, [secretWord]);
  useEffect(() => { configRef.current = config; }, [config]);
  useEffect(() => { wordChoicesRef.current = wordChoices; }, [wordChoices]);

  useEffect(() => {
    if (!isHost) return;
    if (config.visibilityStatus !== 'public') return;

    const interval = setInterval(() => {
        announceRoomState(configRef.current);
    }, ROOM_REFRESH_MS);

    return () => clearInterval(interval);
  }, [isHost, config.visibilityStatus]);

  const makeGameLog = (
    message: string,
    type: GameLogType = GAME_LOG_TYPE.NORMAL
  ) => {
    return { message, type };
  };

  const addGameLog = (
    message: string,
    type: GameLogType = GAME_LOG_TYPE.NORMAL
  ) => {
    setGameLogs(prev => [...prev, makeGameLog(message, type)]);
  };
  
  const addRecentGuess = (payload: any) => {
    setRecentGuesses(prev => [
      ...prev.slice(-3),
      payload
    ]);
  };

  const engine = useGameEngine({
    isHost,
    gamePhaseRef,
    playersRef,
    secretWordRef,
    wordChoicesRef,
    configRef,
    setGamePhase,
    setPlayers,
    setSecretWord,
    setWordChoices,
    setBrushHistory: () => { brushHistoryRef.current = []; },
    addGameLog,
    addRecentGuess,
    broadcastToRoom,
    sendToPlayer
  });

  // --- HOST ROOM CONFIG INITIALIZATION ---
  // Only run when a new hosted roomConfig object is created.
  // Do not depend on userData, because moderation preference updates also change userData.
  useEffect(() => {
    if (!isHost || !roomConfig) return;

    setConfig(roomConfig);
    configRef.current = roomConfig;
  }, [isHost, roomConfig]);

  // --- HOST PLAYER INITIALIZATION ---
  // Only depends on stable user identity fields, not the whole userData object.
  useEffect(() => {
    if (!isHost || !userData?.publicKey) return;

    setPlayers(prev => {
      if (prev[userData.publicKey]) return prev;

      return {
        ...prev,
        [userData.publicKey]: {
          id: 1,
          publicKey: userData.publicKey,
          name: userData.username || 'Host',
          currentPoints: 0,
          totalPoints: 0,
          hasGuessed: false
        }
      };
    });
  }, [isHost, userData?.publicKey, userData?.username]);

  useEffect(() => {
    if (gamePhase.roomState !== ROOM_STATE.GAME_IN_PROGRESS) return;
    if (gamePhase.gameState !== GAME_STATE.WAITING_FOR_WORD) return;

    setRecentGuesses([]); // Clear recent guesses at the start of each round
  }, [ gamePhase.roomState, gamePhase.gameState, gamePhase.roundNumber, gamePhase.sculptorPubKey ]);


  const roomRequiresPassword = () => {
    return !!configRef.current.passwordEnabled &&
      String(configRef.current.password ?? "").trim().length > 0;
  };

  const isJoinPasswordValid = (password: string) => {
    if (!roomRequiresPassword()) return true;

    return String(password ?? "") === String(configRef.current.password ?? "");
  };

  // --- EVENT FUNNEL ---
  useEffect(() => {
    if (!window.api) return;

    const removeListener = window.api.onRoomEvent((event) => {
      const { type, payload, pubKey } = event;
      console.log('[ROOM EVENT]', event.type, event.payload);

      if (type.startsWith('CLIENT_') && !pubKey) {
        console.warn(`[ROOM EVENT] Ignoring ${type}: missing pubKey`);
        return;
      }

      if (isHost) {
        switch (type) {
          case 'CLIENT_JOIN_REQ': {
            const playerKey = pubKey as string;

            if (!isJoinPasswordValid(payload.password)) {
              console.log(`[HOST] Rejected join from ${playerKey.substring(0, 8)}: invalid room password.`);

              denyPassword(playerKey);
              break;
            }

            // Using the mathematically proven pubKey from the network connection
            const newPlayer = {
              id: Object.keys(playersRef.current).length + 1,
              publicKey: playerKey,
              name: payload.name || "Player",
              currentPoints: 0,
              totalPoints: 0,
              hasGuessed: false
            };
            
            setPlayers(prev => {
              const playerKey = pubKey as string;
              const alreadyExisted = !!prev[playerKey];

              const updated = { ...prev, [playerKey]: newPlayer };

              if (!alreadyExisted) {
                engine.addPlayerToTurnQueue(playerKey);
              }
              
              setTimeout(() => {
                const safeConfig = {
                  roomName: configRef.current.roomName,
                  language: configRef.current.language,
                  playerLimit: configRef.current.playerLimit,
                  wordList: configRef.current.wordList,
                  gameMode: configRef.current.gameMode,
                  totalRounds: configRef.current.totalRounds,
                  turnDurationSeconds: configRef.current.turnDurationSeconds,
                  wordPickDurationSeconds: configRef.current.wordPickDurationSeconds,
                  visibilityStatus: configRef.current.visibilityStatus,
                  hasPassword: roomRequiresPassword()
                };

                sendToPlayer(playerKey, 'syncConfig', safeConfig);
                sendToPlayer(playerKey, 'syncState', gamePhaseRef.current);
                broadcastToRoom('syncPlayers', Object.values(updated));
                announcePublicRoomNow(safeConfig);
              }, 100);
              
              return updated;
            });
            break;
          }

          case 'CLIENT_DISCONNECT':
            {
              const playerKey = pubKey as string;
              const phase = gamePhaseRef.current;

              const isCurrentSculptor = phase.sculptorPubKey === playerKey;
              const isActiveTurnState =
                phase.roomState === ROOM_STATE.GAME_IN_PROGRESS &&
                phase.gameState < GAME_STATE.TURN_ENDED_TIME;

              if (isCurrentSculptor && isActiveTurnState) {
                engine.endTurn(GAME_STATE.TURN_ENDED_DISCONNECT);
              } else {
                engine.removePlayerFromTurnQueue(playerKey);
              }

              setPlayers(prev => {
                const updated = { ...prev };
                delete updated[playerKey];
                broadcastToRoom('syncPlayers', Object.values(updated));
                announcePublicRoomNow(configRef.current);
                return updated;
              });

              break;
            }

          case 'CLIENT_CHAT':
            handleIncomingChat(pubKey as string, payload);
            break;

          case 'CLIENT_BRUSH':
            brushHistoryRef.current.push(payload);
            break;

          case 'CLIENT_GUESS':
            engine.processGuess(pubKey as string, payload);
            break;

          case 'CLIENT_WORD_PICK':
            const chosenWord = wordChoicesRef.current[payload]; 
            engine.forceStartSculpting(chosenWord);
            break;

          case 'CLIENT_BRUSH_HISTORY_REQ': {
            const startIndex = Math.max(0, Number(payload) || 0);
            const missingStrokes = brushHistoryRef.current.slice(startIndex);

            sendToPlayer(
                pubKey as string,
                'brushHistoryBatch',
                missingStrokes
            );
            break;
          }
        }
      }

      // 2. CLIENT (AND HOST) LOGIC - Updating the UI from Host Broadcasts
      switch (type) {
        case 'HOST_SYNC_CONFIG':
          setConfig(payload);
          break;
        case 'HOST_SYNC_PLAYERS':
          const newPlayers: Record<string, any> = {};
          payload.forEach((p: any) => newPlayers[p.publicKey] = p);
          setPlayers(newPlayers);
          break;
        case 'HOST_SYNC_STATE':
          setGamePhase(payload);

          if (payload.gameState === GAME_STATE.WAITING_FOR_WORD) {
            brushHistoryRef.current = [];
            hasRequestedBrushHistoryRef.current = false;
            // setRecentGuesses([]);
            // recent guess clearing is done with useEffect now
          }
          break;
        case 'HOST_CHAT_RELAY':
          setChatMessages(prev => [
              ...prev,
              makeChatMessage(
                  payload.publicKey,
                  payload.message,
                  payload.type ?? (
                      payload.publicKey === "0"
                          ? CHAT_MESSAGE_TYPE.SYSTEM
                          : CHAT_MESSAGE_TYPE.NORMAL
                  )
              )
          ]);
          break;
        case 'HOST_BRUSH_RELAY':
          break;
        case 'HOST_PLAYER_GUESS':
          addRecentGuess(payload);
          break;
        case 'HOST_LOG':
          setGameLogs(prev => [
            ...prev,
            typeof payload === 'string'
              ? makeGameLog(payload, GAME_LOG_TYPE.NORMAL)
              : makeGameLog(payload.message, payload.type ?? GAME_LOG_TYPE.NORMAL)
          ]);
          break;
        case 'HOST_WORD_CHOICES':
          // A single word means reveal. Three words means sculptor choices.
          if (payload.length === 1) {
            setSecretWord(payload[0]);
          } else {
            setSecretWord("");
            setWordChoices(payload);
          }
          break;
        case 'HOST_SYSTEM_NOTICE':
          ui?.alert('Notice', String(payload ?? ''));
          break;
        case 'HOST_DISCONNECTED':
          setPlayers({});
          setChatMessages([]);
          setGameLogs([]);
          setRecentGuesses([]);
          brushHistoryRef.current = [];
          setSecretWord("");
          setWordChoices([]);
          setGamePhase({
            roomState: ROOM_STATE.WAITING_IN_LOBBY,
            gameState: GAME_STATE.WAITING_FOR_WORD,
            roundNumber: 0,
            sculptorPubKey: "",
            duration: 0
          });
          break;
      }
    });

    return () => removeListener();
  }, [isHost]);

  const toggleRoomVisibility = async (makePublic: boolean) => {
    if (!isHost) return;

    const changingConfig = { ...config, visibilityStatus: 'changing' };
    setConfig(changingConfig);
    broadcastToRoom('syncConfig', changingConfig);

    try {
    if (makePublic) {
      const publicConfig = { ...changingConfig, visibilityStatus: 'public' };
      await announceRoomState(publicConfig);
      setConfig(publicConfig);
      broadcastToRoom('syncConfig', publicConfig);
    } else {
      await stopAnnouncingRoom();
      const privateConfig = { ...changingConfig, visibilityStatus: 'private' };
      setConfig(privateConfig);
      broadcastToRoom('syncConfig', privateConfig);
    }
  } catch (err) {
      const revertConfig = { ...changingConfig, visibilityStatus: 'private' };
      setConfig(revertConfig);
      broadcastToRoom('syncConfig', revertConfig);
    }
  };

  const startNewHostedRoom = async (initialConfig: any) => {
    setRecentGuesses([]);
    setPlayers({});
    setChatMessages([]);
    setGameLogs([]);
    brushHistoryRef.current = [];
    setGamePhase({
      roomState: ROOM_STATE.WAITING_IN_LOBBY,
      gameState: GAME_STATE.WAITING_FOR_WORD,
      roundNumber: 0,
      sculptorPubKey: "",
      duration: 0
    });

    await createAndHostRoom(initialConfig);
  };

  const updateRoomConfig = async (newConfig: any) => {
    if (!isHost) return;

    setConfig({ ...newConfig, visibilityStatus: configRef.current.visibilityStatus });
    configRef.current = newConfig;

    broadcastToRoom('syncConfig', newConfig);

    if (window.api.updateRoomConfig) {
      window.api.updateRoomConfig(newConfig);
    }

    await announcePublicRoomNow(newConfig);
  };

  const kickPlayer = (pubKey: string) => {
    if (!isHost) return;
    window.api.kickPlayer(pubKey, 'You have been kicked by the host.');
  };

  const denyPassword = (pubKey: string) => {
    if (!isHost) return;
    window.api.kickPlayer(pubKey, 'Wrong password.');
  };

  const kickAndBlockPlayer = async (pubKey: string) => {
    if (!isHost) return;

    await blockPublicKey(pubKey);
    window.api.kickPlayer(pubKey, 'You have been blocked by the host.');
  };

  const normalizeGuessText = (value: string) => {
    return String(value ?? '')
      .toLocaleLowerCase('tr-TR')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\p{L}\p{N}]/gu, '');
  };

  const levenshteinDistance = (a: string, b: string) => {
    const m = a.length;
    const n = b.length;

    if (m === 0) return n;
    if (n === 0) return m;

    const prev = new Array(n + 1);
    const curr = new Array(n + 1);

    for (let j = 0; j <= n; j++) {
      prev[j] = j;
    }

    for (let i = 1; i <= m; i++) {
      curr[0] = i;

      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;

        curr[j] = Math.min(
            prev[j] + 1,       // deletion
            curr[j - 1] + 1,   // insertion
            prev[j - 1] + cost // substitution
        );
      }

      for (let j = 0; j <= n; j++) {
        prev[j] = curr[j];
      }
    }

    return prev[n];
  };

  const getSpoilerDistanceThreshold = (secretWord: string) => {
    const n = Math.max(1, secretWord.length);
    if (n <= 2) return 1;
    return 4 * Math.log10(n / 1.9) + 0.7;
  };

  const containsSpoiler = (message: string, secretWord: string) => {
    const normalizedSecret = normalizeGuessText(secretWord);
    const normalizedMessage = normalizeGuessText(message);

    if (!normalizedSecret) return false;
    if (!normalizedMessage) return false;

    const windowSize = normalizedSecret.length;
    const threshold = getSpoilerDistanceThreshold(secretWord);

    if (normalizedMessage.length < windowSize) {
      return levenshteinDistance(normalizedMessage, normalizedSecret) < threshold;
    }

    for (let i = 0; i <= normalizedMessage.length - windowSize; i++) {
      const segment = normalizedMessage.slice(i, i + windowSize);
      const distance = levenshteinDistance(segment, normalizedSecret);

      if (distance < threshold) {
          return true;
      }
    }

    return false;
  };

const makeChatMessage = (
    publicKey: string,
    message: string,
    type?: number
) => {
    if (!type) type = CHAT_MESSAGE_TYPE.NORMAL;
    
    return {
        sender: publicKey,
        text: message,
        type: type
    };
};

const isPlayerInGuessedChat = (publicKey: string) => {
    const phase = gamePhaseRef.current;
    const player = playersRef.current[publicKey];

    return !!player?.hasGuessed || publicKey === phase?.sculptorPubKey;
};

const sendPrivateChatMessage = (
    targetPublicKey: string,
    publicKey: string,
    message: string,
    type?: number
) => {
    if (!type) type = CHAT_MESSAGE_TYPE.NORMAL;

    const payload = {
        publicKey,
        message,
        type
    };

    if (targetPublicKey === userData?.publicKey) {
        setChatMessages(prev => [
            ...prev,
            makeChatMessage(publicKey, message, type)
        ]);

        return;
    }

    sendToPlayer(targetPublicKey, 'chatRelay', payload);
};

const sendPrivateSystemChat = (targetPublicKey: string, message: string) => {
  sendPrivateChatMessage(
    targetPublicKey,
    "0",
    message,
    CHAT_MESSAGE_TYPE.SYSTEM
  );
};

const broadcastGuessedChat = (senderPublicKey: string, message: string) => {
    const payload = {
        publicKey: senderPublicKey,
        message,
        type: CHAT_MESSAGE_TYPE.GUESSED
    };

    Object.values(playersRef.current).forEach((player: any) => {
        const targetPublicKey = player.publicKey;

        if (!isPlayerInGuessedChat(targetPublicKey)) return;

        if (targetPublicKey === userData?.publicKey) {
            setChatMessages(prev => [
                ...prev,
                makeChatMessage(senderPublicKey, message, CHAT_MESSAGE_TYPE.GUESSED)
            ]);

            return;
        }

        sendToPlayer(targetPublicKey, 'chatRelay', payload);
    });
};

  // --- CLIENT ACTIONS (Called by UI Buttons) ---

  const handleIncomingChat = (publicKey: string, message: string) => {
    const cleanMessage = String(message ?? '').trim();
    if (!cleanMessage) return;

    const phase = gamePhaseRef.current;
    const currentSecretWord = secretWordRef.current;
    const senderPlayer = playersRef.current[publicKey];

    const isGameActive =
        phase?.roomState === ROOM_STATE.GAME_IN_PROGRESS &&
        phase?.gameState === GAME_STATE.SCULPTING;

    const senderHasGuessed = !!senderPlayer?.hasGuessed;

    // Players who already guessed get a separate safe chat channel.
    // No spoiler filtering needed there because the recipients already know the word.
    if (isHost && isGameActive && senderHasGuessed) {
        broadcastGuessedChat(publicKey, cleanMessage);
        return;
    }

    // Spoiler filtering applies to everyone else, including the sculptor.
    // The sculptor also must not be able to type the answer into public chat.
    if (
        isHost &&
        isGameActive &&
        currentSecretWord &&
        containsSpoiler(cleanMessage, currentSecretWord)
    ) {
        sendPrivateSystemChat(
            publicKey,
            "Your message was blocked because it includes a section that is too close to the secret word."
        );

        return;
    }

    const payload = {
        publicKey,
        message: cleanMessage,
        type: CHAT_MESSAGE_TYPE.NORMAL
    };

    setChatMessages(prev => [
        ...prev,
        makeChatMessage(publicKey, cleanMessage, CHAT_MESSAGE_TYPE.NORMAL)
    ]);

    if (isHost) {
        broadcastToRoom('chatRelay', payload);
    }
};

  const sendChatMessage = (message: string) => {
    const cleanMessage = String(message ?? '').trim();
    if (!cleanMessage) return;

    if (isHost) {
      handleIncomingChat(userData.publicKey, cleanMessage);
      return;
    }

    sendToServer('CLIENT_CHAT', cleanMessage);
  };

  const sendGuess = (text: string) => {
    if (isHost) {
      engine.processGuess(userData?.publicKey as string, text);
    } else {
      sendToServer('CLIENT_GUESS', text);
    }
  };

  const sendWordChoice = (index: number) => {
    const pickedWord = wordChoices[index];

    if (isHost) {
      engine.forceStartSculpting(wordChoices[index]);
    } else {
      setSecretWord(pickedWord);
      sendToServer('CLIENT_WORD_PICK', index);
    }
  };

  const sendBrushAction = (action: any) => {
    if (isHost) {
      // 🔥 SILENTLY PUSH & BROADCAST
      brushHistoryRef.current.push(action);
      broadcastToRoom('brushRelay', action);
    } else {
      sendToServer('CLIENT_BRUSH', action);
    }
  };

  const requestBrushHistory = (startIndex = 0) => {
    if (isHost) return;
    sendToServer('CLIENT_BRUSH_HISTORY_REQ', startIndex);
  };

  const returnToRoom = () => {
    if (!isHost) return;

    const newState = {
      roomState: ROOM_STATE.WAITING_IN_LOBBY,
      gameState: GAME_STATE.WAITING_FOR_WORD,
      roundNumber: 0,
      sculptorPubKey: "",
      duration: 0
    };

    brushHistoryRef.current = [];
    setRecentGuesses([]);
    setSecretWord("");
    setWordChoices([]);

    setPlayers(prev => {
      const updated = { ...prev };

      Object.keys(updated).forEach(key => {
        updated[key] = {
          ...updated[key],
          currentPoints: 0,
          hasGuessed: false
        };
      });

      broadcastToRoom('syncPlayers', Object.values(updated));
      return updated;
    });

    gamePhaseRef.current = newState;
    setGamePhase(newState);
    broadcastToRoom('syncState', newState);
    broadcastToRoom('wordChoices', []);
  };

  const announcePublicRoomNow = async (freshConfig = configRef.current) => {
    if (!isHost) return;
    if (freshConfig.visibilityStatus !== 'public') return;

    try {
      await announceRoomState(freshConfig);
    } catch (err) {
      console.error('[ROOM] Failed to announce immediate room update:', err);
    }
  };

  return (
    <GameContext.Provider value={{
      config,
      startNewHostedRoom,
      toggleRoomVisibility,
      players,
      kickPlayer,
      kickAndBlockPlayer,
      gamePhase,
      updateRoomConfig,
      chatMessages,
      gameLogs,
      isHost,
      recentGuesses,
      secretWord,
      wordChoices,
      
      // Host Functions routed to Engine
      startGame: engine.startGame,
      endGame: engine.endGame,
      returnToRoom,
      
      // Universal Functions
      sendChatMessage,
      sendGuess,
      sendWordChoice,
      sendBrushAction,
      requestBrushHistory
    }}>
      {children}
    </GameContext.Provider>
  );
};