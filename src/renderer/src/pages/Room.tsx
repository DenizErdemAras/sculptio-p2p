// src/renderer/src/pages/Room.tsx
import { useContext, useState, useEffect, useRef  } from 'react';
import { NetworkContext } from '../contexts/NetworkContext';
import { GameContext, ROOM_STATE, GAME_STATE, CHAT_MESSAGE_TYPE, GAME_LOG_TYPE } from '../contexts/GameContext';
import { UIContext } from '../contexts/UIContext';
import { UserContext } from '../contexts/UserContext';
import RoomConfigurator from '../components/RoomConfigurator';
import '../assets/Room.css';
import { LogOut, Settings, DoorOpen, DoorClosed, DoorClosedLocked, SendHorizontal, LoaderCircle, Crown  } from 'lucide-react';
import ScrollableList from '../components/ScrollableList'
import Sculptor, { type SculptorHandle } from '../components/Sculptor';






function PlayerCard({ player, showHostControls, isHost }: { player: any, showHostControls: boolean, isHost: boolean }) {
  const [ expanded, setExpanded ] = useState(false);
  const { kickPlayer } = useContext(GameContext);

  return (
    <div className={`player-card card flex-column gap-2 ${expanded ? 'expanded' : ''} ${isHost ? 'host' : ''}`} onClick={() => setExpanded(!expanded)} style={{ '--name-length': player.name.length } as React.CSSProperties}>
      <div className='flex-row gap-6'>
        <div className='player-avatar centered'>{player.name.charAt(0).toUpperCase()}</div>
        <div className='player-info-main'>
          <div className='player-name'><span className='player-name-text'>{player.name} {isHost && <span className='small grey-text fw-400'>(Host)</span>}</span></div>
          <span className='player-points'>Points: {player.currentPoints}</span>
        </div>
        {showHostControls && !isHost && <div className='player-info-buttons'>
          <button className='ghost pad-4 rotate-180'><LogOut /></button> {/* normally visible, hidden when player-list:hover */}
          <button 
              className='red pad-4 rotate-180' 
              onClick={(e) => {
                e.stopPropagation(); // Prevent the card from toggling 'expanded'
                kickPlayer(player.publicKey);
              }}
            >
              <LogOut />
            </button> {/* normally hidden, visible when player-list:hover */}
        </div>}
      </div>
      {expanded && <span className='player-id' onClick={(e) => {e.stopPropagation()}}>ID: {player.publicKey}</span>}
    </div>
  )
}




function MessageCard({ sender, message, messageType = CHAT_MESSAGE_TYPE.NORMAL, cardType }: { sender?: string, message: string, messageType: number, cardType: string }) {
  let messageClassName = '';

  if (cardType == 'log') {
    messageClassName = `${messageType === GAME_LOG_TYPE.GUESS ? 'guess-log' : messageType === GAME_LOG_TYPE.CLOSE_GUESS ? 'close-guess-log' : messageType === GAME_LOG_TYPE.CORRECT_GUESS ? 'correct-guess-log' : ''}`;
  } else {
    messageClassName = `${messageType === CHAT_MESSAGE_TYPE.SYSTEM ? 'system-message' : messageType === CHAT_MESSAGE_TYPE.GUESSED ? 'guessed-message' : ''}`;
  }

  return (
    <div className={`message-card card gap-6 ${messageClassName} `}>
      {sender && <span className='message-sender'>{sender}: </span>}<span style={{width: '6px' }} /><span className='message-content'>{message}</span>
    </div>
  )
}













