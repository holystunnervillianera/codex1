export function requiredEnv(name, env = process.env) {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export class SupabaseRestClient {
  constructor({ url, anonKey, accessToken } = {}) {
    this.url = (url ?? requiredEnv('SUPABASE_URL')).replace(/\/$/, '');
    this.anonKey = anonKey ?? requiredEnv('SUPABASE_ANON_KEY');
    this.accessToken = accessToken ?? requiredEnv('SUPABASE_ACCESS_TOKEN');
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

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Supabase request failed ${response.status} ${path}: ${body}`);
    }

    return response;
  }

  async json(path, options = {}) {
    const response = await this.request(path, options);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  async currentUserId() {
    const user = await this.json('/auth/v1/user');
    if (!user?.id) {
      throw new Error('Could not resolve authenticated Supabase user id');
    }
    return user.id;
  }

  async insert(table, row, { returning = true } = {}) {
    const rows = await this.json(`/rest/v1/${table}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        prefer: returning ? 'return=representation' : 'return=minimal',
      },
      body: JSON.stringify(row),
    });
    return returning ? rows[0] : null;
  }

  async patch(table, query, row) {
    await this.json(`/rest/v1/${table}?${query}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(row),
    });
  }

  async select(table, query) {
    return await this.json(`/rest/v1/${table}?${query}`);
  }

  async uploadObject(bucket, objectPath, body, { upsert = false, contentType = 'application/octet-stream' } = {}) {
    await this.request(`/storage/v1/object/${bucket}/${objectPath}`, {
      method: 'POST',
      headers: {
        'content-type': contentType,
        'x-upsert': String(upsert),
      },
      body,
    });
  }

  async downloadObject(bucket, objectPath) {
    const response = await this.request(`/storage/v1/object/authenticated/${bucket}/${objectPath}`);
    return Buffer.from(await response.arrayBuffer());
  }
}
