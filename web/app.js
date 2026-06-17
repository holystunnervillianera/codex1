const state = {
  client: null,
  ownerId: null,
  masterKey: null,
  rawBucket: 'vault-raw',
  auditName: 'browser-console',
  lastAuditHash: null,
};

const $ = (id) => document.getElementById(id);

function toast(message) {
  const element = $('toast');
  element.textContent = message;
  element.classList.add('visible');
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => element.classList.remove('visible'), 4200);
}

function bytesToHex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function sha256Hex(value) {
  const bytes = value instanceof ArrayBuffer ? value : new TextEncoder().encode(value);
  return bytesToHex(await crypto.subtle.digest('SHA-256', bytes));
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

async function chainedAuditHash(previousHash, event) {
  const eventHash = await sha256Hex(canonicalJson(event));
  return await sha256Hex(`${previousHash ?? 'GENESIS'}:${eventHash}`);
}

async function deriveKey(masterKeyBytes, salt) {
  const baseKey = await crypto.subtle.importKey('raw', masterKeyBytes, 'PBKDF2', false, ['deriveKey']);
  return await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
}

async function encryptFile(file, masterKeyBytes) {
  const plaintext = await file.arrayBuffer();
  const plaintextSha256 = await sha256Hex(plaintext);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode(plaintextSha256);
  const key = await deriveKey(masterKeyBytes, salt);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, key, plaintext));
  const ciphertext = encrypted.slice(0, -16);
  const authTag = encrypted.slice(-16);
  const ciphertextSha256 = await sha256Hex(ciphertext.buffer);
  return {
    plaintextSha256,
    ciphertextSha256,
    ciphertext,
    encryption: {
      algorithm: 'aes-256-gcm',
      kdf: 'pbkdf2-sha256',
      iterations: 310000,
      salt_b64: bytesToBase64(salt),
      nonce_b64: bytesToBase64(nonce),
      auth_tag_b64: bytesToBase64(authTag),
      aad_sha256: await sha256Hex(aad),
    },
  };
}

class BrowserSupabaseClient {
  constructor({ url, anonKey, accessToken }) {
    this.url = url.replace(/\/$/, '');
    this.anonKey = anonKey;
    this.accessToken = accessToken;
  }

  async request(path, options = {}) {
    const response = await fetch(`${this.url}${path}`, {
      ...options,
      headers: {
        apikey: this.anonKey,
        authorization: `Bearer ${this.accessToken}`,
        ...(options.headers ?? {}),
      },
    });
    if (!response.ok) throw new Error(`Supabase ${response.status}: ${await response.text()}`);
    return response;
  }

