import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import handler from './seb-verify.js';

function makeReq({ method = 'POST', headers = {}, url = '/api/seb-verify', body = {} } = {}) {
  return { method, headers, url, body };
}

function makeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: undefined,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

describe('api/seb-verify handler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.SEB_CONFIG_KEYS = '';
    process.env.SEB_SIGNING_SECRET = '';
    process.env.FIREBASE_PROJECT_ID = '';
    delete process.env.FIREBASE_CLIENT_EMAIL;
    delete process.env.FIREBASE_PRIVATE_KEY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('rejects non-POST methods', async () => {
    const req = makeReq({ method: 'GET' });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ ok: false, error: 'METHOD_NOT_ALLOWED' });
  });

  it('fails closed when signing secret / project id are not configured', async () => {
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'SEB_NOT_CONFIGURED' });
  });

  it('rejects a missing assessmentId with a 400', async () => {
    process.env.SEB_SIGNING_SECRET = 'shared-secret';
    process.env.FIREBASE_PROJECT_ID = 'proj';
    const req = makeReq({ body: {} });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'SEB_VERIFY_BAD_REQUEST', reason: 'missing_assessment' });
  });

  it('requires the SEB config-key-hash header (403 when missing)', async () => {
    process.env.SEB_SIGNING_SECRET = 'shared-secret';
    process.env.FIREBASE_PROJECT_ID = 'proj';
    const req = makeReq({ body: { assessmentId: 'exam1' } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ ok: false, error: 'SEB_REQUIRED', reason: 'no_header' });
  });

  it('parses a JSON string body', async () => {
    process.env.SEB_SIGNING_SECRET = 'shared-secret';
    process.env.FIREBASE_PROJECT_ID = 'proj';
    const req = makeReq({ body: JSON.stringify({ assessmentId: 'exam1' }) });
    const res = makeRes();
    await handler(req, res);
    // Gets past body-parsing/assessmentId check onto the header check.
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('SEB_REQUIRED');
  });

  it('returns 500 with no_keys reason when no config keys resolve (env fallback empty)', async () => {
    process.env.SEB_SIGNING_SECRET = 'shared-secret';
    process.env.FIREBASE_PROJECT_ID = 'proj';
    process.env.SEB_CONFIG_KEYS = '';

    // No Firebase service account configured -> resolveConfigKeys falls back to env (empty).
    const req = makeReq({
      headers: { 'x-safeexambrowser-configkeyhash': 'deadbeef' },
      body: { assessmentId: 'exam1' },
    });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('SEB_NOT_CONFIGURED');
  });

  it('rejects when the computed hash does not match the received one', async () => {
    process.env.SEB_SIGNING_SECRET = 'shared-secret';
    process.env.FIREBASE_PROJECT_ID = 'proj';
    process.env.SEB_CONFIG_KEYS = 'known-key';

    const req = makeReq({
      headers: { 'x-safeexambrowser-configkeyhash': 'not-the-real-hash-but-64-chars-long-000000000000000000000000' },
      body: { assessmentId: 'exam1' },
    });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ ok: false, error: 'SEB_CONFIG_MISMATCH', reason: 'hash_mismatch' });
  });

  it('requires an Authorization bearer token once the SEB hash matches', async () => {
    process.env.SEB_SIGNING_SECRET = 'shared-secret';
    process.env.FIREBASE_PROJECT_ID = 'proj';
    process.env.SEB_CONFIG_KEYS = 'known-key';

    const host = 'app.example.com';
    const path = '/api/seb-verify';
    const url = `https://${host}${path}`;
    const { createHash } = await import('node:crypto');
    const expectedHash = createHash('sha256').update(url + 'known-key', 'utf8').digest('hex');

    const req = makeReq({
      headers: { host, 'x-forwarded-proto': 'https', 'x-safeexambrowser-configkeyhash': expectedHash },
      url: path,
      body: { assessmentId: 'exam1' },
    });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'AUTH_REQUIRED' });
  });
});
