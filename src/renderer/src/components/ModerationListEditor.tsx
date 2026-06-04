// src/renderer/src/components/ModerationListEditor.tsx
import { useContext, useState } from 'react';
import { NetworkContext } from '../contexts/NetworkContext';
import ScrollableList from './ScrollableList'

interface ModerationListEditorProps {
  onClose: () => void;
}

type ListType = 'blacklist' | 'whitelist';

export default function ModerationListEditor({ onClose }: ModerationListEditorProps) {
  const {
    moderationPolicy,
    blockPublicKey,
    unblockPublicKey,
    allowPublicKey,
    disallowPublicKey,
  } = useContext(NetworkContext);

  const [activeList, setActiveList] = useState<ListType>('blacklist');
  const [publicKeyInput, setPublicKeyInput] = useState('');

  const blacklist: string[] = moderationPolicy?.blacklist ?? [];
  const whitelist: string[] = moderationPolicy?.whitelist ?? [];

  const currentList = activeList === 'blacklist' ? blacklist : whitelist;

  const handleAdd = async () => {
    const publicKey = publicKeyInput.trim();
    if (!publicKey) return;

    if (activeList === 'blacklist') {
      await blockPublicKey(publicKey);
    } else {
      await allowPublicKey(publicKey);
    }

    setPublicKeyInput('');
  };

  const handleRemove = async (publicKey: string) => {
    if (activeList === 'blacklist') {
      await unblockPublicKey(publicKey);
    } else {
      await disallowPublicKey(publicKey);
    }
  };

  const title = activeList === 'blacklist' ? 'Blacklist' : 'Whitelist';

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content panel" onClick={(e) => e.stopPropagation()}>
        <h2>Moderation Lists</h2>

        <div className="config-section flex-column">
          <h3 className="section-title">List Type</h3>

          <div className="flex-row gap-6 width-100 grid-full-row centered">
            <button
              className={`${activeList === 'blacklist' ? 'orange  mid' : 'mid light'} flex-grow`}
              onClick={() => setActiveList('blacklist')}
            >
              Blacklist
            </button>

            <button
              className={`${activeList === 'whitelist' ? 'orange mid' : 'mid light'} flex-grow`}
              onClick={() => setActiveList('whitelist')}
            >
              Whitelist
            </button>
          </div>
        </div>

        <div className="config-section flex-column centered">
          <h3 className="section-title">{title}</h3>

          <div className="input-group">
            <div className="flex-row gap-6">
              <input
                type="text"
                className="config-input flex-grow"
                value={publicKeyInput}
                placeholder="Paste player public key"
                onChange={(e) => setPublicKeyInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAdd();
                }}
              />

              <button className="submit mid" onClick={handleAdd}>
                Add
              </button>
            </div>
          </div>

          {currentList.length > 0 && <div className="width-100 flex-column gap-4">
            <ScrollableList
              items={currentList}
              renderItem={(publicKey) => (
                <div key={publicKey} className="card flex-row gap-6 centered">
                  <span className="mono id-display" style={{color: 'var(--c-white)'}}>
                    {publicKey}
                  </span>
                  <button
                    className="red pad-4 small"
                    onClick={() => handleRemove(publicKey)}
                  >
                    Remove
                  </button>
                </div>
              )}
            />
          </div>}
        </div>

        <div className="modal-footer">
          <button className="mid light" onClick={onClose}>
            Back
          </button>
        </div>
      </div>
    </div>
  );
}