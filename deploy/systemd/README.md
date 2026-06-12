# systemd deployment

These unit templates run the importer and local AI worker as one-shot jobs under systemd timers. Copy the repository to `/opt/sovereign-vault`, put secrets in `/etc/sovereign-vault/*.env`, and keep local audit mirrors under `/var/lib/sovereign-vault`.

Example `/etc/sovereign-vault/proton-drive.env`:

```ini
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_KEY
SUPABASE_ACCESS_TOKEN=USER_JWT_OR_SESSION_ACCESS_TOKEN
SUPABASE_RAW_BUCKET=vault-raw
SUPABASE_PROCESSED_BUCKET=vault-processed
VAULT_MASTER_KEY_B64=REPLACE_WITH_LOCAL_ONLY_SECRET
VAULT_LOCAL_AUDIT_LOG=/var/lib/sovereign-vault/audit.jsonl
VAULT_IMPORT_SOURCE=/home/YOU/ProtonDrive/VaultInbox
VAULT_IMPORT_INTERVAL_MINUTES=5
```

Enable a five-minute importer:

```bash
sudo cp deploy/systemd/sovereign-vault-import@.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now sovereign-vault-import@proton-drive.timer
```

Enable the local AI worker:

```bash
sudo cp deploy/systemd/sovereign-vault-ai-worker.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now sovereign-vault-ai-worker.timer
```