  async json(path, options = {}) {
    const response = await this.request(path, options);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  async currentUserId() {
    const user = await this.json('/auth/v1/user');
    if (!user?.id) throw new Error('Could not resolve Supabase user. Check your access token.');
    return user.id;
  }

  async insert(table, row, returning = true) {
    const rows = await this.json(`/rest/v1/${table}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', prefer: returning ? 'return=representation' : 'return=minimal' },
      body: JSON.stringify(row),
    });
    return returning ? rows[0] : null;
  }

  async select(table, query) {
    return await this.json(`/rest/v1/${table}?${query}`);
  }

  async uploadObject(bucket, objectPath, body) {
    await this.request(`/storage/v1/object/${bucket}/${objectPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-upsert': 'false' },
      body,
    });
  }
}

async function recordAuditEvent({ action, subjectType, subjectId, details }) {
  const eventCore = {
    owner_id: state.ownerId,
    actor: `owner:${state.auditName}`,
    action,
    subject_type: subjectType,
    subject_id: subjectId,
    details,
    previous_event_hash: state.lastAuditHash,
  };
  const eventHash = await chainedAuditHash(state.lastAuditHash, eventCore);
  const auditEvent = { ...eventCore, event_hash: eventHash };
  await state.client.insert('audit_events', auditEvent, false);
  state.lastAuditHash = eventHash;
  sessionStorage.setItem('sovereign-vault-last-audit-hash', eventHash);
}

async function connect(event) {
  event.preventDefault();
  const masterKeyBytes = base64ToBytes($('vault-master-key').value.trim());
  if (masterKeyBytes.length !== 32) throw new Error('Vault master key must decode to exactly 32 bytes.');
  state.masterKey = masterKeyBytes;
  state.rawBucket = $('raw-bucket').value.trim();
  state.auditName = $('audit-name').value.trim();
  state.client = new BrowserSupabaseClient({
    url: $('supabase-url').value.trim(),
    anonKey: $('supabase-anon-key').value.trim(),
    accessToken: $('supabase-access-token').value.trim(),
  });
  state.ownerId = await state.client.currentUserId();
  state.lastAuditHash = sessionStorage.getItem('sovereign-vault-last-audit-hash');
  $('metric-owner').textContent = `${state.ownerId.slice(0, 8)}…`;
  if ($('remember-session').checked) {
    sessionStorage.setItem('sovereign-vault-url', $('supabase-url').value.trim());
    sessionStorage.setItem('sovereign-vault-raw-bucket', state.rawBucket);
  }
  await refreshDashboard();
  toast('Vault unlocked. You can upload files now.');
}

async function uploadFiles(files) {
  if (!state.client || !state.masterKey) throw new Error('Connect your vault first.');
  const list = $('upload-list');
  for (const file of files) {
    const item = document.createElement('li');
    item.textContent = `Encrypting ${file.name}…`;
    list.prepend(item);
    const encrypted = await encryptFile(file, state.masterKey);
    const objectPath = `${state.ownerId}/${encrypted.plaintextSha256}-${file.name}.enc`;
    item.textContent = `Uploading encrypted ${file.name}…`;
    await state.client.uploadObject(state.rawBucket, objectPath, encrypted.ciphertext);
    const vaultObject = await state.client.insert('vault_objects', {
      owner_id: state.ownerId,
      original_name: file.webkitRelativePath || file.name,
      object_path: objectPath,
      bucket_name: state.rawBucket,
      mime_type: file.type || null,
      byte_size: file.size,
      plaintext_sha256: encrypted.plaintextSha256,
      ciphertext_sha256: encrypted.ciphertextSha256,
      encryption: encrypted.encryption,
      metadata: { imported_by: 'web/browser-console', browser_last_modified: file.lastModified },
    });
    await recordAuditEvent({
      action: 'vault.object.browser_uploaded',
      subjectType: 'vault_object',
      subjectId: vaultObject.id,
      details: { original_name: file.name, object_path: objectPath, plaintext_sha256: encrypted.plaintextSha256, ciphertext_sha256: encrypted.ciphertextSha256 },
    });
    item.textContent = `✓ ${file.name} encrypted, uploaded, and logged`;
  }
  await refreshDashboard();
}

async function queueAi(objectId, jobType) {
  await state.client.insert('ai_jobs', {
    owner_id: state.ownerId,
    input_object_id: objectId,
    job_type: jobType,
    provider_label: 'local',
    policy: { allow_public_ai: false, plaintext_may_leave_owner_device: false, queued_from: 'web-console' },
  });
  toast(`${jobType.replace('_', ' ')} queued for local AI worker.`);
  await refreshDashboard();
}

function renderObjects(objects) {
  const grid = $('objects-grid');
  grid.innerHTML = '';
  if (objects.length === 0) {
    grid.innerHTML = '<p>No vault objects yet. Drop files to seed your vault.</p>';
    return;
  }
  for (const object of objects) {
    const card = document.createElement('article');
    card.className = 'object-card';
    const title = document.createElement('strong');
    title.textContent = object.original_name;
    const meta = document.createElement('div');
    meta.className = 'object-meta';
    meta.textContent = `${object.status} • ${Math.round(object.byte_size / 1024)} KB • ${new Date(object.created_at).toLocaleString()}`;
    const actions = document.createElement('div');
    actions.className = 'object-actions';
    for (const jobType of ['metadata_extract', 'classify', 'summarize']) {
      const button = document.createElement('button');
      button.className = 'button secondary';
      button.type = 'button';
      button.textContent = jobType.replace('_', ' ');
      button.addEventListener('click', () => queueAi(object.id, jobType).catch((error) => toast(error.message)));
      actions.append(button);
    }
    card.append(title, meta, actions);
    grid.append(card);
  }
}

async function refreshDashboard() {
  if (!state.client || !state.ownerId) return;
  const objects = await state.client.select('vault_objects', `owner_id=eq.${state.ownerId}&order=created_at.desc&limit=30&select=*`);
  const audits = await state.client.select('audit_events', `owner_id=eq.${state.ownerId}&select=id`);
  const jobs = await state.client.select('ai_jobs', `owner_id=eq.${state.ownerId}&status=eq.queued&select=id`);
  $('metric-objects').textContent = String(objects.length);
  $('metric-audit').textContent = String(audits.length);
  $('metric-jobs').textContent = String(jobs.length);
  renderObjects(objects);
}

function hydrateSession() {
  const url = sessionStorage.getItem('sovereign-vault-url');
  const bucket = sessionStorage.getItem('sovereign-vault-raw-bucket');
  if (url) $('supabase-url').value = url;
  if (bucket) $('raw-bucket').value = bucket;
}

$('connect-form').addEventListener('submit', (event) => connect(event).catch((error) => toast(error.message)));
$('refresh-button').addEventListener('click', () => refreshDashboard().catch((error) => toast(error.message)));
$('file-input').addEventListener('change', (event) => uploadFiles([...event.target.files]).catch((error) => toast(error.message)));
$('drop-zone').addEventListener('click', () => $('file-input').click());
$('drop-zone').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') $('file-input').click();
});
for (const eventName of ['dragenter', 'dragover']) {
  $('drop-zone').addEventListener(eventName, (event) => {
    event.preventDefault();
    $('drop-zone').classList.add('dragging');
  });
}
for (const eventName of ['dragleave', 'drop']) {
  $('drop-zone').addEventListener(eventName, (event) => {
    event.preventDefault();
    $('drop-zone').classList.remove('dragging');
  });
}
$('drop-zone').addEventListener('drop', (event) => uploadFiles([...event.dataTransfer.files]).catch((error) => toast(error.message)));

hydrateSession();
