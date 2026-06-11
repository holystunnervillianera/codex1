#!/usr/bin/env node
import { appendFile, readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { encryptFile, loadMasterKeyFromEnv, sha256Hex } from '../src/vault_crypto.mjs';
import { chainedAuditHash } from '../src/merkle.mjs';

function parseArgs(argv) {
  const args = {
    intervalMinutes: 5,
    once: false,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--source') {
      args.source = argv[++index];
    } else if (arg === '--interval-minutes') {
      args.intervalMinutes = Number(argv[++index]);
    } else if (arg === '--once') {
      args.once = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.source) {
    throw new Error('--source is required');
  }

  if (![5, 10].includes(args.intervalMinutes)) {
    throw new Error('--interval-minutes must be 5 or 10');
  }

  return args;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function walkFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

async function supabaseFetch(path, options = {}) {
  const supabaseUrl = requiredEnv('SUPABASE_URL').replace(/\/$/, '');
  const anonKey = requiredEnv('SUPABASE_ANON_KEY');
  const accessToken = requiredEnv('SUPABASE_ACCESS_TOKEN');

  const response = await fetch(`${supabaseUrl}${path}`, {
    ...options,
    headers: {
      apikey: anonKey,
      authorization: `Bearer ${accessToken}`,
      ...(options.headers ?? {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Supabase request failed ${response.status}: ${body}`);
  }

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function currentUserId() {
  const user = await supabaseFetch('/auth/v1/user');
  if (!user?.id) {
    throw new Error('Could not resolve authenticated Supabase user id');
  }
  return user.id;
}

async function loadLastAuditHash(localAuditLog) {
  try {
    const log = await readFile(localAuditLog, 'utf8');
    const lines = log.trim().split('\n').filter(Boolean);
    if (lines.length === 0) {
      return null;
    }
    return JSON.parse(lines.at(-1)).event_hash ?? null;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function appendLocalAudit(localAuditLog, event) {
  await appendFile(localAuditLog, `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

async function createImportRun(ownerId) {
  const rows = await supabaseFetch('/rest/v1/import_runs', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      prefer: 'return=representation',
    },
    body: JSON.stringify({ owner_id: ownerId, status: 'started' }),
  });
  return rows[0];
}

async function completeImportRun(importRunId, statusValue, filesSeen, filesImported, errorMessage = null) {
  await supabaseFetch(`/rest/v1/import_runs?id=eq.${importRunId}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      status: statusValue,
      completed_at: new Date().toISOString(),
      files_seen: filesSeen,
      files_imported: filesImported,
      error_message: errorMessage,
    }),
  });
}

async function uploadCiphertext(bucket, objectPath, ciphertext) {
  await supabaseFetch(`/storage/v1/object/${bucket}/${objectPath}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'x-upsert': 'false',
    },
    body: ciphertext,
  });
}

async function findVaultObjectByPlaintextHash(ownerId, plaintextSha256) {
  const rows = await supabaseFetch(`/rest/v1/vault_objects?owner_id=eq.${ownerId}&plaintext_sha256=eq.${plaintextSha256}&select=id,object_path`);
  return rows[0] ?? null;
}

async function insertVaultObject(row) {
  const rows = await supabaseFetch('/rest/v1/vault_objects', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      prefer: 'return=representation',
    },
    body: JSON.stringify(row),
  });
  return rows[0];
}

async function insertAuditEvent(row) {
  await supabaseFetch('/rest/v1/audit_events', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(row),
  });
}

async function importOnce({ source, masterKey, ownerId, bucket, localAuditLog }) {
  const importRun = await createImportRun(ownerId);
  const files = await walkFiles(source);
  let imported = 0;
  let previousHash = await loadLastAuditHash(localAuditLog);

  try {
    for (const filePath of files) {
      const info = await stat(filePath);
      const encrypted = await encryptFile(filePath, masterKey);
      const relativePath = relative(source, filePath).replaceAll('\\', '/');
      const existingObject = await findVaultObjectByPlaintextHash(ownerId, encrypted.plaintextSha256);
      const objectPath = existingObject?.object_path ?? `${ownerId}/${encrypted.plaintextSha256}-${basename(filePath)}.enc`;
      let vaultObject = existingObject;
      let action = 'vault.object.duplicate_seen';

      if (!vaultObject) {
        await uploadCiphertext(bucket, objectPath, encrypted.ciphertext);

        vaultObject = await insertVaultObject({
          owner_id: ownerId,
          import_run_id: importRun.id,
          original_name: relativePath,
          object_path: objectPath,
          bucket_name: bucket,
          byte_size: info.size,
          plaintext_sha256: encrypted.plaintextSha256,
          ciphertext_sha256: encrypted.ciphertextSha256,
          encryption: encrypted.encryption,
          metadata: {
            imported_by: 'scripts/auto_import.mjs',
            source_relative_path: relativePath,
            imported_at: new Date().toISOString(),
          },
        });
        action = 'vault.object.imported';
        imported += 1;
      }

      const eventCore = {
        owner_id: ownerId,
        actor: 'owner:auto_import',
        action,
        subject_type: 'vault_object',
        subject_id: vaultObject.id,
        details: {
          object_path: objectPath,
          original_name: relativePath,
          plaintext_sha256: encrypted.plaintextSha256,
          ciphertext_sha256: encrypted.ciphertextSha256,
        },
        previous_event_hash: previousHash,
      };
      const eventHash = chainedAuditHash(previousHash, eventCore);
      const auditEvent = { ...eventCore, event_hash: eventHash };

      await insertAuditEvent(auditEvent);
      await appendLocalAudit(localAuditLog, auditEvent);
      previousHash = eventHash;
    }

    await completeImportRun(importRun.id, 'completed', files.length, imported);
  } catch (error) {
    await completeImportRun(importRun.id, 'failed', files.length, imported, error.message);
    throw error;
  }

  return { seen: files.length, imported };
}

async function main() {
  const args = parseArgs(process.argv);
  const masterKey = loadMasterKeyFromEnv();
  const ownerId = await currentUserId();
  const bucket = process.env.SUPABASE_RAW_BUCKET ?? 'vault-raw';
  const localAuditLog = process.env.VAULT_LOCAL_AUDIT_LOG ?? './vault-audit-local.jsonl';

  do {
    const result = await importOnce({
      source: args.source,
      masterKey,
      ownerId,
      bucket,
      localAuditLog,
    });
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      source: args.source,
      interval_minutes: args.intervalMinutes,
      ...result,
    }));

    if (args.once) {
      break;
    }

    await sleep(args.intervalMinutes * 60 * 1000);
  } while (true);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
