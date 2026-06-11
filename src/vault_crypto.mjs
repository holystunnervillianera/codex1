import { createCipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const SALT_BYTES = 16;

export function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function loadMasterKeyFromEnv(env = process.env) {
  const encoded = env.VAULT_MASTER_KEY_B64;
  if (!encoded) {
    throw new Error('VAULT_MASTER_KEY_B64 is required');
  }

  const key = Buffer.from(encoded, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error('VAULT_MASTER_KEY_B64 must decode to exactly 32 bytes');
  }

  return key;
}

export function deriveFileKey(masterKey, salt) {
  return scryptSync(masterKey, salt, KEY_BYTES, { N: 16384, r: 8, p: 1 });
}

export function encryptBuffer(plaintext, masterKey, additionalData = Buffer.alloc(0)) {
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const fileKey = deriveFileKey(masterKey, salt);
  const cipher = createCipheriv(ALGORITHM, fileKey, nonce);

  if (additionalData.length > 0) {
    cipher.setAAD(additionalData);
  }

  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext,
    encryption: {
      algorithm: ALGORITHM,
      kdf: 'scrypt',
      salt_b64: salt.toString('base64'),
      nonce_b64: nonce.toString('base64'),
      auth_tag_b64: authTag.toString('base64'),
      aad_sha256: sha256Hex(additionalData),
    },
  };
}

export async function encryptFile(filePath, masterKey) {
  const plaintext = await readFile(filePath);
  const plaintextSha256 = sha256Hex(plaintext);
  const aad = Buffer.from(plaintextSha256, 'utf8');
  const encrypted = encryptBuffer(plaintext, masterKey, aad);
  const ciphertextSha256 = sha256Hex(encrypted.ciphertext);

  return {
    plaintext,
    plaintextSha256,
    ciphertext: encrypted.ciphertext,
    ciphertextSha256,
    encryption: encrypted.encryption,
  };
}
