const crypto = require('crypto');

// 1. Generate Seed
// const DEV_SEED_HEX = crypto.randomBytes(32).toString('hex');
const DEV_SEED_HEX = 'f32d4d9de2899dcbb94c9bfc533140af626e9b941496667531db2b012896d538';
const seedBuffer = Buffer.from(DEV_SEED_HEX, 'hex');

// 2. Wrap seed so Node accepts it
const pkcs8Header = Buffer.from('302e020100300506032b657004220420', 'hex');
const pkcs8Key = Buffer.concat([pkcs8Header, seedBuffer]);
const privateKey = crypto.createPrivateKey({ key: pkcs8Key, format: 'der', type: 'pkcs8' });

// 3. Get Public Key (Export as standard DER, drop the 12-byte header to get raw 32-bytes)
const publicKey = crypto.createPublicKey(privateKey);
const rawPublicKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);

// 4. Sign the version string
const APP_VERSION = "1.0.0";
const signature = crypto.sign(null, Buffer.from(APP_VERSION, 'utf-8'), privateKey);

// 5. Output
console.log(`\n// --- 🛑 SAVE THIS SOMEWHERE SAFE 🛑 ---`);
console.log(`const DEV_SEED = '${DEV_SEED_HEX}';\n`);

console.log(`// --- 📋 COPY THIS INTO protocol.ts 📋 ---`);
console.log(`export const DEV_PUBLIC_KEY = Buffer.from('${rawPublicKey.toString('hex')}', 'hex');`);
console.log(`export const APP_VERSION = "${APP_VERSION}";`);
console.log(`export const V1_SIGNATURE = Buffer.from('${signature.toString('hex')}', 'hex');\n`);