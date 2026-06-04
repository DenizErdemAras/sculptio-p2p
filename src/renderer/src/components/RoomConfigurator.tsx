// src/renderer/src/components/RoomConfigurator.tsx
import { useState, useContext, useEffect, useMemo  } from 'react';
import { GameContext, ROOM_STATE } from '../contexts/GameContext';
import { NetworkContext } from '../contexts/NetworkContext';
import { UserContext } from '../contexts/UserContext';
import ModerationListEditor from './ModerationListEditor';
import WordListEditor from './WordListEditor';
import { NumberInput } from './InputElements';

type CustomWordList = {
  id: string;
  name: string;
  easy: string[];
  medium: string[];
  hard: string[];
};

const BUILT_IN_WORD_LIST_OPTIONS = [
  { value: 'english', label: 'English' },
  { value: 'turkish', label: 'Türkçe' }
];

const getCustomWordListValue = (id: string) => {
  return `custom:${id}`;
};

const countValidWords = (words: unknown) => {
  if (!Array.isArray(words)) return 0;

  return words.filter(word => String(word ?? '').trim().length > 0).length;
};

const isValidCustomWordList = (list: any): list is CustomWordList => {
  return (
    !!list &&
    typeof list.id === 'string' &&
    list.id.trim().length > 0 &&
    countValidWords(list.easy) >= 10 &&
    countValidWords(list.medium) >= 10 &&
    countValidWords(list.hard) >= 10
  );
};

interface RoomConfiguratorProps {
  onClose: () => void;
}

