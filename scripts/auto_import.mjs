#!/usr/bin/env node
import { readdir, stat } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { encryptFile, loadMasterKeyFromEnv } from '../src/vault_crypto.mjs';
import { loadLastLocalAuditHash, recordAuditEvent } from '../src/audit_log.mjs';
import { SupabaseRestClient, requiredEnv } from '../src/supabase_rest.mjs';

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

async function createImportRun(client, ownerId) {
  return await client.insert('import_runs', { owner_id: ownerId, status: 'started' });
}

async function completeImportRun(client, importRunId, statusValue, filesSeen, filesImported, errorMessage = null) {
  await client.patch('import_runs', `id=eq.${importRunId}`, {
    status: statusValue,
    completed_at: new Date().toISOString(),
    files_seen: filesSeen,
    files_imported: filesImported,
    error_message: errorMessage,
  });
}

async function findVaultObjectByPlaintextHash(client, ownerId, plaintextSha256) {
  const rows = await client.select('vault_objects', `owner_id=eq.${ownerId}&plaintext_sha256=eq.${plaintextSha256}&select=id,object_path`);
  return rows[0] ?? null;
}

async function importOnce({ client, source, masterKey, ownerId, bucket, localAuditLog }) {
  const importRun = await createImportRun(client, ownerId);
  const files = await walkFiles(source);
  let imported = 0;
  let previousHash = await loadLastLocalAuditHash(localAuditLog);

  try {
    for (const filePath of files) {
      const info = await stat(filePath);
      const encrypted = await encryptFile(filePath, masterKey);
      const relativePath = relative(source, filePath).replaceAll('\\', '/');
      const existingObject = await findVaultObjectByPlaintextHash(client, ownerId, encrypted.plaintextSha256);
      const objectPath = existingObject?.object_path ?? `${ownerId}/${encrypted.plaintextSha256}-${basename(filePath)}.enc`;
      let vaultObject = existingObject;
      let action = 'vault.object.duplicate_seen';

      if (!vaultObject) {
        await client.uploadObject(bucket, objectPath, encrypted.ciphertext);

        vaultObject = await client.insert('vault_objects', {
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

      const auditEvent = await recordAuditEvent({
        client,
        ownerId,
        localAuditLog,
        previousHash,
        actor: 'owner:auto_import',
        action,
        subjectType: 'vault_object',
        subjectId: vaultObject.id,
        details: {
          object_path: objectPath,
          original_name: relativePath,
          plaintext_sha256: encrypted.plaintextSha256,
          ciphertext_sha256: encrypted.ciphertextSha256,
        },
      });
      previousHash = auditEvent.event_hash;
    }

    await completeImportRun(client, importRun.id, 'completed', files.length, imported);
  } catch (error) {
    await completeImportRun(client, importRun.id, 'failed', files.length, imported, error.message);
    throw error;
  }

  return { seen: files.length, imported };
}

async function main() {
  const args = parseArgs(process.argv);
  const masterKey = loadMasterKeyFromEnv();
  const client = new SupabaseRestClient();
  requiredEnv('SUPABASE_URL');
  const ownerId = await client.currentUserId();
  const bucket = process.env.SUPABASE_RAW_BUCKET ?? 'vault-raw';
  const localAuditLog = process.env.VAULT_LOCAL_AUDIT_LOG ?? './vault-audit-local.jsonl';

  do {
    const result = await importOnce({
      client,
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
