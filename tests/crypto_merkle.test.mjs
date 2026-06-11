import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { encryptBuffer, sha256Hex } from '../src/vault_crypto.mjs';
import { chainedAuditHash, merkleRoot } from '../src/merkle.mjs';

const masterKey = randomBytes(32);
const plaintext = Buffer.from('private sovereign vault fixture');
const encrypted = encryptBuffer(plaintext, masterKey, Buffer.from('fixture'));

assert.equal(encrypted.encryption.algorithm, 'aes-256-gcm');
assert.equal(encrypted.ciphertext.equals(plaintext), false);
assert.match(sha256Hex(encrypted.ciphertext), /^[a-f0-9]{64}$/);

const first = chainedAuditHash(null, { action: 'one', subject_id: 'fixture' });
const second = chainedAuditHash(first, { action: 'two', subject_id: 'fixture' });
const root = merkleRoot([first, second]);

assert.match(first, /^[a-f0-9]{64}$/);
assert.match(second, /^[a-f0-9]{64}$/);
assert.match(root, /^[a-f0-9]{64}$/);
assert.notEqual(first, second);

console.log('crypto and merkle tests passed');
