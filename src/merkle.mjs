import { createHash } from 'node:crypto';

export function hashHex(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

export function auditEventHash(event) {
  return hashHex(canonicalJson(event));
}

export function chainedAuditHash(previousEventHash, event) {
  return hashHex(`${previousEventHash ?? 'GENESIS'}:${auditEventHash(event)}`);
}

export function merkleRoot(hashes) {
  if (!Array.isArray(hashes) || hashes.length === 0) {
    throw new Error('merkleRoot requires at least one hash');
  }

  let level = hashes.map((hash) => {
    if (!/^[a-f0-9]{64}$/.test(hash)) {
      throw new Error(`invalid sha256 hash: ${hash}`);
    }
    return hash;
  });

  while (level.length > 1) {
    const next = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index];
      const right = level[index + 1] ?? left;
      next.push(hashHex(`${left}${right}`));
    }
    level = next;
  }

  return level[0];
}
