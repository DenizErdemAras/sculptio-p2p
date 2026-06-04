import React, { createContext, useState, useEffect } from 'react';

export const DEFAULT_ROOM_CONFIG = {
  roomName: "Room Name",
  language: "Türkçe",
  playerLimit: 8,
  wordList: "türkçe",
  gameMode: 1,
  totalRounds: 3,
  turnDurationSeconds: 90,
  wordPickDurationSeconds: 20,
  visibilityStatus: "private",
  passwordEnabled: false,
  password: ""
};

export type CustomWordList = {
  id: string;
  name: string;
  words: string[];
};

export type CustomDhtNetwork = {
  id: string;
  name: string;
  bootstrapNodes: string[];
};

export type DhtNetworkPreference = {
  selectedNetworkId: string;
  customNetworks: CustomDhtNetwork[];
};

const DEFAULT_DHT_NETWORK_PREFERENCE: DhtNetworkPreference = {
  selectedNetworkId: 'default',
  customNetworks: []
};
const DEFAULT_CUSTOM_WORD_LISTS: CustomWordList[] = [];

export const UserContext = createContext<any>(null);

export const UserProvider = ({ children }: { children: React.ReactNode }) => {
  
  const [userData, setUserData] = useState({
    seed: '',
    publicKey: '',
    secretKey: '',
    username: 'Player',
    color: '',
    preferences: {
      moderation: {
        mode: 'disabled' as 'disabled' | 'blacklist' | 'whitelist',
        blacklist: [] as string[],
        whitelist: [] as string[],
      },
      latestRoomConfig: DEFAULT_ROOM_CONFIG,
      customWordLists: DEFAULT_CUSTOM_WORD_LISTS,
      dhtNetwork: DEFAULT_DHT_NETWORK_PREFERENCE
    }
  });
    
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    const loadData = async () => {
      const savedData = await window.api.readUserData();
      let needsSave = false;
      let currentSeed = savedData.seed;

      if (!currentSeed) {
        const array = new Uint8Array(32);
        window.crypto.getRandomValues(array);
        currentSeed = Array.from(array).map(b => b.toString(16).padStart(2, '0')).join('');
        
        savedData.seed = currentSeed;
        needsSave = true;
      }


      const keys = await window.api.getKeys(currentSeed);

      const normalizedData = {
        ...savedData,
        preferences: {
          ...(savedData.preferences ?? {}),
          moderation: {
            mode: savedData.preferences?.moderation?.mode ?? 'disabled',
            blacklist: savedData.preferences?.moderation?.blacklist ?? [],
            whitelist: savedData.preferences?.moderation?.whitelist ?? [],
          },
          latestRoomConfig: {
            ...DEFAULT_ROOM_CONFIG,
            ...(savedData.preferences?.latestRoomConfig ?? {}),
            visibilityStatus: "private"
          },
          customWordLists: Array.isArray(savedData.preferences?.customWordLists)
            ? savedData.preferences.customWordLists
            : DEFAULT_CUSTOM_WORD_LISTS,
          dhtNetwork: {
            selectedNetworkId: savedData.preferences?.dhtNetwork?.selectedNetworkId ?? 'default',
            customNetworks: Array.isArray(savedData.preferences?.dhtNetwork?.customNetworks)
              ? savedData.preferences.dhtNetwork.customNetworks
              : []
          }
        }
      };

      if (!Array.isArray(savedData.preferences?.customWordLists)) {
        needsSave = true;
      }

      if (needsSave) {
        const { publicKey, secretKey, ...dataToSave } = normalizedData as any;
        await window.api.writeUserData(dataToSave);
      }

      setUserData(prev => ({ 
        ...prev, 
        ...normalizedData, 
        publicKey: keys.publicKey,
        secretKey: keys.secretKey 
      }));
      
      setIsLoaded(true);
    };

    loadData();
  }, []);

  const updateUserData = async (updates: Partial<typeof userData>) => {
  const newUserData = { ...userData, ...updates };
  setUserData(newUserData); 
  
  const { publicKey, secretKey, ...dataToSave } = newUserData;
  
  await window.api.writeUserData(dataToSave);
};

  if (!isLoaded) {
    return <div style={{ color: 'white', padding: '20px' }}>Loading Sculptionary Profile...</div>;
  }

  return (
    <UserContext.Provider value={{ userData, updateUserData }}>
      {children}
    </UserContext.Provider>
  );
};