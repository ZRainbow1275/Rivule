import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { after, test } from 'node:test';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import {
  allowInvitedEmail, createAuthenticatedWorker, getPrincipal, issueConnector, revokeConnector, validateCsrf,
  type AuthEnv, type AuthOptions, type Principal,
} from '../src/auth.ts';

// Only the workerd base class is shimmed; tests execute the installed OAuth provider and real Web Crypto.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export class WorkerEntrypoint {}', shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
after(() => hooks.deregister());

const ORIGIN = 'https://rivule-bridge.hybridrevis.workers.dev';
const CLIENT_ID = 'unit-test.apps.googleusercontent.com';
const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
const tokens = new Map<string, string>();
const exchanges: URLSearchParams[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [jwk] });
  if (url === 'https://oauth2.googleapis.com/token') {
    const body = new URLSearchParams(String(init?.body));
    exchanges.push(body);
    const token = tokens.get(body.get('code') ?? '');
    return token ? Response.json({ id_token: token }) : Response.json({ error: 'invalid_grant' }, { status: 400 });
  }
  throw new Error(`Unexpected network request: ${url}`);
};
after(() => { globalThis.fetch = originalFetch; });

function fixture() {
  const values = new Map<string, { value: string; metadata?: unknown; expiresAt?: number }>();
  const read = async (key: string, type?: string | { type?: string }) => {
    const record = values.get(key);
    if (!record || (record.expiresAt !== undefined && record.expiresAt <= Date.now())) return null;
    return (typeof type === 'string' ? type : type?.type) === 'json' ? JSON.parse(record.value) : record.value;
  };
  const kv = {
    get: read,
    async put(key: string, value: string, options?: KVNamespacePutOptions) {
      values.set(key, { value, metadata: options?.metadata, expiresAt: options?.expiration ? options.expiration * 1000 : options?.expirationTtl ? Date.now() + options.expirationTtl * 1000 : undefined });
    },
    async delete(key: string) { values.delete(key); },
    async list(options?: KVNamespaceListOptions) {
      return { keys: [...values].filter(([key]) => key.startsWith(options?.prefix ?? '')).map(([name, record]) => ({ name, metadata: record.metadata })), list_complete: true, cacheStatus: null };
    },
    async getWithMetadata(key: string, type?: string | { type?: string }) {
      return { value: await read(key, type), metadata: values.get(key)?.metadata ?? null, cacheStatus: null };
    },
  } as KVNamespace;
  const env: AuthEnv = { AUTH_KV: kv, PUBLIC_ORIGIN: ORIGIN, GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: 'unit-fixture-secret', INVITED_EMAILS: '["owner@example.com"]' };
  const consumed = new Set<string>();
  const bindings: Array<{ userId: string; workspaceId: string; sourceId: string }> = [];
  const options: AuthOptions = {
    async consumeOnce(key, expiresAt) {
      assert.ok(expiresAt > Date.now());
      if (consumed.has(key)) return false;
      consumed.add(key);
      return true;
    },
    async authorizeBinding(principal, binding) {
      bindings.push({ userId: principal.userId, ...binding });
      return binding.workspaceId === 'workspace-owner' && binding.sourceId === 'browser-owner';
    },
  };
  const worker = createAuthenticatedWorker<AuthEnv>({
    async fetch(request, appEnv, ctx) { return Response.json({ principal: await getPrincipal(request, appEnv, ctx) }); },
  }, options);
  const context = (): ExecutionContext => ({
    waitUntil() {}, passThroughOnException() {}, props: {}, exports: {}, abort() {},
    get tracing(): Tracing { throw new Error('Tracing is outside this unit fixture'); },
  });
  const call = (request: Request) => worker.fetch!(request as Parameters<NonNullable<ExportedHandler<AuthEnv>['fetch']>>[0], env, context());
  return { env, worker, call, context, values, consumed, options, bindings };
}

class Cookies {
  values = new Map<string, string>();
  add(response: Response) {
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(';')[0]!;
      const split = pair.indexOf('=');
      const name = pair.slice(0, split);
      const token = pair.slice(split + 1);
      if (token) this.values.set(name, token); else this.values.delete(name);
    }
  }
  headers(extra: Record<string, string> = {}) { return { Cookie: [...this.values].map(([name, value]) => `${name}=${value}`).join('; '), ...extra }; }
}