export default function RoomConfigurator({ onClose }: RoomConfiguratorProps) {
  const { config, gamePhase, updateRoomConfig, toggleRoomVisibility } = useContext(GameContext);
  const { moderationPolicy, setModerationMode } = useContext(NetworkContext);
  const { userData, updateUserData } = useContext(UserContext);
  
  const [localConfig, setLocalConfig] = useState(config);
  const [localModerationMode, setLocalModerationMode] = useState(
    moderationPolicy?.mode ?? 'disabled'
  );
  const [isEditingList, setIsEditingList] = useState(false);
  const [isEditingWordLists, setIsEditingWordLists] = useState(false);

  const isGameActive =  gamePhase.roomState === ROOM_STATE.GAME_STARTING || 
                        gamePhase.roomState === ROOM_STATE.GAME_IN_PROGRESS;

  const validCustomWordLists = useMemo(() => {
    const lists = userData?.preferences?.customWordLists;

    if (!Array.isArray(lists)) return [];

    return lists.filter(isValidCustomWordList);
  }, [userData?.preferences?.customWordLists]);

  const wordListOptions = useMemo(() => {
    return [
      ...BUILT_IN_WORD_LIST_OPTIONS,
      ...validCustomWordLists.map((list: CustomWordList) => ({
        value: getCustomWordListValue(list.id),
        label: `Custom: ${list.name || 'Untitled List'}`
      }))
    ];
  }, [validCustomWordLists]);

  const getSafeWordListValue = (value: string | undefined) => {
    const selectedValue = value ?? 'english';

    if (wordListOptions.some(option => option.value === selectedValue)) {
      return selectedValue;
    }

    return 'english';
  };

  const getSavableRoomConfig = (roomConfig: any) => {
    return {
      roomName: roomConfig.roomName,
      language: roomConfig.language,
      wordList: getSafeWordListValue(roomConfig.wordList),
      playerLimit: roomConfig.playerLimit,
      gameMode: roomConfig.gameMode,
      totalRounds: roomConfig.totalRounds,
      turnDurationSeconds: roomConfig.turnDurationSeconds,
      wordPickDurationSeconds: roomConfig.wordPickDurationSeconds,
      passwordEnabled: roomConfig.passwordEnabled,
      password: roomConfig.password ?? "",

      // Save as private so future rooms do not claim to be public before announceRoomState runs.
      visibilityStatus: "private"
    };
  };

  const handleSave = async () => {
    const previousVisibility = config.visibilityStatus;
    const nextVisibility = localConfig.visibilityStatus;

    const validatedLocalConfig = {
      ...localConfig,
      wordList: getSafeWordListValue(localConfig.wordList)
    };

    const configWithoutChangingState = {
      ...validatedLocalConfig,
      visibilityStatus: previousVisibility
    };

    await updateRoomConfig(configWithoutChangingState);

    await updateUserData({
      preferences: {
        ...(userData.preferences ?? {}),
        latestRoomConfig: getSavableRoomConfig(validatedLocalConfig)
      }
    });

    if (localModerationMode !== (moderationPolicy?.mode ?? 'disabled')) {
      await setModerationMode(localModerationMode);
    }

    if (
      previousVisibility !== nextVisibility &&
      previousVisibility !== 'changing'
    ) {
      await toggleRoomVisibility(nextVisibility === 'public');
    }
  };

  useEffect(() => {
    setLocalConfig(prev => ({
        ...prev,
        visibilityStatus: config.visibilityStatus
    }));
  }, [config.visibilityStatus])

  useEffect(() => {
    setLocalConfig(prev => {
      const safeWordList = getSafeWordListValue(prev.wordList);

      if (safeWordList === prev.wordList) return prev;

      return {
        ...prev,
        wordList: safeWordList
      };
    });
  }, [wordListOptions]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  useEffect(() => {
    setLocalModerationMode(moderationPolicy?.mode ?? 'disabled');
  }, [moderationPolicy?.mode]);

  return (
    <>
      {isEditingList && (
        <ModerationListEditor onClose={() => setIsEditingList(false)} />
      )}

      {isEditingWordLists && (
        <WordListEditor onClose={() => setIsEditingWordLists(false)} />
      )}

      {!isEditingList && !isEditingWordLists && (
        <div className="modal-overlay extra" onClick={onClose}>
          <div className="modal-content panel" onClick={(e) => {e.stopPropagation()}}>
            <h2 className="modal-title">Configure Room</h2>

            <div className='settings-grid'>

              <div className="config-section flex-column centered">
                <h3 className="section-title">Connection Settings</h3>

                <div className="input-group">
                  <label>Publicity</label>
                  <select
                    className="config-select"
                    value={localConfig.visibilityStatus}
                    disabled={config.visibilityStatus === 'changing'}
                    onChange={(e) => {
                      setLocalConfig({
                        ...localConfig,
                        visibilityStatus: e.target.value
                      });
                    }}
                  > 
                    {localConfig.visibilityStatus === 'changing' && (
                        <option value="changing">Changing...</option>
                    )}
                    <option value="private">Private</option>
                    <option value="public">Public</option>
                  </select>
                </div>

                <div className="input-group">
                  <label>Moderation Mode</label>
                  <select
                    className="config-select"
                    value={localModerationMode}
                    onChange={(e) => setLocalModerationMode(e.target.value as 'disabled' | 'blacklist' | 'whitelist')}
                  >
                    <option value="disabled">Disabled</option>
                    <option value="blacklist">Blacklist</option>
                    <option value="whitelist">Whitelist</option>
                  </select>
                </div>

                <div className="grid-full-row width-100 centered" style={{ gridColumn: '1 / -1' }}>
                  <button
                    className="mid light width-100"
                    onClick={() => setIsEditingList(true)}
                  >
                    Edit Moderation Lists
                  </button>
                </div>

                <div className="input-group">
                  <label>Password</label>
                  <select
                    className="config-select"
                    value={localConfig.passwordEnabled ? 'enabled' : 'disabled'}
                    onChange={(e) => {
                      const enabled = e.target.value === 'enabled';

                      setLocalConfig({
                        ...localConfig,
                        passwordEnabled: enabled,
                        password: enabled ? (localConfig.password ?? '') : ''
                      });
                    }}
                  >
                    <option value="disabled">Disabled</option>
                    <option value="enabled">Enabled</option>
                  </select>
                </div>

                {localConfig.passwordEnabled && (
                  <div className="input-group">
                    <label>Room Password</label>
                    <input
                      type="password"
                      className="config-input"
                      value={localConfig.password ?? ''}
                      placeholder="Enter room password"
                      onChange={(e) => {
                        setLocalConfig({
                          ...localConfig,
                          password: e.target.value
                        });
                      }}
                    />
                  </div>
                )}
              </div>
              
              <div className="config-section flex-column centered">
                <h3 className="section-title">Room Settings</h3>
                
                <div className="input-group">
                  <label>Room Name</label>
                  <input 
                    type="text" 
                    className="config-input"
                    value={localConfig.roomName} 
                    onChange={e => setLocalConfig({...localConfig, roomName: e.target.value})} 
                  />
                </div>

                <div className="input-group">
                  <label>Player Limit</label>
                  <NumberInput
                    min={2}
                    max={16}
                    placeholder={'2'}
                    className="config-input"
                    value={localConfig.playerLimit}
                    onChange={(value) => setLocalConfig({ ...localConfig, playerLimit: value })}
                  />
                </div>

                <div className="input-group">
                  <label>Language</label>
                  <select 
                    className="config-select"
                    value={localConfig.language} 
                    onChange={e => setLocalConfig({...localConfig, language: e.target.value})}
                  >
                    <option value="English">English</option>
                    <option value="Türkçe">Türkçe</option>
                  </select>
                </div>
              </div>

              <div className="config-section flex-column centered">
                <h3 className="section-title">Game Settings</h3>
                {isGameActive && <span className="warning-text">Cannot change game settings while a match is in progress.</span>}
                
                <div className="input-group">
                  <label>Word List</label>
                  <select
                    className="config-select"
                    value={getSafeWordListValue(localConfig.wordList)}
                    onChange={e => {
                      setLocalConfig({
                        ...localConfig,
                        wordList: e.target.value
                      });
                    }}
                    disabled={isGameActive}
                  >
                    {wordListOptions.map(option => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid-full-row width-100 centered" style={{ gridColumn: '1 / -1' }}>
                  <button
                    className="mid light width-100"
                    onClick={() => setIsEditingWordLists(true)}
                    disabled={isGameActive}
                  >
                    Edit Word Lists
                  </button>
                </div>

                <div className="input-group">
                  <label>Difficulty</label>
                  <select 
                    className="config-select"
                    value={localConfig.gameMode} 
                    onChange={e => setLocalConfig({...localConfig, gameMode: Number(e.target.value)})}
                    disabled={isGameActive}
                  >
                    <option value={0}>Easy</option>
                    <option value={1}>Medium</option>
                    <option value={2}>Hard</option>
                  </select>
                </div>

                <div className="input-group">
                  <label>Sculpting Time</label>
                  <NumberInput
                    className="config-input"
                    min={10}
                    max={300}
                    value={localConfig.turnDurationSeconds}
                    disabled={isGameActive}
                    placeholder="10"
                    onChange={(value) => {
                      setLocalConfig({
                        ...localConfig,
                        turnDurationSeconds: value
                      });
                    }}
                  />
                </div>

                <div className="input-group">
                  <label>Word Picking Time</label>
                  <NumberInput
                    className="config-input"
                    min={5}
                    max={30}
                    value={localConfig.wordPickDurationSeconds}
                    disabled={isGameActive}
                    placeholder="5"
                    onChange={(value) => {
                      setLocalConfig({
                        ...localConfig,
                        wordPickDurationSeconds: value
                      });
                    }}
                  />
                </div>

                <div className="input-group">
                  <label>Total Rounds</label>
                  <NumberInput
                    min={1}
                    max={10}
                    placeholder={'1'}
                    className="config-input"
                    value={localConfig.totalRounds}
                    disabled={isGameActive}
                    onChange={(value) => setLocalConfig({ ...localConfig, totalRounds: value })}
                  />
                </div>
              </div>
            </div>

            <div className="modal-footer">
              <button className="red mid" onClick={onClose}>Close</button>
              <button className="orange mid" onClick={() => { handleSave(); onClose(); }}>Save & Close</button>
              <button className="submit mid" onClick={handleSave}>Save</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}