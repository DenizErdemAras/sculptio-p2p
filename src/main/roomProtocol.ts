// src/main/roomProtocol.ts
import c from 'compact-encoding';

// --- STATE ENUMS ---
export const ROOM_STATE = {
  WAITING_IN_LOBBY: 0,
  GAME_STARTING: 1,
  GAME_IN_PROGRESS: 2,
  GAME_OVER: 3
};

export const GAME_STATE = {
  WAITING_FOR_WORD: 0,      // Sculptor is picking a word
  SCULPTING: 1,             // Clock is ticking, people are guessing
  TURN_ENDED_TIME: 2,       // Time ran out
  TURN_ENDED_GUESSED: 3,    // Everyone guessed it
  TURN_ENDED_SKIP: 4,       // Sculptor skipped
  TURN_ENDED_DISCONNECT: 5  // Sculptor disconnected
};

// --- MESSAGE IDs ---
export const ROOM_MSG = {
  // Client -> Host
  CLIENT_JOIN_REQ: 0x10,    // c.string (Player Name)
  CLIENT_BRUSH_HISTORY_REQ: 0x11,    // c.uint32 (Ask for brush history starting at index N)
  CLIENT_CHAT: 0x12,        // c.string (The chat message)
  CLIENT_GUESS: 0x13,       // c.string (The guess attempt)
  CLIENT_WORD_PICK: 0x14,   // c.uint8 (Index of the chosen word: 0, 1, or 2)
  CLIENT_BRUSH: 0x15,       // brushSchema
  
  // Host -> Client
  HOST_SYNC_CONFIG: 0x20,   // configSchema
  HOST_SYNC_PLAYERS: 0x21,  // c.array(playerSchema)
  HOST_SYNC_STATE: 0x22,    // gameStateSchema
  HOST_CHAT_RELAY: 0x23,    // chatRelaySchema (Pubkey + String)
  HOST_BRUSH_RELAY: 0x24,   // brushSchema
  
  // NEW Host -> Client Flows
  HOST_WORD_CHOICES: 0x25,  // c.array(c.string) (Sends 3 options to sculptor)
  HOST_PLAYER_GUESS: 0x26,  // guessBroadcastSchema (Broadcasts guess/status to all)
  HOST_LOG: 0x27,           // c.string (System events: "Game Starting!")
  HOST_SYSTEM_NOTICE: 0x28,  // c.string (Graceful kicks: "Room Full", "Kicked")
  HOST_BRUSH_HISTORY_BATCH: 0x29
};





// 1. Room Configuration
export const configSchema = {
  preencode(state: any, m: any) {
    c.string.preencode(state, m.roomName);
    c.string.preencode(state, m.visibilityStatus);
    c.string.preencode(state, m.language);
    c.uint8.preencode(state, m.playerLimit);
    c.string.preencode(state, m.wordList);
    c.uint8.preencode(state, m.gameMode);
    c.uint8.preencode(state, m.turnDurationSeconds );
    c.uint8.preencode(state, m.wordPickDurationSeconds );
    c.uint8.preencode(state, m.totalRounds);
  },
  encode(state: any, m: any) {
    c.string.encode(state, m.roomName);
    c.string.encode(state, m.visibilityStatus);
    c.string.encode(state, m.language);   
    c.uint8.encode(state, m.playerLimit);
    c.string.encode(state, m.wordList);   
    c.uint8.encode(state, m.gameMode);
    c.uint8.encode(state, m.turnDurationSeconds );
    c.uint8.encode(state, m.wordPickDurationSeconds );
    c.uint8.encode(state, m.totalRounds);
  },
  decode(state: any) {
    return {
      roomName: c.string.decode(state),
      visibilityStatus: c.string.decode(state),
      language: c.string.decode(state),   
      playerLimit: c.uint8.decode(state),
      wordList: c.string.decode(state),   
      gameMode: c.uint8.decode(state),
      turnDurationSeconds: c.uint8.decode(state),
      wordPickDurationSeconds: c.uint8.decode(state),
      totalRounds: c.uint8.decode(state)
    };
  }
};

