# Sovereign Vault Architecture

## Goals

The vault is designed for one-owner control over files, assets, raw uploads, derived outputs, AI processing records, administrative activity, and long-term auditability.

Primary properties:

- **Zero telemetry:** application code sends no analytics, crash reports, tracking pixels, or third-party beacons.
- **Zero leakage by default:** files are encrypted before upload; metadata is minimized; private buckets and RLS are mandatory.
- **Zero trust:** Supabase, storage, AI workers, and blockchain nodes are treated as untrusted transport or persistence layers.
- **Sovereign control:** keys, import schedules, AI endpoints, wallets, and retention policy remain under your control.
- **Tamper evidence:** audit events are append-only and hash-chained; roots can be blockchain anchored.

## High-level components

```text
Import Sources ──► Local Import Runner ──► Client-side Encryption ──► Supabase Storage
                         │                         │                         │
                         │                         ▼                         ▼
                         └──────────────► Append-only Audit Events ◄── Vault Metadata
                                                   │
                                                   ▼
                                         Blockchain Anchor Root
                                                   │
                                                   ▼
                                      Private AI Worker / Admin UI
```

## Data flow

1. A source folder, Proton export, Proton Drive sync folder, or Proton Bridge mailbox emits files into a local inbox.
2. `scripts/auto_import.mjs` scans the inbox every 5 or 10 minutes.
3. Each file is hashed locally with SHA-256.
4. File bytes are encrypted locally using AES-256-GCM and a key derived from `VAULT_MASTER_KEY_B64` plus a per-file salt.
5. Ciphertext is uploaded to a private Supabase Storage bucket.
6. Minimal metadata is inserted into `vault_objects`.
7. An `audit_events` row records the action, previous event hash, and current event hash.
8. A scheduled anchoring process periodically computes a Merkle root over audit hashes and writes it to `audit_anchors` with a blockchain transaction id.
9. AI jobs are represented as `ai_jobs` rows and should be processed by a private worker that decrypts locally, transforms locally, re-encrypts outputs, and writes a new audit event.

## Supabase boundaries

Supabase is used for authentication, private storage, metadata, and append-only audit records. It is not trusted with plaintext file contents.

Mandatory controls:

- Row-level security enabled on every vault table.
- Policies restrict rows to `owner_id = auth.uid()`.
- Storage buckets are private.
- Storage object names include an owner namespace.
- Service-role keys are never placed in client-side code or import configuration.
- Database triggers prevent updates or deletes on audit tables.

## Proton ingestion patterns

Use one of these privacy-preserving patterns:

1. **Proton Drive sync folder:** configure the import runner to watch the local synced folder.
2. **Proton Mail export:** export mail or attachments locally, then point the import runner at the export directory.
3. **Proton Bridge:** expose a local mailbox, export attachments to a local inbox, and import from there.

Avoid giving a hosted worker direct access to Proton credentials. Keep Proton sessions local to devices you control.

## Sovereign AI management

AI processing is split from ingestion:

- `ai_jobs` records desired work, status, model/provider label, input object, output object, and policy metadata.
- A private worker polls jobs for your user only.
- The worker decrypts inputs locally, performs AI processing locally or on your private endpoint, encrypts outputs, uploads ciphertext, and appends audit events.
- The schema supports upgrade/cleanup/classification workflows for messy/raw uploads without exposing plaintext to Supabase.

Recommended AI modes:

| Mode | Privacy posture | Use case |
| --- | --- | --- |
| Local model only | Strongest | OCR, classification, metadata extraction, summarization on private hardware |
| Private VPC endpoint | Strong | Larger models behind your own network boundary |
| Public API | Weak unless explicitly accepted | Only for files you choose to disclose |

## Immutable activity record

The vault combines multiple mechanisms:

- `audit_events` is append-only through database triggers.
- Each event stores `previous_event_hash` and `event_hash`.
- Local JSONL audit mirrors can be written by import tools.
- Periodic Merkle roots are recorded in `audit_anchors`.
- Blockchain transaction ids provide external timestamping and tamper evidence.

This makes alteration detectable even if a database administrator attempts to rewrite records, provided you retain anchored roots or local audit mirrors.

## Operational hardening checklist

- Use a dedicated Supabase project for this vault.
- Disable unused auth providers.
- Require MFA on your Supabase account.
- Keep `.env` out of git.
- Rotate JWT/session tokens periodically.
- Back up encrypted Supabase Storage objects to offline media.
- Back up local key material separately from ciphertext.
- Test restore procedures quarterly.
- Run imports from a locked-down machine with full-disk encryption.
- Review `audit_events` and anchored roots regularly.

## Production workers

The repository now includes three production-oriented entry points:

- `scripts/auto_import.mjs` continuously imports from local/Proton-synced folders on a strict 5 or 10 minute cadence.
- `scripts/ai_worker.mjs` processes queued `ai_jobs` locally, decrypts only on the owner-controlled host, and re-encrypts derived JSON outputs before upload.
- `scripts/vaultctl.mjs` queues AI jobs, records blockchain audit anchors, and verifies the local JSONL hash chain.

The AI worker intentionally supports only local zero-leakage jobs by default. Public or hosted AI processing must be represented with an explicit policy flag and should be reviewed per object.

## Recovery and verification

A production deployment should retain three independent recovery materials:

1. The local or hardware-protected vault master key.
2. Encrypted Supabase Storage object backups and database dumps.
3. Local JSONL audit mirrors plus blockchain transaction ids for anchored Merkle roots.

To verify continuity, run `vaultctl verify-local-audit` against the local JSONL mirror and compare anchored Merkle roots in `audit_anchors` with independent blockchain records.
