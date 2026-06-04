import { useEffect, useRef, useCallback } from 'react';

import EnglishWordList from '../utils/EnglishWordList.json';
import TurkishWordList from '../utils/TurkishWordList.json';

type WordDifficulty = 'easy' | 'medium' | 'hard';

type WordDatabase = Record<WordDifficulty, string[]>;

const WORD_LISTS = {
    english: EnglishWordList,
    turkish: TurkishWordList
} satisfies Record<string, WordDatabase>;

const GAME_MODE_TO_DIFFICULTY: Record<number, WordDifficulty> = {
    0: 'easy',
    1: 'medium',
    2: 'hard'
};

const getWordDatabaseForConfig = (config: any): WordDatabase => {
    const wordListId = String(config?.wordList ?? 'english');

    return WORD_LISTS[wordListId as keyof typeof WORD_LISTS] ?? EnglishWordList;
};

const getDifficultyForConfig = (config: any): WordDifficulty => {
    const gameMode = Number(config?.gameMode ?? 0);

    return GAME_MODE_TO_DIFFICULTY[gameMode] ?? 'easy';
};


// --- ENUMS & CONSTANTS ---
// You can also import these from a shared constants file if you prefer
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

const GAME_LOG_TYPE = {
  NORMAL: 0,
  GUESS: 1,
  CLOSE_GUESS: 2,
  CORRECT_GUESS: 3
} as const;

type GameLogType = typeof GAME_LOG_TYPE[keyof typeof GAME_LOG_TYPE];


const SCULPTOR_POINTS = 100;

const MAX_GUESS_POINTS = 160;
const MIN_GUESS_POINTS = 100;
const LOWER_BY = 20;



// const TURN_DURATION_SECONDS = 60;
// const PICK_WORD_DURATION_SECONDS = 15;

// --- HELPER: LEVENSHTEIN DISTANCE ---
const getLevenshteinDistance = (a: string, b: string): number => {
  const matrix = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  return matrix[a.length][b.length];
};


// --- HOOK INTERFACE ---
interface GameEngineProps {
  isHost: boolean;
  gamePhaseRef: React.MutableRefObject<any>;
  playersRef: React.MutableRefObject<any>;
  secretWordRef: React.MutableRefObject<string>;
  wordChoicesRef: React.MutableRefObject<string[]>;
  configRef: React.MutableRefObject<any>;
  setGamePhase: React.Dispatch<React.SetStateAction<any>>;
  setPlayers: React.Dispatch<React.SetStateAction<any>>;
  setSecretWord: React.Dispatch<React.SetStateAction<string>>;
  setWordChoices: React.Dispatch<React.SetStateAction<string[]>>;
  setBrushHistory: React.Dispatch<React.SetStateAction<any[]>>;
  addGameLog: (message: string, type?: GameLogType) => void;
  addRecentGuess: (payload: any) => void;
  broadcastToRoom: (type: string, payload: any) => void;
  sendToPlayer: (pubKey: string, type: string, payload: any) => void;
}