// 2. Individual Player (Modular piece)
export const playerSchema = {
  preencode(state: any, m: any) {
    c.uint8.preencode(state, m.id);          
    c.string.preencode(state, m.publicKey);
    c.string.preencode(state, m.name);       
    c.uint16.preencode(state, m.currentPoints);
    c.uint32.preencode(state, m.totalPoints);
    c.bool.preencode(state, m.hasGuessed);
  },
  encode(state: any, m: any) {
    c.uint8.encode(state, m.id);
    c.string.encode(state, m.publicKey);
    c.string.encode(state, m.name);
    c.uint16.encode(state, m.currentPoints);
    c.uint32.encode(state, m.totalPoints);
    c.bool.encode(state, m.hasGuessed);
  },
  decode(state: any) {
    return {
      id: c.uint8.decode(state),
      publicKey: c.string.decode(state),
      name: c.string.decode(state),
      currentPoints: c.uint16.decode(state),
      totalPoints: c.uint32.decode(state),
      hasGuessed: c.bool.decode(state)
    };
  }
};

// 3. Game State
export const gameStateSchema = {
  preencode(state: any, m: any) {
    c.uint8.preencode(state, m.roomState);
    c.uint8.preencode(state, m.gameState);
    c.uint8.preencode(state, m.roundNumber);
    c.string.preencode(state, m.sculptorPubKey); 
    c.uint16.preencode(state, m.duration);       
  },
  encode(state: any, m: any) {
    c.uint8.encode(state, m.roomState);
    c.uint8.encode(state, m.gameState);
    c.uint8.encode(state, m.roundNumber);
    c.string.encode(state, m.sculptorPubKey);
    c.uint16.encode(state, m.duration);
  },
  decode(state: any) {
    return {
      roomState: c.uint8.decode(state),
      gameState: c.uint8.decode(state),
      roundNumber: c.uint8.decode(state),
      sculptorPubKey: c.string.decode(state),
      duration: c.uint16.decode(state)
    };
  }
};




