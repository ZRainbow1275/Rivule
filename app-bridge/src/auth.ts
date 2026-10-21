import type {
  AuthRequest,
  ConsentDescription,
  OAuthHelpers,
  OAuthResourceAuth,
} from '@cloudflare/workers-oauth-provider';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';

export type Principal = {
  userId: string;
  email: string;
  sourceId: string;
  workspaceId?: string;
  kind: 'session' | 'mcp' | 'connector';
  scopes: string[];
};

export interface AuthEnv {
  AUTH_KV: KVNamespace;
  PUBLIC_ORIGIN: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  INVITED_EMAILS?: string;
  OAUTH_PROVIDER?: OAuthHelpers;
}

export type AuthBinding = { workspaceId: string; sourceId: string };
export type AuthOptions<Env extends AuthEnv = AuthEnv> = {
  authorizeBinding?: (principal: Principal, binding: AuthBinding, env: Env, ctx: ExecutionContext) => Promise<boolean>;
  consumeOnce?: (key: string, expiresAt: number, env: Env, ctx: ExecutionContext) => Promise<boolean>;
};

const SCOPES = ['bridge:read', 'bridge:write', 'bridge:control'];
const SESSION_SECONDS = 8 * 60 * 60;
const FLOW_SECONDS = 10 * 60;
const CONNECTOR_SECONDS = 7 * 24 * 60 * 60;
const SESSION_COOKIE = '__Host-rivule_session';
const GOOGLE_CALLBACK = '/auth/google/callback';
const trustedMcp = Symbol('verified OAuthProvider request');
const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const emailSchema = z.email().max(254).transform((email) => email.toLowerCase());
const bindingId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const bindingSchema = z.object({ workspaceId: bindingId, sourceId: bindingId });
const principalSchema = z.object({
  userId: z.string().min(1).max(200),
  email: emailSchema,
  sourceId: bindingId,
  workspaceId: bindingId.optional(),
  kind: z.enum(['session', 'mcp', 'connector']),
  scopes: z.array(z.enum(['bridge:read', 'bridge:write', 'bridge:control'])),
});
const sessionSchema = z.object({ principal: principalSchema, csrfToken: z.string(), expiresAt: z.number() });
type Session = { principal: Principal; csrfToken: string; expiresAt: number };
type LoginState = { nonce: string; verifier: string; returnTo: string; browserHash: string; expiresAt: number };
type ConsentState = { sessionHash: string | null; scope: string[]; expiresAt: number };
type ConnectorRecord = { principal: Principal; tokenHash: string; expiresAt: number };
type TrustedContext = ExecutionContext & { [trustedMcp]?: { request: Request; principal: Principal } };