export default function Room() {
  const ui = useContext(UIContext);
  if (!ui) return;

  const { 
    config, players, gamePhase,
    chatMessages, gameLogs, sendChatMessage, recentGuesses,
    toggleRoomVisibility, isHost,
    startGame,
    returnToRoom,
    secretWord,
    wordChoices,
    sendWordChoice,
    sendGuess,
    sendBrushAction,
    requestBrushHistory
  } = useContext(GameContext);

  const { userData } = useContext(UserContext);

  const {
    roomCode,
    disconnectFromNetwork,
    remoteBrushAction,
    remoteBrushActionSeq,
    remoteBrushHistoryBatch,
    remoteBrushHistoryBatchSeq
  } = useContext(NetworkContext);

  const sculptorRef = useRef<SculptorHandle | null>(null);
  const lastResetTurnKeyRef = useRef<string>('');

  useEffect(() => {
    if (gamePhase.roomState !== ROOM_STATE.GAME_IN_PROGRESS) return;
    if (gamePhase.gameState !== GAME_STATE.WAITING_FOR_WORD) return;
    if (!gamePhase.sculptorPubKey) return;

    const turnKey = `${gamePhase.roundNumber}:${gamePhase.sculptorPubKey}`;

    if (lastResetTurnKeyRef.current === turnKey) return;
    lastResetTurnKeyRef.current = turnKey;

    void sculptorRef.current?.reset('sphere');
  }, [
    gamePhase.roomState,
    gamePhase.gameState,
    gamePhase.roundNumber,
    gamePhase.sculptorPubKey
  ]);

  const [chatInput, setChatInput] = useState('');
  const [guessInput, setGuessInput] = useState('');
  
  const handleSendMessage = () => {
    if (chatInput.trim() === '') return;
    sendChatMessage(chatInput); // Fires it off to the network
    setChatInput(''); // Clears the box
  };

  const handleGuessSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();

    const guess = guessInput.trim();
    if (!guess) return;

    sendGuess(guess);
    setGuessInput('');
  };

  const hostName = (Object.values(players).find((p: any) => p.id === 1) as any)?.name || 'Connecting...';

  const [historicalNames, setHistoricalNames] = useState<Record<string, string>>({});

  useEffect(() => {
    setHistoricalNames(prev => {
      const next = { ...prev };
      let changed = false;
      
      Object.values(players).forEach((p: any) => {
        if (next[p.publicKey] !== p.name) {
          next[p.publicKey] = p.name;
          changed = true;
        }
      });
      
      return changed ? next : prev;
    });
  }, [players]);


  const [showConfigurator, setShowConfigurator] = useState(isHost);

  const visibilityStatusDisplay = () => {
    return <span className='room-info-text centered gap-4'>{config.visibilityStatus === 'changing' ?  <LoaderCircle /> : config.visibilityStatus === 'public' ? (Object.keys(players).length >= config.playerLimit ? <DoorClosed /> : <DoorOpen />) : <DoorClosedLocked />}{config.visibilityStatus === 'changing' ? 'Changing' : config.visibilityStatus === 'public' ? 'Public Room' : 'Private Room'}</span>
  }

  const [isHoveringVisibility, setIsHoveringVisibility] = useState(false);

  const renderWaitingRoom = () => {
    return (
      <div className="flex-column centered gap-4">
        {isHost ? (
          <div className='flex-row gap-6'>
          <button className="mid submit" onClick={startGame} disabled={Object.keys(players).length < 2}>
            Start Game
          </button>
          <button className='mid light' onClick={() => setShowConfigurator(!showConfigurator)}>
            <Settings size={16} />
          </button>
          </div>
        ) : (
          <h3>Waiting for Host to start...</h3>
        )}
      </div>
    );
  };

  const renderTurnOverlay = (isMyTurn: boolean) => {
    switch (gamePhase.gameState) {
      case GAME_STATE.WAITING_FOR_WORD:
        if (isMyTurn) {
          return (
            <div className="modal-overlay" onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
              <div className="flex-column centered gap-4">
                <h2>Pick a word to sculpt!</h2>
                <div className="flex-row gap-4">
                  {wordChoices.map((word, index) => (
                    <button
                      key={index}
                      className="mid orange"
                      onClick={() => sendWordChoice(index)}
                    >
                      {word}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          );
        }

        return (
          <div className="modal-overlay" onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
            <h3>
              Waiting for {players[gamePhase.sculptorPubKey]?.name || "Someone"} to pick a word...
            </h3>
          </div>
        );

      case GAME_STATE.TURN_ENDED_TIME:
      case GAME_STATE.TURN_ENDED_GUESSED:
      case GAME_STATE.TURN_ENDED_SKIP:
      case GAME_STATE.TURN_ENDED_DISCONNECT:
        return (
          <div className="flex-column panel centered gap-4 turn-over">
            <h2>Turn Over!</h2>
            {secretWord ? (
              <h3>
                The word was: <span className="highlight">{secretWord}</span>
              </h3>
            ) : (
              <h3>No word was selected. Turn skipped.</h3>
            )}

            {gamePhase.gameState === GAME_STATE.TURN_ENDED_DISCONNECT && (
              <p>Sculptor disconnected.</p>
            )}

            {gamePhase.gameState === GAME_STATE.TURN_ENDED_TIME && (
              <p>Time ran out!</p>
            )}

            {gamePhase.gameState === GAME_STATE.TURN_ENDED_GUESSED && (
              <p>Everyone guessed the word!</p>
            )}
          </div>
        );

      default:
        return null;
    }
  };

  const renderActiveGame = () => {
    const isMyTurn = userData?.publicKey === gamePhase.sculptorPubKey;
    const isSculpting = gamePhase.gameState === GAME_STATE.SCULPTING;
    const canEditModel = isMyTurn && isSculpting;
    const showOverlay = !isSculpting;
    
    // const myPlayer = players[userData?.publicKey ?? ''];
    // const canGuess = isSculpting && !isMyTurn && !myPlayer?.hasGuessed;
    const showGuess = isSculpting && !isMyTurn

    return (
      <>
        <Sculptor
          ref={sculptorRef}
          mode={(canEditModel) ? 'sculptor' : 'guesser'}
          gamePhase={gamePhase}
          showTools={canEditModel}
          remoteBrushAction={remoteBrushAction}
          remoteBrushActionSeq={remoteBrushActionSeq}
          remoteBrushHistoryBatch={remoteBrushHistoryBatch}
          remoteBrushHistoryBatchSeq={remoteBrushHistoryBatchSeq}
          onBrushAction={sendBrushAction}
          onRequestBrushHistory={requestBrushHistory}
      />

        {showGuess && renderGuessControls()}

        {isSculpting && 
          <div className='centered flex-column top-info'>
            {isMyTurn && <span>{`You are sculpting: ${secretWord}`}</span>}
            <span>{`Time left: ${gamePhase.duration}s`}</span>
          </div>
        }

        {gamePhase.gameState === GAME_STATE.WAITING_FOR_WORD && 
          <div className='centered flex-column top-info'>
            <span>{`Time left: ${gamePhase.duration}s`}</span>
          </div>
        }

        {showOverlay && (
            renderTurnOverlay(isMyTurn)
        )}
          <div className='timer-bar' style={{ bottom: '2px' , '--duration': `${gamePhase.duration}`, '--total-duration': `${gamePhase.gameState === GAME_STATE.WAITING_FOR_WORD ?  config.wordPickDurationSeconds : config.turnDurationSeconds}`  } as React.CSSProperties }></div>
          <div className='timer-bar' style={{ top: '2px' , '--duration': `${gamePhase.duration}`, '--total-duration': `${gamePhase.gameState === GAME_STATE.WAITING_FOR_WORD ?  config.wordPickDurationSeconds : config.turnDurationSeconds}`  } as React.CSSProperties }></div>
      </>
    );
  };

const renderGameOver = () => {
  const sortedPlayers = Object.values(players)
    .map((player: any) => player)
    .sort((a: any, b: any) => {
      const bScore = b.currentPoints ?? 0;
      const aScore = a.currentPoints ?? 0;

      if (bScore !== aScore) return bScore - aScore;

      return (a.id ?? 9999) - (b.id ?? 9999);
    });

  const firstPlayer = sortedPlayers[0];
  const secondPlayer = sortedPlayers[1];
  const thirdPlayer = sortedPlayers[2];

  const getScore = (player: any) => player?.currentPoints ?? 0;

  const gridTempColds = thirdPlayer ? 'calc(33.33% - 1px) calc(33.33% - 1px) calc(33.33% - 1px)' : 'calc(50% - 1px) calc(50% - 1px)';
  return (
    <div className="flex-column centered gap-4">
      <h2>Game Over!</h2>

      <div
        className="align-end gap-2"
        style={{ width: '100%', margin: '16px 0', display: 'grid', gridTemplateColumns: gridTempColds }}
      >
        {secondPlayer && (
          <div className="flex-column width-100 centered relative">
            <Crown size={20} color="var(--c-orange-25)" fill="var(--c-orange-15)" />
            <span className="centered gap-4 podium-username">{secondPlayer.name}</span>
            <div className="podium second centered">Second</div>
          </div>
        )}

        {firstPlayer && (
          <div className="flex-column width-100 centered relative">
            <Crown size={20} color="var(--c-yellow-50)" fill="var(--c-yellow-25)" />
            <span className="centered gap-4 podium-username">{firstPlayer.name}</span>
            <div className="podium first centered">Winner</div>
          </div>
        )}

        {thirdPlayer && (
          <div className="flex-column width-100 centered relative">
            <Crown size={20} color="var(--c-grey-30)" fill="var(--c-grey-15)" />
            <span className="centered gap-4 podium-username">{thirdPlayer.name}</span>
            <div className="podium third centered">Third</div>
          </div>
        )}
      </div>

      <div className="flex-column flex-grow">
        {sortedPlayers.map((player: any) => (
          <div
            key={player.publicKey}
            className="flex-row centered space-between flex-grow gap-6"
          >
            <span>{player.name}</span>
            <div
              className="flex-grow"
              style={{
                height: '1px',
                backgroundColor: 'var(--c-grey-30)',
                minWidth: '24px'
              }}
            />
            <span>{`Score: ${getScore(player)}`}</span>
          </div>
        ))}
      </div>

      {isHost && (
        <button className="submit mid" onClick={returnToRoom} style={{marginTop: '16px'}}>
          Back to Room
        </button>
      )}
    </div>
  );
};

  const renderGameArea = () => {
    switch (gamePhase.roomState) {
      case ROOM_STATE.WAITING_IN_LOBBY:
        return renderWaitingRoom();

      case ROOM_STATE.GAME_IN_PROGRESS:
        return renderActiveGame();

      case ROOM_STATE.GAME_OVER:
        return renderGameOver();

      default:
        return null;
    }
  };

  const renderGuessControls = () => {
    const myPlayer = players[userData?.publicKey ?? ''];
    const canGuess = !myPlayer?.hasGuessed;

    return (
      <form
        className="guess-box panel transparent flex-row gap-6 relative"
        onSubmit={handleGuessSubmit}
      >
        {canGuess ? (
          <>
          <input
            type="text"
            className="message-input align-start flex-grow"
            placeholder="Enter your guess..."
            value={guessInput}
            onChange={(e) => setGuessInput(e.target.value)}
          />

          <button className="submit centered" type="submit">
            <SendHorizontal size={16} />
          </button>
          </>
        ) : (
          <span className="centered" style={{width: '300px', height: '32px'}}>You found it!</span>
        )}
        
        {recentGuesses && (
          <div className='recent-guesses-section flex-column'>
            {recentGuesses.map((guess, index) => {

              let text = '';

              switch (guess.status) {
                case 2:
                  text =  `"${guess.guess}" is correct!`;
                  break;
                case 1:
                  text =  `"${guess.guess}" is close`;
                  break;
                default:
                  text = `"${guess.guess}" is wrong`;
                  break;
              }

              return <span className={`recent-guess card status-${guess.status}`} style={{opacity: `${(index + 1)/(recentGuesses.length)}`}}>{text}</span>
            })}
          </div>
        )}
      </form>
    );
  };


  const getInviteCode = () => {
    if (!userData?.publicKey || !roomCode) return "";

    return `${userData.publicKey}.${roomCode}`;
  };

  const copyInviteCode = async () => {
    const inviteCode = getInviteCode();

    if (!inviteCode) return;

    await navigator.clipboard.writeText(inviteCode);

    ui.alert('Invite Copied', 'Invitation code copied to clipboard.');
  };













  return (
    <div className='window-content flex-row'>
      <div className='titlebar-controls room-titlebar-controls'>
        <button className={`close pad-4 rotate-180`} onClick={disconnectFromNetwork}><LogOut /></button>
        <span className='title-bar-room-name'>{config.roomName}</span>
        { isHost ?  (
            <button className='ghost pad-2' onClick={() => setShowConfigurator(!showConfigurator)}><Settings size={16} /></button>
          ) : (
            <div style={{width: '24px'}}/>
          )
        }
      </div>

      {showConfigurator && (
        <RoomConfigurator onClose={() => setShowConfigurator(false)} />
      )}

      <div className='room-info'>
        {isHost && (
        <>
          <button
            className="mid ghost"
            style={{marginTop: '-2px', marginBottom: '-2px'}}
            onClick={copyInviteCode}
            disabled={!roomCode}
          >
            Copy Invite Code
          </button>
          <div className='room-info-text-gap-big' />
        </>
        )}
        <div className='hide-buttons flex-column centered width-100'>
          <div className='room-info-text'>
            {isHost ?
              <button className={`pad-2 margin--2 flex-row ${(isHoveringVisibility && config.visibilityStatus !== 'changing') ? (config.visibilityStatus === 'private' ? ' submit' : ' close') : ' ghost'}`}
                onClick={() => toggleRoomVisibility(config.visibilityStatus === 'private')}
                onMouseEnter={() => setIsHoveringVisibility(true)}
                onMouseLeave={() => setIsHoveringVisibility(false)}
                disabled={config.visibilityStatus === 'changing'}  >
                  { ( isHoveringVisibility && config.visibilityStatus !== 'changing' ) ? (
                      <span className='font-16 centered gap-4'>{config.visibilityStatus === 'changing' ?  <LoaderCircle size={20} /> : config.visibilityStatus === 'public' ? (Object.keys(players).length >= config.playerLimit ? <DoorClosed size={20} /> : <DoorOpen size={20} />) : <DoorClosedLocked size={20} />}{config.visibilityStatus === 'changing' ? 'Changing' : config.visibilityStatus === 'public' ? 'Set to Private' : 'Set to Public'}</span>
                    ) : (
                      visibilityStatusDisplay()
                    )
                  }
              </button>
            : 
              visibilityStatusDisplay()
            }
          </div>
          {config.passwordEnabled && <span className='room-info-text'>{`Password Required`}</span>}
          <div className='room-info-text-gap-big' />
          <span className='room-info-text'>{`Host: ${hostName}`}</span>
          <span className='room-info-text'>{`Language: ${config.language}`}</span>
          <div className='room-info-text-gap-big' />
          <span className='room-info-text'>{`Word Picking Time: ${config.wordPickDurationSeconds}s`}</span>
          <span className='room-info-text'>{`Sculpting Time: ${config.turnDurationSeconds}s`}</span>
          <div className='room-info-text-gap-big' />
          <span className='room-info-text'>{`Players: ${Object.keys(players).length}/${config.playerLimit}`}</span>
          <div className='room-info-text-gap-small' />
        </div>

        <div className='player-list bg pad-6 gap-6'>
          {Object.values(players).map((player: any) => (
            <PlayerCard 
              key={player.publicKey}
              player={player}
              showHostControls={isHost}
              isHost={player.id === 1}
            />
          ))}
        </div>
      </div>

      <div className='game-area centered relative'>
        {renderGameArea()}
      </div>
      
      <div className='messages-panel'>
        <div className='messages-sections-container flex-grow flex-column'>

          {/* --- 1. SYSTEM LOGS (Room Messages) --- */}
          <div className='messages-section centered'>
            <span className='room-info-text'>Room Messages</span>
            <div className='room-info-text-gap-small' />

            <div
              key={`logs-pulse-${gameLogs.length}`}
              className="section-pulse-overlay"
            />
            
            <ScrollableList 
              reversed={true}
              items={gameLogs}
              renderItem={(log:any, index) => (
                <MessageCard
                  key={`log-${index}`}
                  message={typeof log === 'string' ? log : log.message}
                  messageType={typeof log === 'string' ? GAME_LOG_TYPE.NORMAL : log.type}
                  cardType="log"
                />
              )}
            />
          </div>

          {/* --- 2. PLAYER CHAT (Player Messages) --- */}
          <div className='messages-section centered'>
            <span className='room-info-text'>Player Messages</span>
            <div className='room-info-text-gap-small' />

            <div
              key={`chat-pulse-${chatMessages.length}`}
              className="section-pulse-overlay"
            />

            <ScrollableList 
              reversed={true}
              items={chatMessages}
              renderItem={(msg:any, index) => {
                const senderName = msg.sender === '0' ? 'Warning' : historicalNames[msg.sender] || 'Unknown';
                return (
                  <MessageCard 
                    key={`chat-${index}`} 
                    sender={senderName} 
                    message={msg.text} 
                    messageType={msg.type}
                    cardType="chat"

                  />
                );
              }}
            />
          </div>

        </div>

        <div className='message-input-area flex-row'>
          <input 
            type='text' 
            placeholder='Type a message...' 
            className='message-input align-start flex-grow' 
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()} // Send on Enter key!
          />
          <button className='submit centered' onClick={handleSendMessage}>
            <SendHorizontal size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}