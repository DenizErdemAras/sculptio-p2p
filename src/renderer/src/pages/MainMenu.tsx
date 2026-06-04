import { useContext, useState } from 'react';
import { UserContext } from '../contexts/UserContext';
import { NetworkContext } from '../contexts/NetworkContext';
import { GameContext } from '../contexts/GameContext';
import { UIContext } from '../contexts/UIContext';

import { HiddenTextInput } from '../components/InputElements';

import DhtNetworkEditor from '../components/DhtNetworkEditor';

import { Globe2 } from 'lucide-react';

export default function MainMenu() {
  const { userData, updateUserData } = useContext(UserContext);
  const { status, connectToLobby, joinRoom } = useContext(NetworkContext);
  const { startNewHostedRoom } = useContext(GameContext);
  const ui = useContext(UIContext);

  const username = userData?.username || 'Loading...';
  
  // Swap from seed to publicKey here
  const displayId = userData?.publicKey 
    ? `${userData.publicKey}` 
    : 'Generating ID...';

  const [showJoinModal, setShowJoinModal] = useState(false);
  const [inviteCodeInput, setInviteCodeInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');

  const [showDhtNetworkModal, setShowDhtNetworkModal] = useState(false);

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

      visibilityStatus: "private"
    };
  };

  const handleCreateRoom = () => {
    startNewHostedRoom(getSavedRoomConfig());
  };

  const parseInviteCode = (rawCode: string) => {
    const code = rawCode.trim();

    if (!code) return null;

    const parts = code.split('.').map(part => part.trim()).filter(Boolean);

    if (parts.length === 1) {
      return {
        hostPublicKey: "",
        roomPublicKey: parts[0]
      };
    }

    if (parts.length === 2) {
      return {
        hostPublicKey: parts[0],
        roomPublicKey: parts[1]
      };
    }

    return null;
  };

  const handleJoinWithInvite = async (e?: React.FormEvent) => {
    e?.preventDefault();

    const parsed = parseInviteCode(inviteCodeInput);

    if (!parsed?.roomPublicKey) return;

    setShowJoinModal(false);

    await joinRoom(parsed.roomPublicKey, passwordInput, 'menu');

    setInviteCodeInput('');
    setPasswordInput('');
  };

  const closeJoinModal = () => {
    setShowJoinModal(false);
    setInviteCodeInput('');
    setPasswordInput('');
  };

  return (
  <>
    
    {showDhtNetworkModal && (
      <DhtNetworkEditor onClose={() => setShowDhtNetworkModal(false)} />
    )}

    {showJoinModal && (
      <div
        className="modal-overlay"
        onClick={closeJoinModal}
      >
        <form
          className="modal-content panel flex-column gap-6"
          onSubmit={handleJoinWithInvite}
          onClick={(e) => e.stopPropagation()}
        >
          <h2 className="modal-title">Join with Invitation Code</h2>

          <div className="flex-column gap-2 width-100">
            <label>Invitation Code</label>
            <input
              type="text"
              className="config-input"
              value={inviteCodeInput}
              placeholder="..."
              autoFocus
              onChange={(e) => setInviteCodeInput(e.target.value)}
            />
          </div>

          <div className="flex-column gap-2 width-100">
            <label>Password</label>
            <input
              className="config-input"
              type="password"
              value={passwordInput}
              placeholder="No password"
              onChange={(e) => setPasswordInput(e.target.value)}
            />
          </div>

          <div className="flex-row width-100 gap-6">
            <button
              type="button"
              className="mid flex-grow red"
              onClick={closeJoinModal}
            >
              Cancel
            </button>

            <button
              type="submit"
              className="mid flex-grow submit"
              disabled={!parseInviteCode(inviteCodeInput)?.roomPublicKey}
            >
              Join Room
            </button>
          </div>
        </form>
      </div>
    )}

    <div className='main-menu-container centered flex-column'>
      <div className="menu-panel flex-column gap-6">
        
        <div className='user-data-panel panel flex-row gap-4'>
          <div className='user-profile-picture centered'>
            {username.charAt(0).toUpperCase()}
          </div>
          <div className='flex-column space-between pad-2'>
            <HiddenTextInput
              className="username"
              inputClassName="username"
              inputStyle={{ height: "28px", width: "316px", padding: "0px"}}
              value={username}
              placeholder="Player"
              maxLength={24}
              onChange={(name) => {
                  updateUserData({
                      username: name || 'Player'
                  });
              }}
          />
            <span className='user-id mono'>ID: {displayId}</span>
          </div>
        </div>

        <button 
          className='big' 
          onClick={() => connectToLobby()}
          disabled={!userData?.seed}
        >
          {status === 'offline' ? 'Connect to Lobby' : 'Connecting' }
        </button>

        <button
          className="big"
          onClick={handleCreateRoom}
          disabled={!userData?.seed}
        >
          Host New Room
        </button>

        <button
          className="big"
          onClick={() => setShowJoinModal(true)}
          disabled={!userData?.seed}
        >
          Join with Invitation Code
        </button>

        <button
          className="big"
          onClick={() => ui?.setView('sandbox')}
        >
          Sandbox Mode
        </button>
        
      </div>
    </div>

    <button
      className="pad-4 gap-4"
      style={{
        position: 'absolute',
        right: '16px',
        bottom: '16px'
      }}
      onClick={() => setShowDhtNetworkModal(true)}
    >
      <span className='parent-hover'>DHT Network Settings</span>
      <Globe2 size={22} />
    </button>

  </>
  );
}