import c from 'compact-encoding';

export const DEV_PUBLIC_KEY = Buffer.from('dfb8401db3df6809a6756cb77a1ce22c25a3500eae1d1693b83bdb364ce956f1', 'hex');
export const APP_VERSION = "1.0.0";
export const V1_SIGNATURE = Buffer.from('0f589e31162be00a22352b40e3add8c45d7978a5e9803a1c288ef91db89b1e22dddc617e8a89b0dd692f63d45500d75238472106c30fb2f11151eb8a1328340b', 'hex');

export const MSG_TYPE = {
  REQUEST_ROOMS: 0x01,
  ROOM_GOSSIP: 0x02,
  VERSION_GOSSIP: 0x03
};

export const ROOM_GOSSIP_KIND = {
    UPSERT: 0,
    REMOVE: 1
};

export const roomSchema = {
    preencode(state: any, m: any) {
        c.uint8.preencode(state, m.kind);
        c.buffer.preencode(state, m.publicKey);
        c.uint32.preencode(state, m.seq);
        c.uint8.preencode(state, m.userLimit);
        c.uint8.preencode(state, m.currPlayers);
        c.string.preencode(state, m.roomName);
        c.string.preencode(state, m.hostName);
        c.buffer.preencode(state, m.hostPublicKey);
        c.uint8.preencode(state, m.hasPassword ? 1 : 0);
        c.string.preencode(state, m.language);
        c.string.preencode(state, m.version);
        c.buffer.preencode(state, m.signature);
    },
    encode(state: any, m: any) {
        c.uint8.encode(state, m.kind);
        c.buffer.encode(state, m.publicKey);
        c.uint32.encode(state, m.seq);
        c.uint8.encode(state, m.userLimit);
        c.uint8.encode(state, m.currPlayers);
        c.string.encode(state, m.roomName);
        c.string.encode(state, m.hostName);
        c.buffer.encode(state, m.hostPublicKey);
        c.uint8.encode(state, m.hasPassword ? 1 : 0);
        c.string.encode(state, m.language);
        c.string.encode(state, m.version);
        c.buffer.encode(state, m.signature);
    },
    decode(state: any) {
        return {
            kind: c.uint8.decode(state),
            publicKey: c.buffer.decode(state),
            seq: c.uint32.decode(state),
            userLimit: c.uint8.decode(state),
            currPlayers: c.uint8.decode(state),
            roomName: c.string.decode(state),
            hostName: c.string.decode(state),
            hostPublicKey: c.buffer.decode(state),
            hasPassword: c.uint8.decode(state) === 1,
            language: c.string.decode(state),
            version: c.string.decode(state),
            signature: c.buffer.decode(state)
        };
    }
};

export const versionSchema = {
  preencode(state: any, m: any) {
    c.string.preencode(state, m.version);
    c.buffer.preencode(state, m.signature);
  },
  encode(state: any, m: any) {
    c.string.encode(state, m.version);
    c.buffer.encode(state, m.signature);
  },
  decode(state: any) {
    return {
      version: c.string.decode(state),
      signature: c.buffer.decode(state)
    };
  }
};