export class AuthError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function randomToken(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function challenge(verifier: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function equal(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function publicOrigin(env: AuthEnv): string {
  const url = new URL(env.PUBLIC_ORIGIN);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.origin !== env.PUBLIC_ORIGIN) {
    throw new AuthError(503, 'PUBLIC_ORIGIN 必须是无路径的 HTTPS 来源。');
  }
  return url.origin;
}

function cookie(request: Request, name: string): string | null {
  const values = (request.headers.get('Cookie') ?? '').split(';').map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  return values.length === 1 ? values[0]!.slice(name.length + 1) : null;
}

function setCookie(headers: Headers, name: string, value: string, seconds: number): void {
  headers.append('Set-Cookie', `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${seconds}`);
}

function safeHeaders(): Headers {
  return new Headers({
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: safeHeaders() });
}

function html(title: string, body: string, headers = safeHeaders(), status = 200): Response {
  for (const [name, value] of safeHeaders()) headers.set(name, value);
  headers.set('Content-Type', 'text/html; charset=utf-8');
  return new Response(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>body{font:16px/1.7 system-ui,sans-serif;max-width:620px;margin:8vh auto;padding:24px;color:#17242b;background:#f5f7f7}main{background:white;padding:32px;border-radius:16px}h1{line-height:1.3}label{display:block;margin:16px 0}input:not([type=checkbox]){box-sizing:border-box;width:100%;padding:10px;font:inherit}button{font:inherit;padding:10px 18px;margin:12px 12px 0 0;cursor:pointer}small{display:block;color:#425660}code{overflow-wrap:anywhere}</style><main><h1>${escape(title)}</h1>${body}</main></html>`, { status, headers });
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

async function limitedText(body: ReadableStream<Uint8Array> | null, limit = 16_384): Promise<string> {
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new AuthError(413, '请求内容过大。');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const all = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(all);
}

async function form(request: Request): Promise<URLSearchParams> {
  if (request.headers.get('Content-Type')?.split(';')[0]?.trim() !== 'application/x-www-form-urlencoded') {
    throw new AuthError(415, '请使用授权页面提交表单。');
  }
  return new URLSearchParams(await limitedText(request.body));
}

function field(data: URLSearchParams, name: string): string {
  const values = data.getAll(name);
  if (values.length !== 1) throw new AuthError(400, `表单字段 ${name} 无效。`);
  return values[0]!;
}

async function invited(email: string, env: AuthEnv): Promise<boolean> {
  const normalized = emailSchema.parse(email);
  let bootstrap: string[] = [];
  try { bootstrap = z.array(emailSchema).max(200).parse(JSON.parse(env.INVITED_EMAILS ?? '[]')); } catch { /* invalid bootstrap stays closed */ }
  return bootstrap.includes(normalized) || await env.AUTH_KV.get(`auth:invite:${await digest(normalized)}`) === 'allowed';
}

/** Call only after the application's administrator authorization and CSRF check. */
export async function allowInvitedEmail(email: string, env: AuthEnv): Promise<void> {
  const normalized = emailSchema.parse(email.trim());
  await env.AUTH_KV.put(`auth:invite:${await digest(normalized)}`, 'allowed');
}

async function readSession(request: Request, env: AuthEnv): Promise<Session | null> {
  const token = cookie(request, SESSION_COOKIE);
  if (!token || !/^[\w-]{43}$/.test(token)) return null;
  const record = sessionSchema.safeParse(await env.AUTH_KV.get(`auth:session:${await digest(token)}`, 'json'));
  if (!record.success || record.data.expiresAt <= Date.now() || record.data.principal.kind !== 'session') return null;
  return record.data;
}

export async function getPrincipal(request: Request, env: AuthEnv, ctx?: ExecutionContext): Promise<Principal | null> {
  const verified = (ctx as TrustedContext | undefined)?.[trustedMcp];
  if (verified?.request === request) return verified.principal;
  const authorization = request.headers.get('Authorization');
  if (authorization !== null) {
    const match = /^Bearer (rvbc_[\w-]{43}\.[\w-]{43})$/i.exec(authorization);
    if (!match) return null;
    const token = match[1]!;
    const tokenId = token.slice(5, token.indexOf('.'));
    const record = await env.AUTH_KV.get<ConnectorRecord>(`auth:connector:${tokenId}`, 'json');
    if (!record || record.expiresAt <= Date.now() || !equal(record.tokenHash, await digest(token))) return null;
    const parsed = principalSchema.safeParse(record.principal);
    return parsed.success && parsed.data.kind === 'connector' && parsed.data.workspaceId ? parsed.data : null;
  }
  return (await readSession(request, env))?.principal ?? null;
}

function isExtensionConnectorRequest(request: Request, principal: Principal | null): boolean {
  return principal?.kind === 'connector' && request.method === 'POST' && !request.headers.has('Cookie') &&
    /^chrome-extension:\/\/[a-p]{32}$/.test(request.headers.get('Origin') ?? '') &&
    ['/api/connector/claim', '/api/connector/heartbeat', '/api/connector/result'].includes(new URL(request.url).pathname);
}

/** Session writes require same-origin + synchronizer token; verified bearer calls have no ambient cookie authority. */
export async function validateCsrf(request: Request, env: AuthEnv, ctx?: ExecutionContext): Promise<boolean> {
  const origin = request.headers.get('Origin');
  const principal = await getPrincipal(request, env, ctx);
  if (!principal) return false;
  if (origin !== null && origin !== publicOrigin(env)) return isExtensionConnectorRequest(request, principal);
  if (principal.kind !== 'session') return true;
  const session = await readSession(request, env);
  return origin === publicOrigin(env) && !!session && equal(session.csrfToken, request.headers.get('X-CSRF-Token') ?? '');
}

export async function issueConnector(principal: Principal, env: AuthEnv, binding: AuthBinding): Promise<{ token: string; tokenId: string; expires_at: string }> {
  if (principal.kind !== 'session' || !principal.scopes.includes('bridge:control')) throw new AuthError(403, '请从工作台创建连接器凭据。');
  const validated = bindingSchema.parse(binding);
  const tokenId = randomToken();
  const token = `rvbc_${tokenId}.${randomToken()}`;
  const expiresAt = Date.now() + CONNECTOR_SECONDS * 1000;
  const record: ConnectorRecord = {
    tokenHash: await digest(token), expiresAt,
    principal: { ...principal, ...validated, kind: 'connector', scopes: ['bridge:read', 'bridge:write'] },
  };
  await env.AUTH_KV.put(`auth:connector:${tokenId}`, JSON.stringify(record), { expirationTtl: CONNECTOR_SECONDS });
  return { token, tokenId, expires_at: new Date(expiresAt).toISOString() };
}

export async function revokeConnector(principal: Principal, env: AuthEnv, tokenId: string): Promise<void> {
  if (principal.kind !== 'session' || !principal.scopes.includes('bridge:control')) throw new AuthError(403, '请从工作台撤销连接器凭据。');
  if (!/^[\w-]{43}$/.test(tokenId)) throw new AuthError(400, '连接器编号无效。');
  const record = await env.AUTH_KV.get<ConnectorRecord>(`auth:connector:${tokenId}`, 'json');
  if (!record) return;
  if (record.principal.userId !== principal.userId) throw new AuthError(403, '只能撤销自己的连接器。');
  await env.AUTH_KV.delete(`auth:connector:${tokenId}`);
}

function returnUrl(value: string | null, origin: string): string {
  const url = new URL(value ?? '/', origin);
  if (url.origin !== origin || !['/', '/oauth/authorize'].includes(url.pathname) || url.hash || url.username || url.password) {
    throw new AuthError(400, '登录返回地址无效。');
  }
  return url.href;
}

function authRequestUrl(request: AuthRequest, origin: string): string {
  const url = new URL('/oauth/authorize', origin);
  for (const [name, value] of Object.entries({
    response_type: request.responseType, client_id: request.clientId, redirect_uri: request.redirectUri,
    scope: request.scope.join(' '), state: request.state, resource: request.resource,
    code_challenge: request.codeChallenge, code_challenge_method: request.codeChallengeMethod,
  })) if (value !== undefined) url.searchParams.set(name, value);
  return url.href;
}

function googleConfigured(env: AuthEnv): boolean { return !!env.GOOGLE_CLIENT_ID && !!env.GOOGLE_CLIENT_SECRET; }

async function beginGoogle<Env extends AuthEnv>(request: Request, env: Env, options: AuthOptions<Env>, destination: string): Promise<Response> {
  if (!googleConfigured(env) || !options.consumeOnce) throw new AuthError(503, 'Google 登录尚未配置完成，请按配置向导设置。');
  const state = randomToken();
  const browser = randomToken();
  const stateHash = await digest(state);
  const data: LoginState = {
    nonce: randomToken(), verifier: randomToken(), returnTo: returnUrl(destination, publicOrigin(env)),
    browserHash: await digest(browser), expiresAt: Date.now() + FLOW_SECONDS * 1000,
  };
  await env.AUTH_KV.put(`auth:google:${stateHash}`, JSON.stringify(data), { expirationTtl: FLOW_SECONDS });
  const google = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  for (const [name, value] of Object.entries({
    client_id: env.GOOGLE_CLIENT_ID!, redirect_uri: `${publicOrigin(env)}${GOOGLE_CALLBACK}`,
    response_type: 'code', scope: 'openid email', state, nonce: data.nonce,
    code_challenge: await challenge(data.verifier), code_challenge_method: 'S256', prompt: 'select_account',
  })) google.searchParams.set(name, value);
  const headers = safeHeaders();
  setCookie(headers, `__Host-rivule_login_${stateHash.slice(0, 24)}`, browser, FLOW_SECONDS);
  headers.set('Location', google.href);
  return new Response(null, { status: 302, headers });
}

async function googleCallback<Env extends AuthEnv>(request: Request, env: Env, ctx: ExecutionContext, options: AuthOptions<Env>): Promise<Response> {
  if (!googleConfigured(env) || !options.consumeOnce) throw new AuthError(503, 'Google 登录尚未配置完成。');
  const url = new URL(request.url);
  const state = url.searchParams.get('state') ?? '';
  if (!/^[\w-]{43}$/.test(state) || url.searchParams.getAll('state').length !== 1) throw new AuthError(400, '登录状态无效，请重新登录。');
  const stateHash = await digest(state);
  const cookieName = `__Host-rivule_login_${stateHash.slice(0, 24)}`;
  const browser = cookie(request, cookieName);
  const data = await env.AUTH_KV.get<LoginState>(`auth:google:${stateHash}`, 'json');
  if (!data || data.expiresAt <= Date.now() || !browser || !equal(data.browserHash, await digest(browser))) {
    throw new AuthError(400, '登录已过期或浏览器不匹配，请重新登录。');
  }
  if (!await options.consumeOnce(`google:${stateHash}`, data.expiresAt, env, ctx)) throw new AuthError(400, '该登录请求已使用，请重新登录。');
  await env.AUTH_KV.delete(`auth:google:${stateHash}`);
  const headers = safeHeaders();
  setCookie(headers, cookieName, '', 0);
  if (url.searchParams.has('error')) return html('登录已取消', '<p>Google 登录未完成。你可以返回工作台重试。</p><a href="/">返回工作台</a>', headers);
  const code = url.searchParams.get('code');
  if (!code || code.length > 4096 || url.searchParams.getAll('code').length !== 1) throw new AuthError(400, 'Google 未返回有效授权码。');
  const exchanged = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, code,
      redirect_uri: `${publicOrigin(env)}${GOOGLE_CALLBACK}`, grant_type: 'authorization_code', code_verifier: data.verifier,
    }), signal: AbortSignal.timeout(10_000),
  });
  if (!exchanged.ok) throw new AuthError(401, 'Google 授权码兑换失败，请重新登录。');
  const tokens = z.object({ id_token: z.string().max(16_384) }).safeParse(JSON.parse(await limitedText(exchanged.body, 65_536)));
  if (!tokens.success) throw new AuthError(401, 'Google 身份响应无效。');
  let identity: { sub: string; email: string };
  try {
    const { payload } = await jwtVerify(tokens.data.id_token, googleKeys, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: env.GOOGLE_CLIENT_ID,
      algorithms: ['RS256'], requiredClaims: ['sub', 'iat', 'exp', 'nonce', 'email', 'email_verified'],
      maxTokenAge: '10m', clockTolerance: 5,
    });
    if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 255 ||
      payload.email_verified !== true || typeof payload.nonce !== 'string' || !equal(payload.nonce, data.nonce) ||
      (payload.azp !== undefined && payload.azp !== env.GOOGLE_CLIENT_ID) ||
      (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== env.GOOGLE_CLIENT_ID)) throw new Error('invalid claims');
    identity = { sub: payload.sub, email: emailSchema.parse(payload.email) };
  } catch { throw new AuthError(401, 'Google 身份验证失败，请重新登录。'); }
  if (!await invited(identity.email, env)) throw new AuthError(403, '该邮箱尚未受邀，请联系工作台管理员。');
  const previous = cookie(request, SESSION_COOKIE);
  if (previous) await env.AUTH_KV.delete(`auth:session:${await digest(previous)}`);
  const token = randomToken();
  const session: Session = {
    principal: { userId: `google_${await digest(identity.sub)}`, email: identity.email, sourceId: 'dashboard', kind: 'session', scopes: [...SCOPES] },
    csrfToken: randomToken(), expiresAt: Date.now() + SESSION_SECONDS * 1000,
  };
  await env.AUTH_KV.put(`auth:session:${await digest(token)}`, JSON.stringify(session), { expirationTtl: SESSION_SECONDS });
  setCookie(headers, SESSION_COOKIE, token, SESSION_SECONDS);
  headers.set('Location', returnUrl(data.returnTo, publicOrigin(env)));
  return new Response(null, { status: 302, headers });
}

