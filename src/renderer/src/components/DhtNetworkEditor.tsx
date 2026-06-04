import { useContext, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { UserContext } from '../contexts/UserContext';
import ScrollableList from './ScrollableList';

interface DhtNetworkEditorProps {
  onClose: () => void;
}

type CustomDhtNetwork = {
  id: string;
  name: string;
  bootstrapNodes: string[];
};

const DEFAULT_NETWORK_ID = 'default';

const createId = () => {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
};

const normalizeNetwork = (network: any): CustomDhtNetwork => {
  return {
    id: String(network?.id ?? createId()),
    name: String(network?.name ?? 'Custom DHT Network'),
    bootstrapNodes: Array.isArray(network?.bootstrapNodes)
      ? network.bootstrapNodes.map((node: any) => String(node ?? '').trim()).filter(Boolean)
      : []
  };
};

export default function DhtNetworkEditor({ onClose }: DhtNetworkEditorProps) {
  const { userData, updateUserData } = useContext(UserContext);

  const dhtPreference = userData?.preferences?.dhtNetwork ?? {
    selectedNetworkId: DEFAULT_NETWORK_ID,
    customNetworks: []
  };

  const selectedNetworkId = dhtPreference.selectedNetworkId ?? DEFAULT_NETWORK_ID;

  const customNetworks: CustomDhtNetwork[] = Array.isArray(dhtPreference.customNetworks)
    ? dhtPreference.customNetworks.map(normalizeNetwork)
    : [];

  const [nameInput, setNameInput] = useState('');
  const [bootstrapInput, setBootstrapInput] = useState('');

  const saveDhtPreference = async (nextPreference: any) => {
    await updateUserData({
      preferences: {
        ...(userData.preferences ?? {}),
        dhtNetwork: nextPreference
      }
    });
  };

  const selectNetwork = async (networkId: string) => {
    await saveDhtPreference({
      selectedNetworkId: networkId,
      customNetworks
    });
  };

  const addNetwork = async () => {
    const name = nameInput.trim();
    const bootstrapNodes = bootstrapInput
      .split(',')
      .map(node => node.trim())
      .filter(Boolean);

    if (!name || bootstrapNodes.length === 0) return;

    const newNetwork: CustomDhtNetwork = {
      id: createId(),
      name,
      bootstrapNodes
    };

    await saveDhtPreference({
      selectedNetworkId,
      customNetworks: [...customNetworks, newNetwork]
    });

    setNameInput('');
    setBootstrapInput('');
  };

  const deleteNetwork = async (networkId: string) => {
    const nextNetworks = customNetworks.filter(network => network.id !== networkId);

    await saveDhtPreference({
      selectedNetworkId: selectedNetworkId === networkId ? DEFAULT_NETWORK_ID : selectedNetworkId,
      customNetworks: nextNetworks
    });
  };

  const renderSelectButton = (networkId: string) => {
    const selected = selectedNetworkId === networkId;

    return (
      <button
        className={`${selected ? 'orange' : 'submit'} pad-4`}
        onClick={() => selectNetwork(networkId)}
        disabled={selected}
      >
        {selected ? 'Selected' : 'Select'}
      </button>
    );
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content panel" style={{minWidth: '500px'}} onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title centered gap-6">DHT Network</h2>

        <div className="config-section flex-column">
          <h3 className="section-title">Add Custom Bootstrap Network</h3>

          <div className="input-group">
            <label>Network Name</label>
            <input
              type="text"
              className="config-input"
              value={nameInput}
              placeholder="My DHT Network"
              onChange={(e) => setNameInput(e.target.value)}
            />
          </div>

          <div className="input-group">
            <label>Bootstrap Nodes</label>
            <input
              type="text"
              className="config-input"
              value={bootstrapInput}
              placeholder="host1:port, host2:port"
              onChange={(e) => setBootstrapInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  void addNetwork();
                }
              }}
            />
          </div>

          <div className="grid-full-row width-100" style={{ gridColumn: '1 / -1' }}>
            <button
              className="mid submit width-100"
              onClick={addNetwork}
            >
              <Plus size={16} />
              Add Network
            </button>
          </div>
        </div>

        <div className="config-section flex-column">
          <h3 className="section-title">Available Networks</h3>

          <div className="width-100 flex-column gap-4">
            <ScrollableList
              items={[
                {
                  id: DEFAULT_NETWORK_ID,
                  name: 'Default HyperDHT Network',
                  bootstrapNodes: [],
                  isDefault: true
                },
                ...customNetworks.map(network => ({
                  ...network,
                  isDefault: false
                }))
              ]}
              renderItem={(network: any) => (
                <div
                  key={network.id}
                  className="card flex-row gap-6 centered"
                >
                  <div className="flex-column flex-grow gap-2">
                    <span>{network.name}</span>

                    {network.isDefault ? (
                      <span className="grey-text">
                        Uses the built-in public HyperDHT bootstrap network.
                      </span>
                    ) : (
                      <span className="grey-text mono">
                        {network.bootstrapNodes.join(', ')}
                      </span>
                    )}
                  </div>

                  {renderSelectButton(network.id)}

                  {!network.isDefault && (
                    <button
                      className="red pad-4"
                      onClick={() => deleteNetwork(network.id)}
                    >
                      <X size={16} />
                    </button>
                  )}
                </div>
              )}
            />
          </div>
        </div>

        <div className="modal-footer">
          <button className="mid light" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}