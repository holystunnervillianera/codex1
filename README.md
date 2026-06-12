# Sovereign Vault Starter

A privacy-first, zero-telemetry, self-controlled data/file/asset vault blueprint built around:

- **Supabase** for authenticated metadata, row-level security, and private object storage.
- **Client-side encryption** so raw files are encrypted before leaving your machine.
- **Append-only audit logging** with hash chaining and optional blockchain anchoring for tamper evidence.
- **Proton-friendly ingestion** patterns for email/export/import workflows without third-party telemetry.
- **Sovereign AI management** where AI processing runs only on encrypted/private inputs you explicitly authorize.

> Important: no internet system can honestly guarantee absolute “undeletable” or “unalterable” records. This starter implements practical immutability: append-only database controls, cryptographic hash chains, retained encrypted blobs, and external blockchain anchoring so manipulation or deletion becomes detectable.

## What is included

| Area | Files |
| --- | --- |
| Architecture and operations | [`docs/architecture.md`](docs/architecture.md), [`docs/threat-model.md`](docs/threat-model.md) |
| Supabase schema and RLS | [`supabase/migrations/0001_sovereign_vault.sql`](supabase/migrations/0001_sovereign_vault.sql) |
| Client-side encryption helpers | [`src/vault_crypto.mjs`](src/vault_crypto.mjs) |
| Hash-chain / Merkle helpers | [`src/merkle.mjs`](src/merkle.mjs) |
| Constant auto-import runner | [`scripts/auto_import.mjs`](scripts/auto_import.mjs) |
| Local configuration template | [`.env.example`](.env.example) |

## Core security model

1. You are the only Supabase authenticated user allowed to read or write your records.
2. Files are encrypted locally using AES-256-GCM before upload.
3. Supabase Storage receives ciphertext only.
4. Every upload, import, AI job, admin action, and retention event is recorded in an append-only audit log.
5. Audit events are chained with SHA-256 hashes; periodic root hashes can be anchored on a blockchain transaction that you control.
6. AI processing jobs are staged explicitly and can be run locally or against a private model endpoint; plaintext should never be sent to public AI APIs unless you deliberately configure that endpoint.
7. The import runner is telemetry-free: no analytics, no remote logging, no phone-home calls.

## Quick start

1. Create a private Supabase project.
2. Run the SQL migration in `supabase/migrations/0001_sovereign_vault.sql`.
3. Create private storage buckets named `vault-raw` and `vault-processed`.
4. Copy `.env.example` to `.env` and fill in your values.
5. Generate a local master key:

   ```bash
   openssl rand -base64 32
   ```

6. Start a 5-minute local import loop:

   ```bash
   node scripts/auto_import.mjs --source ~/VaultInbox --interval-minutes 5
   ```

7. Start a 10-minute local import loop:

   ```bash
   node scripts/auto_import.mjs --source ~/VaultInbox --interval-minutes 10
   ```

## Recommended deployment posture

- Use a dedicated device or hardened VPS that only you administer.
- Enable hardware-backed full-disk encryption.
- Store the vault master key outside the repository in a password manager or hardware security module.
- Enable Supabase MFA and use a project with no public anonymous access beyond the RLS rules in this repo.
- Use Proton exports, Proton Drive sync folders, or Proton Bridge local mailboxes as import sources. Keep OAuth tokens and mailbox passwords outside the repository.
- Anchor audit roots to a blockchain from a wallet you control; store the transaction id in `audit_anchors`.

## Next implementation steps

This starter intentionally avoids pretending to solve every integration in one commit. The safest production path is incremental:

1. Apply and test Supabase RLS with your real account id.
2. Run local imports against a test bucket.
3. Add a private AI worker that pulls `ai_jobs`, decrypts locally, processes locally, encrypts outputs, and writes append-only audit events.
4. Add blockchain anchoring using your selected chain and wallet.
5. Add Proton-specific import adapters for the exact Proton product/export mechanism you use.

## Production command set

Run all validation checks:

```bash
npm test
```

Queue a local-only AI job for an imported object:

```bash
node scripts/vaultctl.mjs enqueue-ai --object-id OBJECT_UUID --job-type metadata_extract
```

Process queued local AI jobs without public AI calls:

```bash
node scripts/ai_worker.mjs --limit 5
```

Anchor an audit Merkle root after you publish the displayed root with your own wallet/tooling:

```bash
node scripts/vaultctl.mjs anchor-audit --chain ethereum --transaction-id 0xYOUR_TX_ID
```

Verify the local JSONL audit mirror has an unbroken previous-hash chain:

```bash
node scripts/vaultctl.mjs verify-local-audit --file ./vault-audit-local.jsonl
```

## Production hardening added

- The second migration creates private Supabase Storage buckets when possible and keeps them non-public.
- `retention_holds` records lifetime legal/operational holds for objects that must not be removed.
- Retained vault objects and import runs cannot be deleted through the owner API.
- Non-local AI jobs are rejected unless the job policy explicitly allows public AI processing.
- The worker only implements local zero-leakage AI jobs (`metadata_extract`, `classify`, and `summarize`) and writes encrypted JSON outputs back to `vault-processed`.

## Production scheduling

Systemd unit templates are provided for hardened Linux hosts in `deploy/systemd/`. Use them to run imports and local AI processing as timer-driven one-shot jobs instead of long-running shell sessions.