async function signed(nonce: string, claims: JWTPayload = {}): Promise<string> {
  return new SignJWT({ email: 'owner@example.com', email_verified: true, nonce, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setSubject('google-subject-owner')
    .setIssuer('https://accounts.google.com').setAudience(CLIENT_ID).setIssuedAt().setExpirationTime('5m')
    .sign(privateKey);
}

async function startLogin(f: ReturnType<typeof fixture>, jar = new Cookies()) {
  const response = await f.call(new Request(`${ORIGIN}/auth/google/start`, { headers: jar.headers() }));
  assert.equal(response.status, 302);
  jar.add(response);
  const google = new URL(response.headers.get('Location')!);
  assert.equal(google.origin, 'https://accounts.google.com');
  assert.equal(google.searchParams.get('redirect_uri'), `${ORIGIN}/auth/google/callback`);
  assert.equal(google.searchParams.get('scope'), 'openid email');
  assert.equal(google.searchParams.get('code_challenge_method'), 'S256');
  return { jar, google, state: google.searchParams.get('state')!, nonce: google.searchParams.get('nonce')! };
}

async function finishLogin(f: ReturnType<typeof fixture>, flow: Awaited<ReturnType<typeof startLogin>>, token?: string) {
  const code = crypto.randomUUID();
  tokens.set(code, token ?? await signed(flow.nonce));
  const url = `${ORIGIN}/auth/google/callback?state=${flow.state}&code=${code}`;
  const response = await f.call(new Request(url, { headers: flow.jar.headers() }));
  flow.jar.add(response);
  return { response, url };
}

async function login(f: ReturnType<typeof fixture>) {
  const flow = await startLogin(f);
  const { response } = await finishLogin(f, flow);
  assert.equal(response.status, 302, await response.clone().text());
  assert.equal(response.headers.get('Location'), `${ORIGIN}/`);
  const status = await f.call(new Request(`${ORIGIN}/auth/session`, { headers: flow.jar.headers() }));
  const body = await status.json() as { principal: Principal; csrfToken: string };
  return { ...flow, ...body };
}

function postForm(path: string, jar: Cookies, body: URLSearchParams) {
  return new Request(`${ORIGIN}${path}`, { method: 'POST', headers: jar.headers({ Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' }), body });
}

test('safe setup status, missing configuration, origin checks and return URL allowlist', async () => {
  const f = fixture();
  delete f.env.GOOGLE_CLIENT_SECRET;
  const status = await f.call(new Request(`${ORIGIN}/auth/status`));
  assert.deepEqual(await status.json(), { googleConfigured: false, inviteOnly: true, setupRequired: true, loginPath: '/auth/google/start' });
  assert.equal((await f.call(new Request(`${ORIGIN}/auth/google/start`))).status, 503);
  assert.equal((await f.call(new Request(`${ORIGIN}/auth/google/start?return_to=https://evil.example/`))).status, 400);
  assert.equal((await f.call(new Request(`${ORIGIN}/auth/google/start?return_to=/auth/logout`))).status, 400);
  const wrong = await f.call(new Request(`${ORIGIN}/auth/status`, { headers: { Origin: 'https://evil.example' } }));
  assert.equal(wrong.status, 403);
  assert.equal(wrong.headers.has('Access-Control-Allow-Origin'), false);
  const noHooks = createAuthenticatedWorker<AuthEnv>({ fetch: () => new Response('unused') });
  f.env.GOOGLE_CLIENT_SECRET = 'unit-fixture-secret';
  assert.equal((await noHooks.fetch!(new Request(`${ORIGIN}/auth/google/start`), f.env, f.context())).status, 503);
});

test('real Google JWT signature/claims, invitation and PKCE create a fresh protected session', async () => {
  const f = fixture();
  const { principal, csrfToken, jar, google } = await login(f);
  assert.match(principal.userId, /^google_[a-f0-9]{64}$/);
  assert.equal(principal.email, 'owner@example.com');
  assert.equal(principal.kind, 'session');
  const exchange = exchanges.at(-1)!;
  assert.equal(exchange.get('redirect_uri'), `${ORIGIN}/auth/google/callback`);
  const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(exchange.get('code_verifier')!))).toString('base64url');
  assert.equal(challenge, google.searchParams.get('code_challenge'));
  const cookie = jar.values.get('__Host-rivule_session')!;
  assert.ok([...f.values.keys()].every((key) => !key.includes(cookie)));
  assert.ok([...f.values.values()].every(({ value }) => !value.includes(tokens.get(exchange.get('code')!)!)));
  assert.equal(await validateCsrf(new Request(`${ORIGIN}/api/write`, { method: 'POST', headers: jar.headers({ Origin: ORIGIN, 'X-CSRF-Token': csrfToken }) }), f.env), true);
  assert.equal(await validateCsrf(new Request(`${ORIGIN}/api/write`, { method: 'POST', headers: jar.headers({ Origin: ORIGIN }) }), f.env), false);
  assert.equal(await validateCsrf(new Request(`${ORIGIN}/api/write`, { method: 'POST', headers: jar.headers({ Origin: 'https://evil.example', 'X-CSRF-Token': csrfToken }) }), f.env), false);
  assert.equal(await getPrincipal(new Request(`${ORIGIN}/api/write`, { headers: jar.headers({ Authorization: 'Bearer invalid', 'X-User-Id': 'admin' }) }), f.env), null);
  const logout = await f.call(new Request(`${ORIGIN}/auth/logout`, { method: 'POST', headers: jar.headers({ Origin: ORIGIN, 'X-CSRF-Token': csrfToken }) }));
  assert.equal(logout.status, 204);
  assert.match(logout.headers.get('Set-Cookie')!, /HttpOnly; Secure; SameSite=Lax; Max-Age=0/);
  assert.equal(await getPrincipal(new Request(`${ORIGIN}/`, { headers: jar.headers() }), f.env), null);
});

test('uninvited identities stay out; server-side invitation enables the same verified email', async () => {
  const f = fixture();
  f.env.INVITED_EMAILS = '[]';
  const flow = await startLogin(f);
  assert.equal((await finishLogin(f, flow)).response.status, 403);
  assert.equal(flow.jar.values.has('__Host-rivule_session'), false);
  await allowInvitedEmail('OWNER@example.com', f.env);
  assert.equal((await finishLogin(f, await startLogin(f))).response.status, 302);
});

test('a second Google login rotates the session and CSRF token', async () => {
  const f = fixture();
  const previous = await login(f);
  const oldCookie = previous.jar.headers();
  assert.equal((await finishLogin(f, await startLogin(f, previous.jar))).response.status, 302);
  assert.equal(await getPrincipal(new Request(`${ORIGIN}/`, { headers: oldCookie }), f.env), null);
  const current = await f.call(new Request(`${ORIGIN}/auth/session`, { headers: previous.jar.headers() }));
  const body = await current.json() as { principal: Principal; csrfToken: string };
  assert.equal(body.principal.userId, previous.principal.userId);
  assert.notEqual(body.csrfToken, previous.csrfToken);
});

test('OIDC rejects wrong nonce, unverified email, audience, issuer, expiration and signature', async (t) => {
  for (const fault of ['nonce', 'email', 'audience', 'issuer', 'expired', 'signature']) {
    await t.test(fault, async () => {
      const f = fixture();
      const flow = await startLogin(f);
      const signer = new SignJWT({ email: 'owner@example.com', email_verified: fault !== 'email', nonce: fault === 'nonce' ? 'wrong-nonce' : flow.nonce })
        .setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setSubject('google-subject-owner')
        .setIssuer(fault === 'issuer' ? 'https://evil.example' : 'https://accounts.google.com')
        .setAudience(fault === 'audience' ? 'another-client' : CLIENT_ID).setIssuedAt()
        .setExpirationTime(fault === 'expired' ? Math.floor(Date.now() / 1000) - 60 : '5m');
      const key = fault === 'signature' ? (await generateKeyPair('RS256')).privateKey : privateKey;
      assert.equal((await finishLogin(f, flow, await signer.sign(key))).response.status, 401);
      assert.equal(flow.jar.values.has('__Host-rivule_session'), false);
    });
  }
});

test('browser-bound state and atomic consume reject a concurrent callback replay before exchange', async () => {
  const f = fixture();
  const flow = await startLogin(f);
  const code = crypto.randomUUID();
  tokens.set(code, await signed(flow.nonce));
  const callback = `${ORIGIN}/auth/google/callback?state=${flow.state}&code=${code}`;
  assert.equal((await f.call(new Request(callback))).status, 400);
  const before = exchanges.length;
  const responses = await Promise.all([f.call(new Request(callback, { headers: flow.jar.headers() })), f.call(new Request(callback, { headers: flow.jar.headers() }))]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [302, 400]);
  assert.equal(exchanges.length - before, 1);
  assert.equal((await f.call(new Request(callback, { headers: flow.jar.headers() }))).status, 400);
});

test('connectors are short-lived, owner-revocable, source-bound and cannot create credentials', async () => {
  const f = fixture();
  const session = await login(f);
  const issued = await issueConnector(session.principal, f.env, { workspaceId: 'workspace-owner', sourceId: 'browser-owner' });
  assert.ok(new Date(issued.expires_at).getTime() - Date.now() <= 7 * 24 * 60 * 60 * 1000);
  assert.ok(new Date(issued.expires_at).getTime() - Date.now() > 6 * 24 * 60 * 60 * 1000);
  assert.ok([...f.values.values()].every(({ value }) => !value.includes(issued.token)));
  const request = new Request(`${ORIGIN}/api/connector`, { headers: { Authorization: `Bearer ${issued.token}` } });
  const principal = (await getPrincipal(request, f.env))!;
  assert.equal(principal.kind, 'connector');
  assert.equal(principal.workspaceId, 'workspace-owner');
  assert.equal(principal.sourceId, 'browser-owner');
  assert.deepEqual(principal.scopes, ['bridge:read', 'bridge:write']);
  assert.equal(await validateCsrf(request, f.env), true);
  assert.equal(await getPrincipal(new Request(`${ORIGIN}/`, { headers: { Authorization: `Bearer ${issued.token.slice(0, -1)}!` } }), f.env), null);
  await assert.rejects(issueConnector(principal, f.env, { workspaceId: 'workspace-owner', sourceId: 'browser-owner' }));
  await assert.rejects(revokeConnector({ ...session.principal, userId: 'another-user' }, f.env, issued.tokenId));
  await revokeConnector(session.principal, f.env, issued.tokenId);
  assert.equal(await getPrincipal(request, f.env), null);
  const expired = await issueConnector(session.principal, f.env, { workspaceId: 'workspace-owner', sourceId: 'browser-owner' });
  const stored = f.values.get(`auth:connector:${expired.tokenId}`)!;
  stored.value = JSON.stringify({ ...JSON.parse(stored.value), expiresAt: Date.now() - 1 });
  assert.equal(await getPrincipal(new Request(`${ORIGIN}/`, { headers: { Authorization: `Bearer ${expired.token}` } }), f.env), null);
});

test('MV3 extension POSTs require an authenticated connector, exact coordination route and no Cookie', async () => {
  const f = fixture();
  const session = await login(f);
  const issued = await issueConnector(session.principal, f.env, { workspaceId: 'workspace-owner', sourceId: 'browser-owner' });
  const extensionOrigin = `chrome-extension://${'a'.repeat(32)}`;
  const extensionRequest = (path: string, headers: Record<string, string> = {}, method = 'POST') => {
    const init = {
      method, credentials: 'omit',
      headers: { Origin: extensionOrigin, Authorization: `Bearer ${issued.token}`, 'Content-Type': 'application/json', ...headers },
      ...(method === 'POST' ? { body: '{"workspaceId":"workspace-owner","sourceId":"browser-owner"}' } : {}),
    };
    return new Request(`${ORIGIN}${path}`, init);
  };
  for (const route of ['claim', 'heartbeat', 'result']) {
    const request = extensionRequest(`/api/connector/${route}`);
    assert.equal(request.headers.has('Cookie'), false);
    assert.equal(await validateCsrf(request, f.env), true);
    const response = await f.call(request);
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json() as { principal: Principal };
    assert.equal(body.principal.kind, 'connector');
    assert.equal(body.principal.workspaceId, 'workspace-owner');
    assert.equal(body.principal.sourceId, 'browser-owner');
    assert.equal(response.headers.has('Access-Control-Allow-Credentials'), false);
  }
  assert.equal((await f.call(extensionRequest('/api/connector/claim', { Origin: `chrome-extension://${'p'.repeat(32)}` }))).status, 200);
  const tampered = `${issued.token.slice(0, -1)}${issued.token.endsWith('a') ? 'b' : 'a'}`;
  const rejectedHeaders: Array<Record<string, string>> = [
    { Authorization: '' }, { Authorization: 'Bearer forged' }, { Authorization: `Bearer ${tampered}` },
    { Cookie: '' }, { Cookie: session.jar.headers().Cookie },
    { Origin: 'https://evil.example' }, { Origin: 'null' }, { Origin: `chrome-extension://${'q'.repeat(32)}` },
    { Origin: `${extensionOrigin}/` },
  ];
  for (const headers of rejectedHeaders) {
    const request = extensionRequest('/api/connector/claim', headers);
    assert.equal(await validateCsrf(request, f.env), false);
    assert.equal((await f.call(request)).status, 403);
  }
  const cookieOnly = new Request(`${ORIGIN}/api/connector/claim`, { method: 'POST', headers: session.jar.headers({ Origin: extensionOrigin }) });
  assert.equal(await validateCsrf(cookieOnly, f.env), false);
  assert.equal((await f.call(cookieOnly)).status, 403);
  for (const path of ['/', '/auth/status', '/auth/session', '/auth/google/start', '/auth/logout', '/oauth/authorize', '/oauth/token', '/oauth/register', '/mcp', '/api/workspaces', '/api/connector/claim/extra']) {
    const request = extensionRequest(path);
    assert.equal(await validateCsrf(request, f.env), false);
    assert.equal((await f.call(request)).status, 403);
  }
  for (const method of ['GET', 'HEAD', 'DELETE', 'OPTIONS']) {
    const request = extensionRequest('/api/connector/claim', {}, method);
    assert.equal(await validateCsrf(request, f.env), false);
    assert.equal((await f.call(request)).status, 403);
  }
  await revokeConnector(session.principal, f.env, issued.tokenId);
  const revoked = extensionRequest('/api/connector/claim');
  assert.equal(await validateCsrf(revoked, f.env), false);
  assert.equal((await f.call(revoked)).status, 403);
});

async function registerClient(f: ReturnType<typeof fixture>) {
  const redirect = 'http://127.0.0.1:8789/callback';
  const response = await f.call(new Request(`${ORIGIN}/oauth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ client_name: '<script>untrusted</script>', redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
  }));
  assert.equal(response.status, 201, await response.clone().text());
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  const { client_id: clientId } = await response.json() as { client_id: string };
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const codeChallenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url');
  const auth = new URL(`${ORIGIN}/oauth/authorize`);
  auth.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: 'code', state: 'client-original-state', scope: 'bridge:read bridge:write bridge:control', resource: `${ORIGIN}/mcp`, code_challenge: codeChallenge, code_challenge_method: 'S256' }).toString();
  return { clientId, redirect, verifier, auth };
}

async function openConsent(f: ReturnType<typeof fixture>, auth: URL, jar: Cookies) {
  const response = await f.call(new Request(auth, { headers: jar.headers() }));
  assert.equal(response.status, 200, await response.clone().text());
  jar.add(response);
  const content = await response.text();
  assert.ok(content.includes('&#60;script&#62;untrusted&#60;/script&#62;'));
  assert.ok(!content.includes('<script>untrusted</script>'));
  assert.ok(content.includes('127.0.0.1'));
  assert.equal(response.headers.get('X-Frame-Options'), 'DENY');
  return { handle: /name="handle" value="([^"]+)"/.exec(content)![1]!, content };
}

test('installed OAuth provider runs DCR + S256 + human consent + narrowed bearer props + refresh', async () => {
  const f = fixture();
  const session = await login(f);
  const client = await registerClient(f);
  const consent = await openConsent(f, client.auth, session.jar);
  const fields = new URLSearchParams({ handle: consent.handle, csrf: session.csrfToken, decision: 'approve', workspaceId: 'workspace-owner', sourceId: 'browser-owner' });
  fields.append('scope', 'bridge:read'); fields.append('scope', 'bridge:write');
  const responses = await Promise.all([f.call(postForm('/oauth/authorize', session.jar, fields)), f.call(postForm('/oauth/authorize', session.jar, fields))]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [302, 400]);
  assert.equal(f.bindings.length, 1);
  assert.equal(f.bindings[0]!.userId, session.principal.userId);
  const callback = new URL(responses.find((response) => response.status === 302)!.headers.get('Location')!);
  assert.equal(callback.searchParams.get('state'), 'client-original-state');
  const wrongPkce = await f.call(postForm('/oauth/token', new Cookies(), new URLSearchParams({ grant_type: 'authorization_code', client_id: client.clientId, code: callback.searchParams.get('code')!, redirect_uri: client.redirect, code_verifier: 'wrong-verifier', resource: `${ORIGIN}/mcp` })));
  assert.equal(wrongPkce.status, 400);
  const response = await f.call(postForm('/oauth/token', new Cookies(), new URLSearchParams({ grant_type: 'authorization_code', client_id: client.clientId, code: callback.searchParams.get('code')!, redirect_uri: client.redirect, code_verifier: client.verifier, resource: `${ORIGIN}/mcp` })));
  assert.equal(response.status, 200, await response.clone().text());
  const issued = await response.json() as { access_token: string; refresh_token: string };
  const api = await f.call(new Request(`${ORIGIN}/mcp`, { headers: { Authorization: `Bearer ${issued.access_token}`, 'X-User-Id': 'forged-admin' } }));
  assert.equal(api.status, 200, await api.clone().text());
  const authenticated = await api.json() as { principal: Principal };
  assert.equal(authenticated.principal.userId, session.principal.userId);
  assert.equal(authenticated.principal.kind, 'mcp');
  assert.equal(authenticated.principal.workspaceId, 'workspace-owner');
  assert.equal(authenticated.principal.sourceId, 'browser-owner');
  assert.deepEqual(authenticated.principal.scopes, ['bridge:read', 'bridge:write']);
  const refreshed = await f.call(postForm('/oauth/token', new Cookies(), new URLSearchParams({ grant_type: 'refresh_token', client_id: client.clientId, refresh_token: issued.refresh_token, scope: 'bridge:read', resource: `${ORIGIN}/mcp` })));
  assert.equal(refreshed.status, 200, await refreshed.clone().text());
  const narrow = await refreshed.json() as { access_token: string };
  const narrowApi = await f.call(new Request(`${ORIGIN}/mcp`, { headers: { Authorization: `Bearer ${narrow.access_token}` } }));
  assert.deepEqual((await narrowApi.json() as { principal: Principal }).principal.scopes, ['bridge:read']);
  const forgedCtx = Object.assign(f.context(), { props: session.principal, auth: { userId: session.principal.userId } });
  assert.equal(await getPrincipal(new Request(`${ORIGIN}/mcp`, { headers: { Authorization: 'Bearer forged' } }), f.env, forgedCtx), null);
  assert.equal((await f.call(new Request(`${ORIGIN}/mcp`, { headers: { Authorization: 'Bearer forged' } }))).status, 401);
});

test('consent rejects cross-user binding, widened scopes, bad CSRF and changed sessions', async () => {
  const f = fixture();
  const session = await login(f);
  const client = await registerClient(f);
  const consent = await openConsent(f, client.auth, session.jar);
  const fields = new URLSearchParams({ handle: consent.handle, csrf: 'wrong', decision: 'approve', workspaceId: 'workspace-other-user', sourceId: 'browser-other-user', scope: 'bridge:read' });
  assert.equal((await f.call(postForm('/oauth/authorize', session.jar, fields))).status, 403);
  fields.set('csrf', session.csrfToken);
  assert.equal((await f.call(postForm('/oauth/authorize', new Cookies(), fields))).status, 403);
  fields.append('scope', 'administrator');
  assert.equal((await f.call(postForm('/oauth/authorize', session.jar, fields))).status, 400);
  fields.delete('scope'); fields.append('scope', 'bridge:read');
  assert.equal((await f.call(postForm('/oauth/authorize', session.jar, fields))).status, 403);
  assert.equal([...f.values.keys()].some((key) => key.startsWith('grant:')), false);
});

test('anonymous authorization asks for human POST before Google and never grants automatically', async () => {
  const f = fixture();
  const client = await registerClient(f);
  const jar = new Cookies();
  const consent = await openConsent(f, client.auth, jar);
  assert.ok(consent.content.includes('使用 Google 登录并继续'));
  const response = await f.call(postForm('/oauth/authorize', jar, new URLSearchParams({ handle: consent.handle, decision: 'signin' })));
  assert.equal(response.status, 302, await response.clone().text());
  const google = new URL(response.headers.get('Location')!);
  assert.equal(google.origin, 'https://accounts.google.com');
  jar.add(response);
  assert.equal([...f.values.keys()].some((key) => key.startsWith('grant:')), false);
  const loggedIn = await finishLogin(f, { jar, google, state: google.searchParams.get('state')!, nonce: google.searchParams.get('nonce')! });
  assert.equal(loggedIn.response.status, 302);
  const finalConsent = new URL(loggedIn.response.headers.get('Location')!);
  assert.equal(finalConsent.pathname, '/oauth/authorize');
  assert.equal(finalConsent.searchParams.get('client_id'), client.clientId);
  assert.equal([...f.values.keys()].some((key) => key.startsWith('grant:')), false);
  assert.ok((await openConsent(f, finalConsent, jar)).content.includes('工作区编号'));
});