export const useGameEngine = ({
  isHost,
  gamePhaseRef,
  playersRef,
  secretWordRef,
  configRef,
  setGamePhase,
  setPlayers,
  setSecretWord,
  setWordChoices,
  setBrushHistory,
  addGameLog,
  addRecentGuess,
  broadcastToRoom,
  sendToPlayer
}: GameEngineProps) => {

  const getTurnDurationSeconds = () => {
    const value = Number(configRef.current?.turnDurationSeconds ?? 60);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 60;
  };

  const getWordPickDurationSeconds = () => {
    const value = Number(configRef.current?.wordPickDurationSeconds ?? 15);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 15;
  };

  // Engine-specific memory (Only the Host needs to remember these)
  const turnQueue = useRef<string[]>([]);
  const guessedCountRef = useRef<number>(0);
  
  const emitLog = useCallback((
    message: string,
    type: GameLogType = GAME_LOG_TYPE.NORMAL
  ) => {
    addGameLog(message, type);
    broadcastToRoom('log', { message, type });
  }, [addGameLog, broadcastToRoom]);

  const sendLogToPlayer = useCallback((
    targetPubKey: string,
    message: string,
    type: GameLogType = GAME_LOG_TYPE.NORMAL
  ) => {
    const hostPlayer = Object.values(playersRef.current).find((p: any) => p.id === 1) as any;

    if (hostPlayer?.publicKey === targetPubKey) {
      addGameLog(message, type);
      return;
    }

    sendToPlayer(targetPubKey, 'log', { message, type });
  }, [addGameLog, sendToPlayer]);

  const getHostPublicKey = () => {
    const hostPlayer = Object.values(playersRef.current).find((p: any) => p.id === 1) as any;
    return hostPlayer?.publicKey;
  };

  const sendGuessFeedbackToPlayer = useCallback((targetPubKey: string, payload: any) => {
    const hostPublicKey = getHostPublicKey();

    if (targetPubKey === hostPublicKey) {
      addRecentGuess(payload);
      return;
    }

    sendToPlayer(targetPubKey, 'playerGuess', payload);
  }, [addRecentGuess, sendToPlayer]);


  const addPlayerToTurnQueue = useCallback((pubKey: string) => {
    if (!isHost || !pubKey) return;

    const phase = gamePhaseRef.current;

    // Before the game starts, startGame() builds the queue from playersRef.
    // During the game, late joiners must be appended manually.
    if (phase.roomState !== ROOM_STATE.GAME_IN_PROGRESS) return;

    if (!turnQueue.current.includes(pubKey)) {
      turnQueue.current = [...turnQueue.current, pubKey];
      console.log(`[ENGINE] Added late joiner to turn queue: ${pubKey.substring(0, 8)}...`);
    }
  }, [isHost]);

  const removePlayerFromTurnQueue = useCallback((pubKey: string) => {
    if (!isHost || !pubKey) return;

    if (turnQueue.current.includes(pubKey)) {
      turnQueue.current = turnQueue.current.filter(k => k !== pubKey);
      console.log(`[ENGINE] Removed player from turn queue: ${pubKey.substring(0, 8)}...`);
    }
  }, [isHost]);

  const normalizeGuessText = (value: string) => {
    return String(value ?? '')
      .toLocaleLowerCase('tr-TR')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\p{L}\p{N}]/gu, '');
  };

  const getCloseGuessThreshold = (secretWord: string) => {
    const guidance = 0.05;
    const a = 1 / guidance;
    const n = Math.max(1, normalizeGuessText(secretWord).length);

    return ((n - a * a) / (n + a)) + a - 1.3;
  };

  const isCloseGuess = (guess: string, secretWord: string) => {
    const normalizedGuess = normalizeGuessText(guess);
    const normalizedSecret = normalizeGuessText(secretWord);

    if (!normalizedGuess || !normalizedSecret) return false;

    const distance = getLevenshteinDistance(normalizedGuess, normalizedSecret);
    const threshold = getCloseGuessThreshold(normalizedSecret);

    return distance < threshold;
  };


  // ==========================================
  // 1. THE GAME TICK ENGINE (THE CLOCK)
  // ==========================================
  useEffect(() => {
    // If you are a client, the engine remains completely dormant.
    if (!isHost) return;

    const tick = setInterval(() => {
      const phase = gamePhaseRef.current;
      
      // Only tick down if the game is actually running
      if (phase.roomState !== ROOM_STATE.GAME_IN_PROGRESS) return;

      // Do not tick if we are in a transition/end state
      if (phase.gameState >= GAME_STATE.TURN_ENDED_TIME) return;

      if (phase.duration > 1) {
        // Decrease time and broadcast to sync clients
        const newDuration = phase.duration - 1;
        const newState = { ...phase, duration: newDuration };
        setGamePhase(newState);
        broadcastToRoom('syncState', newState);
      } else {
        // --- TIME IS UP LOGIC ---
        if (phase.gameState === GAME_STATE.WAITING_FOR_WORD) {
          secretWordRef.current = "";
          setSecretWord("");

          emitLog(`Time's up! No word was selected. Turn skipped!`);
          endTurn(GAME_STATE.TURN_ENDED_SKIP);
        } else if (phase.gameState === GAME_STATE.SCULPTING) {
          endTurn(GAME_STATE.TURN_ENDED_TIME);
        }
      }
    }, 1000);

    return () => clearInterval(tick);
  }, [isHost]);


  // ==========================================
  // 2. TURN MANAGEMENT
  // ==========================================
  
  const startGame = useCallback(() => {
    if (!isHost) return;
    
    turnQueue.current = Object.keys(playersRef.current);
    const firstSculptor = turnQueue.current[0];

    // 1. Create the new state
    const newState = {
      ...gamePhaseRef.current,
      roomState: ROOM_STATE.GAME_IN_PROGRESS,
      roundNumber: 1,
      sculptorPubKey: firstSculptor
    };
    
    // 2. FORCIBLY update the ref so startTurn sees it immediately!
    gamePhaseRef.current = newState;
    setGamePhase(newState);
    
    // (We don't need to broadcast here, because startTurn will broadcast the final merged state)
    startTurn(firstSculptor);
  }, [isHost]);

  const startTurn = useCallback((sculptorPubKey: string) => {
    guessedCountRef.current = 0;
    setBrushHistory([]);
    
    const wordDatabase = getWordDatabaseForConfig(configRef.current);
    const difficulty = getDifficultyForConfig(configRef.current);
    const words = wordDatabase[difficulty];

    const shuffled = [...words].sort(() => 0.5 - Math.random());
    const choices = shuffled.slice(0, 3);
    
    setWordChoices(choices);

    const resetPlayers = { ...playersRef.current };
    Object.keys(resetPlayers).forEach(k => resetPlayers[k].hasGuessed = false);
    setPlayers(resetPlayers);
    broadcastToRoom('syncPlayers', Object.values(resetPlayers));

    const newState = { 
      ...gamePhaseRef.current, 
      gameState: GAME_STATE.WAITING_FOR_WORD, 
      sculptorPubKey, 
      duration: getWordPickDurationSeconds() 
    };
    
    // FORCIBLY update the ref again
    gamePhaseRef.current = newState;
    setGamePhase(newState);
    broadcastToRoom('syncState', newState);

    const sculptorName = resetPlayers[sculptorPubKey].name;
    emitLog(`Waiting for ${sculptorName} to pick a word...`);
    
    sendToPlayer(sculptorPubKey, 'wordChoices', choices);
  }, []);

  const forceStartSculpting = useCallback((chosenWord: string) => {
    setSecretWord(chosenWord);
    secretWordRef.current = chosenWord;

    const newState = { 
      ...gamePhaseRef.current, 
      gameState: GAME_STATE.SCULPTING, 
      duration: getTurnDurationSeconds() 
    };

    gamePhaseRef.current = newState;
    setGamePhase(newState);
    broadcastToRoom('syncState', newState);
    
    const sculptorName = playersRef.current[newState.sculptorPubKey].name;
    emitLog(`${sculptorName} is sculpting!`);
  }, []);

  const endGame = useCallback(() => {
    const newState = { ...gamePhaseRef.current, roomState: ROOM_STATE.GAME_OVER, duration: 0 };
    
    gamePhaseRef.current = newState;
    setGamePhase(newState);
    broadcastToRoom('syncState', newState);
    emitLog("Game Over! Look at the final scores.");
  }, []);

  const endTurn = useCallback((reasonGameState: number) => {
    const newState = { ...gamePhaseRef.current, gameState: reasonGameState, duration: 0 };
    const endedSculptor = newState.sculptorPubKey;
    
    gamePhaseRef.current = newState;
    setGamePhase(newState);
    broadcastToRoom('syncState', newState);
    
    if (secretWordRef.current) {
      emitLog(`The turn has ended! The word was: ${secretWordRef.current}`);
      broadcastToRoom('wordChoices', [secretWordRef.current]);
    } else {
      emitLog(`The turn has ended without a selected word.`);
      broadcastToRoom('wordChoices', []);
    }

    setTimeout(() => {
      let queue = [...turnQueue.current];
      let currentIndex = queue.indexOf(endedSculptor);

      // If the sculptor disconnected, remove them from future turns.
      // Preserve their old index so the next player after them can continue.
      if (reasonGameState === GAME_STATE.TURN_ENDED_DISCONNECT && endedSculptor) {
        if (currentIndex === -1) currentIndex = 0;
        queue = queue.filter(k => k !== endedSculptor);
        turnQueue.current = queue;
      }

      if (queue.length === 0) {
        endGame();
        return;
      }

      const nextIndex =
        reasonGameState === GAME_STATE.TURN_ENDED_DISCONNECT
          ? currentIndex
          : currentIndex + 1;

      if (nextIndex >= queue.length || currentIndex === -1) {
        const currentRound = newState.roundNumber;
        const maxRounds = configRef.current.totalRounds;

        if (currentRound >= maxRounds) {
          endGame();
        } else {
          const nextRoundState = { ...newState, roundNumber: currentRound + 1 };
          gamePhaseRef.current = nextRoundState;
          setGamePhase(nextRoundState);
          broadcastToRoom('syncState', nextRoundState);
          emitLog(`Starting Round ${currentRound + 1}!`);
          
          startTurn(queue[0]);
        }
      } else {
        startTurn(queue[nextIndex]);
      }
    }, 5000);
  }, [broadcastToRoom, emitLog, endGame, startTurn]);


  // ==========================================
  // 3. GUESS MATH & LOGIC
  // ==========================================
  
  const processGuess = useCallback((guesserPubKey: string, guess: string) => {
    const currentWord = secretWordRef.current;
    const normalizedWord = normalizeGuessText(currentWord);
    const normalizedGuess = normalizeGuessText(guess);
    const cleanGuess = String(guess ?? '').trim();
    const sculptor = gamePhaseRef.current.sculptorPubKey;

    // Sculptors can't guess, and you can't guess twice
    if (guesserPubKey === sculptor) return;
    if (playersRef.current[guesserPubKey]?.hasGuessed) return;

    if (normalizedGuess === normalizedWord) {
      // --- CORRECT GUESS ---
      guessedCountRef.current += 1;
      
      // Math: You get fewer points the later you guess it
      const points = Math.max(MIN_GUESS_POINTS, MAX_GUESS_POINTS - (LOWER_BY * (guessedCountRef.current - 1)))
      
      setPlayers((prev: any) => {
        const updated = { ...prev };
        updated[guesserPubKey].currentPoints += Math.max(10, points);
        updated[guesserPubKey].totalPoints += Math.max(10, points);
        updated[guesserPubKey].hasGuessed = true;
        
        updated[sculptor].currentPoints += SCULPTOR_POINTS;
        updated[sculptor].totalPoints += SCULPTOR_POINTS;

        playersRef.current = updated;
        
        broadcastToRoom('syncPlayers', Object.values(updated));
        return updated;
      });

      sendGuessFeedbackToPlayer(guesserPubKey, {
        publicKey: guesserPubKey,
        status: 2,
        guess: guess
      });

      sendLogToPlayer(guesserPubKey, `'${guess}' is correct`, GAME_LOG_TYPE.CORRECT_GUESS);
      emitLog(`${playersRef.current[guesserPubKey].name} guessed the word`, GAME_LOG_TYPE.CORRECT_GUESS);

      // Check if everyone has guessed
      const totalGuessers = Object.keys(playersRef.current).length - 1;
      if (guessedCountRef.current >= totalGuessers) {
        endTurn(GAME_STATE.TURN_ENDED_GUESSED);
      }

    } else if (isCloseGuess(cleanGuess, currentWord)) {
      sendGuessFeedbackToPlayer(guesserPubKey, {
        publicKey: guesserPubKey,
        status: 1,
        guess: guess
      });

      // emitLog(`${playersRef.current[guesserPubKey].name} is very close to guessing`, GAME_LOG_TYPE.CLOSE_GUESS);
      sendLogToPlayer(guesserPubKey, `'${guess}' is very close`, GAME_LOG_TYPE.CLOSE_GUESS);
      
    } else {
      const guesserName = playersRef.current[guesserPubKey]?.name ?? 'Someone';

      sendGuessFeedbackToPlayer(guesserPubKey, {
        publicKey: guesserPubKey,
        status: 0,
        guess: guess
      });

      emitLog(`${guesserName} guessed: ${guess}`, GAME_LOG_TYPE.GUESS);
    }
  }, []);

  // Expose the triggers back to GameContext
  return {
    startGame,
    startTurn,
    forceStartSculpting,
    processGuess,
    endTurn,
    endGame,
    addPlayerToTurnQueue,
    removePlayerFromTurnQueue
  };
};