function consentPage(details: ConsentDescription, handle: string, session: Session | null): string {
  const scopeLabels: Record<string, string> = { 'bridge:read': '读取任务与结果', 'bridge:write': '提交任务与连接器结果', 'bridge:control': '取消任务等控制操作' };
  const scopes = details.scope.map((scope) => session
    ? `<label><input type="checkbox" name="scope" value="${escape(scope)}" checked${scope === 'bridge:read' ? ' disabled' : ''}> ${escape(scopeLabels[scope] ?? scope)} <code>${escape(scope)}</code>${scope === 'bridge:read' ? '<input type="hidden" name="scope" value="bridge:read">' : ''}</label>`
    : `<li>${escape(scopeLabels[scope] ?? scope)} <code>${escape(scope)}</code></li>`).join('');
  return `<p>客户端 <strong>${escape(details.clientName)}</strong> 请求访问 Rivule。</p>${details.clientDomain ? `<p>客户端发布域名：<strong>${escape(details.clientDomain)}</strong></p>` : '<p>客户端名称由其自行登记，请核对你正在使用的应用。</p>'}<p>授权将返回 <strong>${escape(details.redirectHost)}</strong>。</p>${details.redirectIsLoopback ? '<p><strong>这是本机应用的回调，请确认由你刚刚发起。</strong></p>' : ''}<form method="post" action="/oauth/authorize"><input type="hidden" name="handle" value="${escape(handle)}">${session ? `<p>当前邮箱：${escape(session.principal.email)}</p><input type="hidden" name="csrf" value="${escape(session.csrfToken)}">${scopes}<label>工作区编号<input name="workspaceId" required maxlength="128" autocomplete="off"></label><label>来源编号<input name="sourceId" required maxlength="128" autocomplete="off"></label><small>从工作台复制编号；服务端会核对你的成员身份与来源所有权。凭据仅能访问所选工作区和来源。</small><button name="decision" value="approve">允许访问</button>` : `<ul>${scopes}</ul><p>先登录工作台，再确认工作区、来源和本次权限。</p><button name="decision" value="signin">使用 Google 登录并继续</button>`}<button name="decision" value="deny" formnovalidate>拒绝</button></form>`;
}

