# macOS multi-device first vault seeding

Use this when you want several Apple macOS machines to seed the same sovereign cloud vault without coding.

## What it does

- Each Mac imports from its own local folder, Proton Drive sync folder, export folder, or external drive.
- Each Mac encrypts files locally before upload.
- Each Mac writes audit events into the same Supabase vault and its own local JSONL mirror.
- The LaunchAgent runs every 5 or 10 minutes while that Mac user is logged in.

## Setup per Mac

1. Install Node.js 20 or newer.
2. Copy or clone this repository onto the Mac.
3. Run the installer once to create a private env file:

```bash
bash deploy/macos/install-launchagent.sh --source "$HOME/Proton Drive/VaultInbox" --interval-minutes 5
```

4. Fill in `~/.sovereign-vault/device.env` with Supabase credentials and the shared vault master key.
5. Run the same command again.

## Multi-device pattern

Repeat the setup on every Mac you control. Use the same Supabase project and vault master key, but different source folders. Recommended first-seed sources:

- `~/Proton Drive/VaultInbox`
- `~/Downloads/VaultSeed`
- `~/Pictures/ExportsForVault`
- external drive archive folders mounted under `/Volumes/...`

The encrypted cloud vault becomes the shared destination. Plaintext stays on each Mac during import.
