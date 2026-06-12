# Threat Model

## Protected assets

- Raw files and digital assets.
- Processed derivatives and AI-enhanced outputs.
- File metadata, classifications, and administrative notes.
- Import source definitions and schedules.
- Audit logs, hash chains, and blockchain anchors.
- Local encryption keys and Supabase session tokens.

## Adversaries

- A compromised storage provider account.
- A malicious or compromised database administrator.
- A network observer.
- A compromised AI endpoint.
- Malware on the import machine.
- Accidental deletion, overwrite, or bad admin action.

## Security assumptions

- Your local machine can protect `VAULT_MASTER_KEY_B64` and session tokens.
- Supabase RLS is configured exactly as in the migration.
- Storage buckets remain private.
- You retain at least one independent copy of audit roots or local JSONL audit logs.
- Blockchain anchoring transactions are written to a chain you can later verify independently.

## Main mitigations

| Risk | Mitigation |
| --- | --- |
| Supabase object disclosure | Client-side encryption before upload |
| Metadata disclosure | Minimal metadata fields and owner-only RLS |
| Unauthorized reads/writes | RLS on all vault tables plus private buckets |
| Audit tampering | Append-only trigger, hash chain, Merkle roots, blockchain anchors |
| AI leakage | Private/local AI worker pattern; no public AI endpoint by default |
| Bad imports | Content hashes, idempotent object paths, import run records |
| Deletion | Offline encrypted backups and anchored audit proofs |

## Non-goals and honest limitations

- The system cannot make data physically undeletable if all copies and keys are destroyed.
- The system cannot prevent plaintext leakage from a compromised endpoint that has the key and decrypted bytes.
- Blockchain anchoring proves that a root existed at a time; it does not store your private data and does not restore deleted files.
- Proton integrations depend on the exact Proton product and local export/sync method you choose.

## Required operator practices

1. Keep secrets out of source control.
2. Store the master key in a password manager or hardware-backed secret store.
3. Use separate devices/accounts for testing and production.
4. Verify RLS with a non-owner account before adding sensitive data.
5. Keep encrypted offline backups of both storage objects and database dumps.

## Production hardening controls

- Retained `vault_objects` are protected by a delete-rejecting trigger for owner API access.
- `import_runs`, `audit_events`, and `audit_anchors` are treated as audit records and are not mutable through normal API paths.
- Supabase Storage delete policies are intentionally absent; the authenticated owner can upload/read/update metadata but not delete objects through the configured RLS policy set.
- Public AI usage is blocked by trigger unless `policy.allow_public_ai` is explicitly true.

These controls are tamper-evident and API-hardening controls, not magic physical immutability. A hostile infrastructure administrator can still destroy infrastructure; offline encrypted backups and external anchors are mandatory for sovereign recovery.
