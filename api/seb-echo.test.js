import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import handler from './seb-echo.js';

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

describe('api/seb-echo handler', () => {
  it('reports no SEB headers when none are present', () => {
    const req = { headers: { host: 'example.com' }, url: '/api/seb-echo', query: {} };
    const res = makeRes();
    handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.sawAnySebHeader).toBe(false);
    expect(res.body.sebHeaders).toEqual({});
    expect(res.body.receivedConfigKeyHash).toBeNull();
  });

  it('collects x-safeexambrowser-* headers verbatim, case-insensitively', () => {
    const req = {
      headers: {
        host: 'example.com',
        'X-SafeExamBrowser-ConfigKeyHash': 'ABC123',
        'x-safeexambrowser-requesthash': 'def456',
      },
      url: '/api/seb-echo',
      query: {},
    };
    const res = makeRes();
    handler(req, res);

    expect(res.body.sawAnySebHeader).toBe(true);
    expect(res.body.receivedConfigKeyHash).toBe('abc123');
  });

  it('builds candidate URLs from forwarded proto/host headers', () => {
    const req = {
      headers: {
        host: 'fallback.com',
        'x-forwarded-host': 'app.example.com',
        'x-forwarded-proto': 'https',
      },
      url: '/api/seb-echo?candidateKey=xyz',
      query: { candidateKey: 'xyz' },
    };
    const res = makeRes();
    handler(req, res);

    expect(res.body.urlCandidates.full).toBe('https://app.example.com/api/seb-echo?candidateKey=xyz');
    expect(res.body.urlCandidates.noQuery).toBe('https://app.example.com/api/seb-echo');
  });

  it('identifies which URL form reproduces the received hash when a candidateKey is supplied', () => {
    const host = 'app.example.com';
    const path = '/api/seb-echo';
    const candidateKey = 'secret-key';
    const expectedHash = createHash('sha256').update(`https://${host}${path}` + candidateKey, 'utf8').digest('hex');

    const req = {
      headers: {
        host,
        'x-safeexambrowser-configkeyhash': expectedHash,
      },
      url: path,
      query: { candidateKey },
    };
    const res = makeRes();
    handler(req, res);

    expect(res.body.matches.full).toBe(true);
    expect(res.body.matches.noQuery).toBe(true);
  });

  it('is a read-only response with no-store caching', () => {
    const req = { headers: { host: 'example.com' }, url: '/api/seb-echo', query: {} };
    const res = makeRes();
    handler(req, res);
    expect(res.headers['Cache-Control']).toBe('no-store');
  });
});
