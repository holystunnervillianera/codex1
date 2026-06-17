#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { chainedAuditHash, merkleRoot } from '../src/merkle.mjs';
import { SupabaseRestClient } from '../src/supabase_rest.mjs';

function usage() {
  return `Usage:
  node scripts/vaultctl.mjs enqueue-ai --object-id UUID --job-type metadata_extract|classify|summarize
  node scripts/vaultctl.mjs anchor-audit --chain CHAIN --transaction-id TX_ID [--limit 1000]
  node scripts/vaultctl.mjs verify-local-audit --file ./vault-audit-local.jsonl
`;
}

function parseArgs(argv) {
  const [command, ...rest] = argv.slice(2);
  const args = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg.startsWith('--')) {
      args[arg.slice(2).replaceAll('-', '_')] = rest[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!command) {
    throw new Error(usage());
  }
  return args;
}

function requireArg(args, name) {
  if (!args[name]) {
    throw new Error(`--${name.replaceAll('_', '-')} is required\n${usage()}`);
  }
  return args[name];
}

async function enqueueAi(client, ownerId, args) {
  const objectId = requireArg(args, 'object_id');
  const jobType = requireArg(args, 'job_type');
  if (!['metadata_extract', 'classify', 'summarize'].includes(jobType)) {
    throw new Error('Only local zero-leakage job types are supported here: metadata_extract, classify, summarize');
  }
  const job = await client.insert('ai_jobs', {
    owner_id: ownerId,
    input_object_id: objectId,
    job_type: jobType,
    provider_label: 'local',
    policy: { allow_public_ai: false, plaintext_may_leave_owner_device: false },
  });
  return { queued: job.id };
}

async function anchorAudit(client, ownerId, args) {
  const chain = requireArg(args, 'chain');
  const transactionId = requireArg(args, 'transaction_id');
  const limit = Number(args.limit ?? 1000);
  const events = await client.select('audit_events', `owner_id=eq.${ownerId}&order=local_sequence.asc&limit=${limit}&select=event_hash`);
  if (events.length === 0) {
    throw new Error('No audit events to anchor');
  }
  const hashes = events.map((event) => event.event_hash);
  const root = merkleRoot(hashes);
  const anchor = await client.insert('audit_anchors', {
    owner_id: ownerId,
    from_event_hash: hashes[0],
    to_event_hash: hashes.at(-1),
    merkle_root: root,
    chain,
    transaction_id: transactionId,
    notes: 'Root anchored after operator submitted the Merkle root to the named chain/wallet.',
  });
  return { anchor_id: anchor.id, merkle_root: root, events: hashes.length };
}

async function verifyLocalAudit(args) {
  const file = requireArg(args, 'file');
  const lines = (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean);
  let previous = null;
  let count = 0;
  for (const line of lines) {
    const event = JSON.parse(line);
    if (event.previous_event_hash !== previous) {
      throw new Error(`Hash chain break at line ${count + 1}: expected previous ${previous}, got ${event.previous_event_hash}`);
    }
    const { event_hash: eventHash, ...eventCore } = event;
    const expectedHash = chainedAuditHash(previous, eventCore);
    if (eventHash !== expectedHash) {
      throw new Error(`Event hash mismatch at line ${count + 1}: expected ${expectedHash}, got ${eventHash}`);
    }
    previous = eventHash;
    count += 1;
  }
  return { verified: true, events: count, last_event_hash: previous };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.command === 'verify-local-audit') {
    console.log(JSON.stringify(await verifyLocalAudit(args), null, 2));
    return;
  }

  const client = new SupabaseRestClient();
  const ownerId = await client.currentUserId();
  if (args.command === 'enqueue-ai') {
    console.log(JSON.stringify(await enqueueAi(client, ownerId, args), null, 2));
    return;
  }
  if (args.command === 'anchor-audit') {
    console.log(JSON.stringify(await anchorAudit(client, ownerId, args), null, 2));
    return;
  }
  throw new Error(usage());
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