async function authorize<Env extends AuthEnv>(request: Request, env: Env, ctx: ExecutionContext, options: AuthOptions<Env>): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  if (!oauth || !options.consumeOnce) throw new AuthError(503, 'OAuth 授权尚未配置完成。');
  const session = await readSession(request, env);
  const sessionToken = cookie(request, SESSION_COOKIE);
  if (request.method === 'GET') {
    const parsed = await oauth.parseAuthRequest(request);
    if (!parsed.scope.length) parsed.scope = ['bridge:read'];
    if (!parsed.scope.includes('bridge:read') || parsed.scope.some((scope) => !SCOPES.includes(scope))) throw new AuthError(400, '请求的权限无效，须包含 bridge:read。');
    const details = await oauth.describeConsent(parsed);
    const consent = await oauth.beginConsent(parsed);
    const state: ConsentState = {
      sessionHash: session && sessionToken ? await digest(sessionToken) : null,
      scope: parsed.scope, expiresAt: Date.now() + FLOW_SECONDS * 1000,
    };
    await env.AUTH_KV.put(`auth:consent:${await digest(consent.handle)}`, JSON.stringify(state), { expirationTtl: FLOW_SECONDS });
    return html('确认客户端访问', consentPage(details, consent.handle, session), consent.headers);
  }
  if (request.method !== 'POST') throw new AuthError(405, '请通过授权页面操作。');
  if (request.headers.get('Origin') !== publicOrigin(env)) throw new AuthError(403, '授权请求来源无效。');
  const data = await form(request);
  const handle = field(data, 'handle');
  if (handle.length > 512) throw new AuthError(400, '授权请求无效。');
  const handleHash = await digest(handle);
  const stored = await env.AUTH_KV.get<ConsentState>(`auth:consent:${handleHash}`, 'json');
  if (!stored || stored.expiresAt <= Date.now()) throw new AuthError(400, '授权页面已过期，请从客户端重试。');
  if (stored.sessionHash !== (session && sessionToken ? await digest(sessionToken) : null)) throw new AuthError(403, '登录身份已变化，请重新打开授权页面。');
  if (session && !equal(session.csrfToken, field(data, 'csrf'))) throw new AuthError(403, '授权校验失败，请重新打开页面。');
  const decision = field(data, 'decision');
  if (!['approve', 'deny', 'signin'].includes(decision)) throw new AuthError(400, '请选择允许或拒绝。');
  if (decision === 'deny') {
    const denied = await oauth.denyConsent(request, handle);
    if (!await options.consumeOnce(`consent:${handleHash}`, stored.expiresAt, env, ctx)) throw new AuthError(400, '授权请求已使用。');
    await env.AUTH_KV.delete(`auth:consent:${handleHash}`);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const scopes = session ? [...new Set(data.getAll('scope'))] : stored.scope;
  if (!scopes.includes('bridge:read') || scopes.some((scope) => !stored.scope.includes(scope))) throw new AuthError(400, '只能授予本次请求的权限，且须包含 bridge:read。');
  const approved = await oauth.approveConsent(request, handle, { scope: scopes });
  if (!await options.consumeOnce(`consent:${handleHash}`, stored.expiresAt, env, ctx)) throw new AuthError(400, '授权请求已使用。');
  await env.AUTH_KV.delete(`auth:consent:${handleHash}`);
  if (!session) {
    if (decision !== 'signin') throw new AuthError(401, '请先登录。');
    const redirect = await beginGoogle(request, env, options, authRequestUrl(approved.request, publicOrigin(env)));
    for (const value of approved.headers.getSetCookie()) redirect.headers.append('Set-Cookie', value);
    return redirect;
  }
  if (decision !== 'approve') throw new AuthError(400, '请确认本次访问权限。');
  const binding = bindingSchema.safeParse({ workspaceId: field(data, 'workspaceId'), sourceId: field(data, 'sourceId') });
  if (!binding.success || !options.authorizeBinding || !await options.authorizeBinding(session.principal, binding.data, env, ctx)) {
    throw new AuthError(403, '无权访问所选工作区或来源，请从客户端重新授权。');
  }
  const { redirectTo } = await oauth.completeAuthorization({
    request: approved.request, userId: session.principal.userId, metadata: {}, scope: scopes,
    props: { ...session.principal, ...binding.data, kind: 'mcp', scopes },
  });
  approved.headers.set('Location', redirectTo);
  return new Response(null, { status: 302, headers: approved.headers });
}