export const brushSchema = {
  preencode(state: any, m: any) {
    c.uint32.preencode(state, m.actionId ?? 0);

    c.string.preencode(state, m.brush ?? 'addBrush');
    c.string.preencode(state, m.mode ?? 'set');

    c.float32.preencode(state, m.offset?.[0] ?? 0);
    c.float32.preencode(state, m.offset?.[1] ?? 0);
    c.float32.preencode(state, m.offset?.[2] ?? 0);

    c.uint8.preencode(state, m.min ? 1 : 0);
    if (m.min) {
      c.float32.preencode(state, m.min[0]);
      c.float32.preencode(state, m.min[1]);
      c.float32.preencode(state, m.min[2]);
    }

    c.uint8.preencode(state, m.max ? 1 : 0);
    if (m.max) {
      c.float32.preencode(state, m.max[0]);
      c.float32.preencode(state, m.max[1]);
      c.float32.preencode(state, m.max[2]);
    }

    c.uint8.preencode(state, m.isoLevel !== undefined ? 1 : 0);
    if (m.isoLevel !== undefined) {
      c.float32.preencode(state, m.isoLevel);
    }

    const params = m.params ?? {};
    c.float32.preencode(state, params.strength ?? 0);
    c.float32.preencode(state, params.radius ?? 0);
    c.float32.preencode(state, params.falloff ?? 0);
  },

  encode(state: any, m: any) {
    c.uint32.encode(state, m.actionId ?? 0);

    c.string.encode(state, m.brush ?? 'addBrush');
    c.string.encode(state, m.mode ?? 'set');

    c.float32.encode(state, m.offset?.[0] ?? 0);
    c.float32.encode(state, m.offset?.[1] ?? 0);
    c.float32.encode(state, m.offset?.[2] ?? 0);

    c.uint8.encode(state, m.min ? 1 : 0);
    if (m.min) {
      c.float32.encode(state, m.min[0]);
      c.float32.encode(state, m.min[1]);
      c.float32.encode(state, m.min[2]);
    }

    c.uint8.encode(state, m.max ? 1 : 0);
    if (m.max) {
      c.float32.encode(state, m.max[0]);
      c.float32.encode(state, m.max[1]);
      c.float32.encode(state, m.max[2]);
    }

    c.uint8.encode(state, m.isoLevel !== undefined ? 1 : 0);
    if (m.isoLevel !== undefined) {
      c.float32.encode(state, m.isoLevel);
    }

    const params = m.params ?? {};
    c.float32.encode(state, params.strength ?? 0);
    c.float32.encode(state, params.radius ?? 0);
    c.float32.encode(state, params.falloff ?? 0);
  },

  decode(state: any) {
    const action: any = {
      actionId: c.uint32.decode(state),
      brush: c.string.decode(state),
      mode: c.string.decode(state),
      offset: [
        c.float32.decode(state),
        c.float32.decode(state),
        c.float32.decode(state)
      ],
    };

    const hasMin = c.uint8.decode(state) === 1;
    if (hasMin) {
      action.min = [
        c.float32.decode(state),
        c.float32.decode(state),
        c.float32.decode(state)
      ];
    }

    const hasMax = c.uint8.decode(state) === 1;
    if (hasMax) {
      action.max = [
        c.float32.decode(state),
        c.float32.decode(state),
        c.float32.decode(state)
      ];
    }

    const hasIsoLevel = c.uint8.decode(state) === 1;
    if (hasIsoLevel) {
      action.isoLevel = c.float32.decode(state);
    }

    action.params = {
      strength: c.float32.decode(state),
      radius: c.float32.decode(state),
      falloff: c.float32.decode(state)
    };

    return action;
  }
};





export const chatRelaySchema = {
  preencode(state: any, m: any) {
    c.string.preencode(state, m.publicKey);
    c.string.preencode(state, m.message);
    c.uint8.preencode(state, m.type ?? 0);
  },
  encode(state: any, m: any) {
    c.string.encode(state, m.publicKey);
    c.string.encode(state, m.message);
    c.uint8.encode(state, m.type ?? 0);
  },
  decode(state: any) {
    return {
      publicKey: c.string.decode(state),
      message: c.string.decode(state),
      type: c.uint8.decode(state)
    };
  }
};


export const gameLogSchema = {
  preencode(state: any, m: any) {
    c.string.preencode(state, m.message);
    c.uint8.preencode(state, m.type ?? 0);
  },
  encode(state: any, m: any) {
    c.string.encode(state, m.message);
    c.uint8.encode(state, m.type ?? 0);
  },
  decode(state: any) {
    return {
      message: c.string.decode(state),
      type: c.uint8.decode(state)
    };
  }
};






export const guessBroadcastSchema = {
  preencode(state: any, m: any) {
    c.string.preencode(state, m.publicKey); 
    c.uint8.preencode(state, m.status); 
    c.string.preencode(state, m.guess); 
  },
  encode(state: any, m: any) {
    c.string.encode(state, m.publicKey);
    c.uint8.encode(state, m.status);
    c.string.encode(state, m.guess);
  },
  decode(state: any) {
    return {
      publicKey: c.string.decode(state),
      status: c.uint8.decode(state),
      guess: c.string.decode(state)
    };
  }
};





export const joinReqSchema = {
  preencode(state: any, m: any) {
    c.string.preencode(state, m.name);
    c.string.preencode(state, m.password ?? "");
  },
  encode(state: any, m: any) {
    c.string.encode(state, m.name);
    c.string.encode(state, m.password ?? "");
  },
  decode(state: any) {
    return {
      name: c.string.decode(state),
      password: c.string.decode(state)
    };
  }
};