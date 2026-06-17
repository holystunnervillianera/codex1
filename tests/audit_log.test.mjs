import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordAuditEvent, loadLastLocalAuditHash } from '../src/audit_log.mjs';

const temp = await mkdtemp(join(tmpdir(), 'vault-audit-'));
const localAuditLog = join(temp, 'audit.jsonl');
const inserted = [];
const client = {
  async insert(table, row) {
    assert.equal(table, 'audit_events');
    inserted.push(row);
  },
};

const first = await recordAuditEvent({
  client,
  ownerId: '00000000-0000-0000-0000-000000000000',
  localAuditLog,
  previousHash: null,
  actor: 'test',
  action: 'created',
  subjectType: 'fixture',
  subjectId: '11111111-1111-1111-1111-111111111111',
  details: { ok: true },
});

const second = await recordAuditEvent({
  client,
  ownerId: '00000000-0000-0000-0000-000000000000',
  localAuditLog,
  previousHash: first.event_hash,
  actor: 'test',
  action: 'updated',
  subjectType: 'fixture',
  subjectId: '11111111-1111-1111-1111-111111111111',
  details: { ok: true },
});

assert.equal(inserted.length, 2);
assert.equal(second.previous_event_hash, first.event_hash);
assert.equal(await loadLastLocalAuditHash(localAuditLog), second.event_hash);
const lines = (await readFile(localAuditLog, 'utf8')).trim().split('\n');
assert.equal(lines.length, 2);
await rm(temp, { recursive: true, force: true });
console.log('audit log tests passed');
