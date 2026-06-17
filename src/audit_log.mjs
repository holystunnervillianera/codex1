import { appendFile, readFile } from 'node:fs/promises';
import { chainedAuditHash } from './merkle.mjs';

export async function loadLastLocalAuditHash(localAuditLog) {
  try {
    const log = await readFile(localAuditLog, 'utf8');
    const lines = log.trim().split('\n').filter(Boolean);
    return lines.length === 0 ? null : JSON.parse(lines.at(-1)).event_hash ?? null;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function appendLocalAudit(localAuditLog, event) {
  await appendFile(localAuditLog, `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

export async function recordAuditEvent({ client, ownerId, localAuditLog, previousHash, actor, action, subjectType, subjectId, details }) {
  const eventCore = {
    owner_id: ownerId,
    actor,
    action,
    subject_type: subjectType,
    subject_id: subjectId,
    details,
    previous_event_hash: previousHash,
  };
  const eventHash = chainedAuditHash(previousHash, eventCore);
  const auditEvent = { ...eventCore, event_hash: eventHash };
  await client.insert('audit_events', auditEvent, { returning: false });
  if (localAuditLog) {
    await appendLocalAudit(localAuditLog, auditEvent);
  }
  return auditEvent;
}
