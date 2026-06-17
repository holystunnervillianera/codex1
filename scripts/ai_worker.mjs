#!/usr/bin/env node
import { basename } from 'node:path';
import { decryptBuffer, encryptBuffer, loadMasterKeyFromEnv, sha256Hex } from '../src/vault_crypto.mjs';
import { loadLastLocalAuditHash, recordAuditEvent } from '../src/audit_log.mjs';
import { SupabaseRestClient } from '../src/supabase_rest.mjs';

function parseArgs(argv) {
  const args = { limit: 5 };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--limit') {
      args.limit = Number(argv[++index]);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 50) {
    throw new Error('--limit must be an integer from 1 to 50');
  }
  return args;
}

function asUtf8Text(buffer) {
  const text = buffer.toString('utf8');
  if (text.includes('\u0000')) {
    return null;
  }
  return text;
}

function summarizeText(text) {
  return text.replace(/\s+/g, ' ').trim().slice(0, 2000);
}

function classifyText(text) {
  const lower = text.toLowerCase();
  const labels = [];
  for (const [label, terms] of Object.entries({
    finance: ['invoice', 'receipt', 'payment', 'bank', 'tax'],
    identity: ['passport', 'license', 'ssn', 'social security'],
    legal: ['contract', 'agreement', 'terms', 'signature'],
    health: ['medical', 'patient', 'doctor', 'prescription'],
  })) {
    if (terms.some((term) => lower.includes(term))) {
      labels.push(label);
    }
  }
  return labels.length > 0 ? labels : ['unclassified'];
}

function processLocally(job, plaintext, object) {
  const text = asUtf8Text(plaintext);
  const result = {
    job_id: job.id,
    job_type: job.job_type,
    input_object_id: object.id,
    input_name: object.original_name,
    processed_at: new Date().toISOString(),
    plaintext_sha256: object.plaintext_sha256,
  };

  if (job.job_type === 'metadata_extract') {
    return Buffer.from(JSON.stringify({
      ...result,
      byte_size: plaintext.length,
      detected_text: text !== null,
      preview: text === null ? null : summarizeText(text).slice(0, 500),
    }, null, 2));
  }

  if (job.job_type === 'classify') {
    if (text === null) {
      return Buffer.from(JSON.stringify({ ...result, labels: ['binary'], confidence: 'heuristic' }, null, 2));
    }
    return Buffer.from(JSON.stringify({ ...result, labels: classifyText(text), confidence: 'heuristic' }, null, 2));
  }

  if (job.job_type === 'summarize') {
    if (text === null) {
      throw new Error('summarize only supports UTF-8 text inputs in the local zero-leakage worker');
    }
    return Buffer.from(JSON.stringify({ ...result, summary: summarizeText(text) }, null, 2));
  }

  throw new Error(`Unsupported local job type: ${job.job_type}`);
}

async function fetchVaultObject(client, id) {
  const rows = await client.select('vault_objects', `id=eq.${id}&select=*`);
  if (!rows[0]) {
    throw new Error(`Vault object not found: ${id}`);
  }
  return rows[0];
}

async function processJob({ client, ownerId, masterKey, localAuditLog, job }) {
  await client.patch('ai_jobs', `id=eq.${job.id}`, {
    status: 'running',
    started_at: new Date().toISOString(),
  });

  let previousHash = await loadLastLocalAuditHash(localAuditLog);

  try {
    const inputObject = await fetchVaultObject(client, job.input_object_id);
    const ciphertext = await client.downloadObject(inputObject.bucket_name, inputObject.object_path);
    const plaintext = decryptBuffer(ciphertext, masterKey, inputObject.encryption, Buffer.from(inputObject.plaintext_sha256, 'utf8'));
    const actualSha256 = sha256Hex(plaintext);
    if (actualSha256 !== inputObject.plaintext_sha256) {
      throw new Error(`Input hash mismatch: expected ${inputObject.plaintext_sha256}, got ${actualSha256}`);
    }

    const outputPlaintext = processLocally(job, plaintext, inputObject);
    const outputPlaintextSha256 = sha256Hex(outputPlaintext);
    const encryptedOutput = encryptBuffer(outputPlaintext, masterKey, Buffer.from(outputPlaintextSha256, 'utf8'));
    const outputCiphertextSha256 = sha256Hex(encryptedOutput.ciphertext);
    const bucket = process.env.SUPABASE_PROCESSED_BUCKET ?? 'vault-processed';
    const objectPath = `${ownerId}/${outputPlaintextSha256}-${basename(inputObject.original_name)}.${job.job_type}.json.enc`;

    await client.uploadObject(bucket, objectPath, encryptedOutput.ciphertext);
    const outputObject = await client.insert('vault_objects', {
      owner_id: ownerId,
      parent_object_id: inputObject.id,
      original_name: `${inputObject.original_name}.${job.job_type}.json`,
      object_path: objectPath,
      bucket_name: bucket,
      mime_type: 'application/json',
      byte_size: outputPlaintext.length,
      plaintext_sha256: outputPlaintextSha256,
      ciphertext_sha256: outputCiphertextSha256,
      encryption: encryptedOutput.encryption,
      status: 'processed',
      tags: [job.job_type, 'ai-generated', 'local-only'],
      metadata: {
        generated_by: 'scripts/ai_worker.mjs',
        input_object_id: inputObject.id,
        ai_job_id: job.id,
      },
    });

    await client.patch('ai_jobs', `id=eq.${job.id}`, {
      status: 'completed',
      output_object_id: outputObject.id,
      completed_at: new Date().toISOString(),
      result: { output_object_id: outputObject.id, local_only: true },
    });

    const auditEvent = await recordAuditEvent({
      client,
      ownerId,
      localAuditLog,
      previousHash,
      actor: 'owner:ai_worker',
      action: 'vault.ai_job.completed',
      subjectType: 'ai_job',
      subjectId: job.id,
      details: {
        input_object_id: inputObject.id,
        output_object_id: outputObject.id,
        job_type: job.job_type,
        provider_label: job.provider_label,
        local_only: true,
      },
    });
    previousHash = auditEvent.event_hash;
    return { job_id: job.id, status: 'completed', event_hash: previousHash };
  } catch (error) {
    await client.patch('ai_jobs', `id=eq.${job.id}`, {
      status: 'failed',
      completed_at: new Date().toISOString(),
      error_message: error.message,
    });
    await recordAuditEvent({
      client,
      ownerId,
      localAuditLog,
      previousHash,
      actor: 'owner:ai_worker',
      action: 'vault.ai_job.failed',
      subjectType: 'ai_job',
      subjectId: job.id,
      details: { error_message: error.message, job_type: job.job_type },
    });
    throw error;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const client = new SupabaseRestClient();
  const ownerId = await client.currentUserId();
  const masterKey = loadMasterKeyFromEnv();
  const localAuditLog = process.env.VAULT_LOCAL_AUDIT_LOG ?? './vault-audit-local.jsonl';
  const jobs = await client.select('ai_jobs', `owner_id=eq.${ownerId}&status=eq.queued&provider_label=eq.local&order=created_at.asc&limit=${args.limit}&select=*`);
  const results = [];

  for (const job of jobs) {
    results.push(await processJob({ client, ownerId, masterKey, localAuditLog, job }));
  }

  console.log(JSON.stringify({ processed: results.length, results }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
