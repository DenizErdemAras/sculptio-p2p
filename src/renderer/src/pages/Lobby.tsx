import { useContext, useState } from 'react';
import { NetworkContext } from '../contexts/NetworkContext';
import { GameContext } from '../contexts/GameContext';
import { UserContext } from '../contexts/UserContext';
import ScrollableList from '../components/ScrollableList';
import { DoorOpen, DoorClosed, DoorClosedLocked } from 'lucide-react';

function RoomCard({ room, onJoin }: { room: any; onJoin: () => void }) {
  const isFull = room.currPlayers >= room.userLimit;

  return (
    <div className={`card pad-6 flex-column relative`}>
        
        <div className='flex-row space-between centered'> 
          <h2 className='room-name' style={{transform: 'translateY(-2px)'}}>
            {isFull ? (room.hasPassword ? <DoorClosed color="hsl(from var(--c-red-color) h 75 40 / 50)" /> : <DoorClosed color="hsl(from var(--c-blue-color) h 75 30 / 50)"/>) : (room.hasPassword ? <DoorClosedLocked color="hsl(from var(--c-red-color) h 75 40)" /> : <DoorOpen color="hsl(from var(--c-blue-color) h 85 65)"/>)}
            {room.roomName}
          </h2>

          <div className='flex-row centered'>
            <span className='grey-text fw-400'>Players: {room.currPlayers}/{room.userLimit}</span>
            <button
              className={`mid ${isFull ? 'disabled' : 'submit'}`}
              // style={{height: "58px", width: "58px"}}
              style={{marginLeft: '8px', height: '30px'}}
              disabled={isFull}
              onClick={(e) => {
                e.stopPropagation();
                if (!isFull) onJoin();
              }}
            >
              Join
            </button>
          </div>
        </div>
        
        <p className='grey-text fw-400' style={{width: 'min-content', textWrap: 'nowrap', marginTop: '-5px'}}>{`Language: ${room.language}`}</p>
        <p className='grey-text fw-400' style={{width: 'min-content', textWrap: 'nowrap', marginTop: '-2px'}}>{`Host: ${room.hostName}`}</p>
        
        {/* <div className='flex-column' style={{marginTop: '0px'}}>
        </div> */}

        <span  className="id-display" style={{transform: 'translateX(-1.8px)'}} onClick={(e) => e.stopPropagation()}>Host ID: {room.hostPublicKey}</span>

        {/* <span className='fw-200 fs-12 color-grey' style={{position: 'absolute', bottom: '5px', right: '5px'}}>{`updated ${1}s ago`}</span> */}

    </div>
  );
}

export default function Lobby() {
  const {
    compatibleRooms,
    joinRoom,
    refreshLobbyRooms,
    disconnectFromNetwork
  } = useContext(NetworkContext);

  const { userData } = useContext(UserContext);

  const { startNewHostedRoom } = useContext(GameContext);

  const [passwordRoom, setPasswordRoom] = useState<any | null>(null);
  const [passwordInput, setPasswordInput] = useState('');

  const getSavedRoomConfig = () => {
    const saved = userData?.preferences?.latestRoomConfig ?? {};

    return {
      roomName: saved.roomName ?? "Room Name",
      language: saved.language ?? "Türkçe",
      playerLimit: saved.playerLimit ?? 8,
      wordList: saved.wordList ?? "english",
      gameMode: saved.gameMode ?? 0,
      totalRounds: saved.totalRounds ?? 3,
      turnDurationSeconds: saved.turnDurationSeconds ?? 90,
      wordPickDurationSeconds: saved.wordPickDurationSeconds ?? 20,
      passwordEnabled: saved.passwordEnabled ?? false,
      password: saved.password ?? "",

      // Always start new rooms private.
      visibilityStatus: "private"
    };
  };

  const handleCreateRoom = () => {
    startNewHostedRoom(getSavedRoomConfig());
  };

  const handleJoinRoom = async (room: any) => {
    if (room.hasPassword) {
      setPasswordRoom(room);
      setPasswordInput('');
      return;
    }

    await joinRoom(room.publicKey, '');
  };

  const closePasswordModal = () => {
    setPasswordRoom(null);
    setPasswordInput('');
  };

  const submitPasswordJoin = async (e?: React.FormEvent) => {
    e?.preventDefault();

    if (!passwordRoom) return;

    const password = passwordInput;

    closePasswordModal();
    await joinRoom(passwordRoom.publicKey, password);
  };

  const renderPasswordModal = () => {
    if (!passwordRoom) return null;

    return (
      <div
        className="modal-overlay"
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
        onClick={closePasswordModal}
      >
        <div className='modal-content panel'>
          <form
            className="flex-column centered gap-6"
            onSubmit={submitPasswordJoin}
            onClick={(e) => e.stopPropagation()}
          >
            <h2>Enter Room Password</h2>

            <div className="flex-column gap-6 width-100">
              <span className="grey-text fw-400">
                {passwordRoom.roomName}
              </span>

              <input
                className="config-input"
                type="password"
                placeholder="Room password"
                value={passwordInput}
                autoFocus
                onChange={(e) => setPasswordInput(e.target.value)}
              />
            </div>

            <div className="flex-row width-100 gap-6">
              <button
                type="button"
                className="mid flex-grow red"
                onClick={closePasswordModal}
              >
                Cancel
              </button>

              <button
                type="submit"
                className="mid flex-grow submit"
              >
                Join Room
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  };
  
  return (
    <>
      {renderPasswordModal()}
      
      <div className="centered white flex-column flex-grow gap-6" style={{marginTop: "4px", marginBottom: "16px", width: "460px", maxHeight: "720px"}}>
        <h1>Lobby</h1>


        <div className="lobby-room-list panel pad-6 gap-6 flex-grow flex-column width-100">
          <div className="flex-row width-100 gap-6">
            <button className="mid flex-grow red" onClick={disconnectFromNetwork}>  Back to Menu</button>
            <button className="mid flex-grow light" onClick={refreshLobbyRooms}>Refresh Lobby</button>
            <button className="mid flex-grow submit" onClick={handleCreateRoom}>Host New Room</button>
          </div>

          <div className='flex-grow centered'>
            {compatibleRooms.length === 0 ? (
                
                <ScrollableList
                items={[1]}
                renderItem={() => (
                  <span className='centered height-100'>No rooms found. Be the first to host.</span>
                )}
              />
            ) : (
              <ScrollableList
                items={compatibleRooms}
                renderItem={(room: any) => (
                  <RoomCard
                    key={room.publicKey}
                    room={room}
                    onJoin={() => handleJoinRoom(room)}
                  />
                )}
              />
            )}
          </div>
        </div>
      </div>
    </>
  );
}