/** The optional hooks are mandatory for login/consent; absent hooks fail closed. */
export function createAuthenticatedWorker<Env extends AuthEnv>(appHandler: ExportedHandler<Env>, options: AuthOptions<Env> = {}): ExportedHandler<Env> {
  return {
    ...appHandler,
    async fetch(request, env, ctx) {
      try {
        const origin = publicOrigin(env);
        if (request.headers.get('Origin') !== null && request.headers.get('Origin') !== origin &&
          !isExtensionConnectorRequest(request, await getPrincipal(request, env, ctx))) return json({ error: '请求来源无效。' }, 403);
        const url = new URL(request.url);
        if (url.origin !== origin) return json({ error: '请求地址无效。' }, 400);
        if (url.pathname === '/auth/status' && request.method === 'GET') {
          const configured = googleConfigured(env);
          return json({ googleConfigured: configured, inviteOnly: true, setupRequired: !configured || !options.consumeOnce, loginPath: '/auth/google/start' });
        }
        if (url.pathname === '/auth/session' && request.method === 'GET') {
          const session = await readSession(request, env);
          return session ? json({ principal: session.principal, csrfToken: session.csrfToken }) : json({ principal: null }, 401);
        }
        if (url.pathname === '/auth/google/start' && request.method === 'GET') return await beginGoogle(request, env, options, returnUrl(url.searchParams.get('return_to'), origin));
        if (url.pathname === GOOGLE_CALLBACK && request.method === 'GET') return await googleCallback(request, env, ctx, options);
        if (url.pathname === '/auth/logout') {
          if (request.method !== 'POST') return json({ error: '退出登录需要 POST。' }, 405);
          const principal = await getPrincipal(request, env, ctx);
          if (principal?.kind !== 'session' || !await validateCsrf(request, env, ctx)) return json({ error: '退出登录校验失败。' }, 403);
          await env.AUTH_KV.delete(`auth:session:${await digest(cookie(request, SESSION_COOKIE)!)}`);
          const headers = safeHeaders();
          setCookie(headers, SESSION_COOKIE, '', 0);
          return new Response(null, { status: 204, headers });
        }
        const { default: OAuthProvider, AuthorizationError, CimdFetchError } = await import('@cloudflare/workers-oauth-provider');
        const provider = new OAuthProvider<Env>({
          apiRoute: '/mcp', authorizeEndpoint: '/oauth/authorize', tokenEndpoint: '/oauth/token',
          clientRegistrationEndpoint: '/oauth/register', scopesSupported: SCOPES, requiredScopes: ['bridge:read'],
          accessTokenTTL: 15 * 60, refreshTokenTTL: 7 * 24 * 60 * 60,
          resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin] },
          apiHandler: {
            async fetch(apiRequest, apiEnv, apiCtx) {
              const props = principalSchema.safeParse(apiCtx.props);
              const auth = (apiCtx as ExecutionContext & { auth: OAuthResourceAuth }).auth;
              if (!props.success || props.data.kind !== 'mcp' || !props.data.workspaceId ||
                auth.audience !== `${origin}/mcp` || auth.userId !== props.data.userId || !auth.scope.includes('bridge:read')) {
                return json({ error: 'OAuth 身份或权限无效。' }, 403);
              }
              (apiCtx as TrustedContext)[trustedMcp] = { request: apiRequest, principal: { ...props.data, scopes: auth.scope.filter((scope) => SCOPES.includes(scope)) } };
              return appHandler.fetch ? appHandler.fetch(apiRequest, apiEnv, apiCtx) : json({ error: '未找到处理器。' }, 404);
            },
          },
          defaultHandler: {
            async fetch(defaultRequest, defaultEnv, defaultCtx) {
              if (new URL(defaultRequest.url).pathname === '/oauth/authorize') return authorize(defaultRequest, defaultEnv, defaultCtx, options);
              if (new URL(defaultRequest.url).pathname.startsWith('/auth/')) return json({ error: '认证路由不存在。' }, 404);
              return appHandler.fetch ? appHandler.fetch(defaultRequest, defaultEnv, defaultCtx) : json({ error: '未找到处理器。' }, 404);
            },
          },
        });
        try {
          let boundedRequest = request;
          if (request.method === 'POST' && url.pathname.startsWith('/oauth/')) boundedRequest = new Request(request, { body: await limitedText(request.body, 65_536) });
          const response = await provider.fetch(boundedRequest, { ...env, OAUTH_KV: env.AUTH_KV }, ctx);
          const headers = new Headers(response.headers);
          for (const name of ['Access-Control-Allow-Origin', 'Access-Control-Allow-Credentials', 'Access-Control-Allow-Headers', 'Access-Control-Allow-Methods']) headers.delete(name);
          if (request.headers.get('Origin') === origin) {
            headers.set('Access-Control-Allow-Origin', origin);
            headers.set('Access-Control-Allow-Credentials', 'true');
            headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-CSRF-Token');
            headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
            headers.append('Vary', 'Origin');
          }
          return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
        } catch (error) {
          if (error instanceof AuthorizationError) return html('授权请求未完成', '<p>授权请求无效、已过期或已使用，请从客户端重新发起。</p><a href="/">返回工作台</a>', safeHeaders(), 400);
          if (error instanceof CimdFetchError) return json({ error: '客户端信息校验失败，请从客户端重试。' }, 400);
          throw error;
        }
      } catch (error) {
        if (error instanceof AuthError) return json({ error: error.message }, error.status);
        // Never serialize upstream errors: their details can contain tokens or credentials.
        return json({ error: '认证服务暂时不可用，请稍后重试。' }, 503);
      }
    },
  };
}
