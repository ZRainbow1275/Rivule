import {MAX_SOURCES} from './source-registry.ts';
/** Application policy around the official OAuthProvider. No token issuer lives here. */
import type {DiagnosticTrace} from './diagnostics.ts';
import type { AuthRequest, ConsentDescription, OAuthHelpers, OAuthResourceAuth } from '@cloudflare/workers-oauth-provider';
import { Rejected, identifier,sourceAllows } from './contracts.ts';
import type { Source } from './contracts.ts';
import { loadBindings, jsonResponse, safeError } from './auth.ts';
import type { Bindings } from './auth.ts';

export const PA_SCOPES = ['pa:publish', 'pa:receipt'] as const;
export type PaScope = typeof PA_SCOPES[number];
/** RFC 6749 section 3.3 server default, proposed on the same explicit consent page. */
export function withDefaultAuthorizationScope(request: Request): Request {
  const url = new URL(request.url), values = url.searchParams.getAll('scope');
  if (values.length === 0) {
    url.searchParams.set('scope', PA_SCOPES.join(' '));
    return new Request(url, request);
  }
  // Never turn explicitly empty/malformed/duplicated requests into broader defaults.
  if (values.length !== 1 || !/^[\x21\x23-\x5B\x5D-\x7E]+(?: [\x21\x23-\x5B\x5D-\x7E]+)*$/.test(values[0])) throw new Rejected('invalid_scope', 403);
  validatePaScopes(values[0].split(' '));
  return request;
}
/** Vendor extension: no standard OAuth metadata field defines a default scope. */
export async function withScopePolicyMetadata(request: Request, response: Response): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.pathname !== '/.well-known/oauth-authorization-server' || !response.ok) return response;
  const data = await response.json() as Record<string, unknown>;
  data.rivule_scope_policy = { omitted_scope: [...PA_SCOPES], explicit_empty_scope: 'invalid_scope', consent_required: true, source_binding: 'one_owner_approved_source', project_policy: 'existing_owner_allowlist' };
  return new Response(JSON.stringify(data), {status: response.status, headers: response.headers});
}

export type OAuthClientBinding = { client_id: string; source_id: string };
export type OAuthConfig = { bindings: Bindings; clients: OAuthClientBinding[]; resource: string; ownerSubject: string; allowDynamicClients: boolean; diagnosticReaderSourceId?:string|null };
export type OAuthProps = { version: 1; owner_id: string; source_id: string; client_id: string };
export type OAuthContext = { props: unknown; auth: OAuthResourceAuth };
export type OAuthHelperPort = Pick<OAuthHelpers, 'parseAuthRequest' | 'describeConsent' | 'beginConsent' | 'approveConsent' | 'denyConsent' | 'beginUpstream' | 'finishUpstream' | 'completeAuthorization'>;
export type VerifiedIdentity = { subject: string; email?: string };
export type UpstreamState = { verifier: string; nonce: string; source_id?: string };
export type IdentityPort = {
  /** Fixed operator-controlled upstream login origin, never obtained from a request. */
  formActionOrigin?: string;
  /** Only a fixed, operator-configured Access SaaS authorization URL may be returned. */
  authorizationUrl(state: string, proof: UpstreamState): Promise<string>;
  /** Must exchange the code and cryptographically verify ID-token issuer, audience, time and nonce. */
  authenticate(code: string, proof: UpstreamState): Promise<VerifiedIdentity>;
  allowedEmail?: string;
  allowedSubject?: string;
};

export function loadOAuthConfig(env: Record<string, any>, bindings = loadBindings(env)): OAuthConfig {
  if (env.OAUTH_ALLOW_DYNAMIC_CLIENTS !== undefined && !['true', 'false'].includes(env.OAUTH_ALLOW_DYNAMIC_CLIENTS)) throw new Rejected('oauth_dynamic_config_invalid', 503);
  const allowDynamicClients = env.OAUTH_ALLOW_DYNAMIC_CLIENTS === 'true';
  let clients: unknown;
  try { clients = JSON.parse(env.OAUTH_CLIENT_BINDINGS_JSON); } catch { throw new Rejected('oauth_client_config_missing', 503); }
  if (!Array.isArray(clients) || !allowDynamicClients && clients.length < 1 || clients.length > MAX_SOURCES) throw new Rejected('oauth_client_config_invalid', 503);
  const ids = new Set<string>();
  const sources = new Set<string>();
  for (const item of clients) {
    if (!item || typeof item !== 'object' || Object.keys(item).sort().join(',') !== 'client_id,source_id' ||
        typeof item.client_id !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(item.client_id) || ids.has(item.client_id)) {
      throw new Rejected('oauth_client_config_invalid', 503);
    }
    identifier(item.source_id);
    if (sources.has(item.source_id) || !bindings.sources.some(s => s.source_id === item.source_id&&sourceAllows(s,'oauth'))) throw new Rejected('oauth_client_config_invalid', 503);
    ids.add(item.client_id); sources.add(item.source_id);
  }
  const reader=env.DIAGNOSTIC_READER_SOURCE_ID;
  if(reader!==undefined&&reader!==''&&(typeof reader!=='string'||!bindings.sources.some(s=>s.source_id===reader&&s.enabled&&s.provider==='dot')))throw new Rejected('diagnostic_reader_config_invalid',503);
  return { bindings, clients: clients as OAuthClientBinding[], resource: bindings.publicOrigin + '/mcp', ownerSubject: encodeURIComponent(bindings.ownerId), allowDynamicClients,diagnosticReaderSourceId:env.DIAGNOSTICS_ENABLED==='true'&&reader?reader:null };
}
export function isDiagnosticReader(source:Source,config:OAuthConfig):boolean{return !!config.diagnosticReaderSourceId&&source.enabled&&source.provider==='dot'&&source.source_id===config.diagnosticReaderSourceId;}

export function sourceForOAuthClient(config: OAuthConfig, clientId: unknown): Source {
  if (typeof clientId !== 'string') throw new Rejected('oauth_client_not_bound', 403);
  const binding = config.clients.find(c => c.client_id === clientId);
  const source = binding && config.bindings.sources.find(s => s.source_id === binding.source_id);
  if (!source?.enabled||!sourceAllows(source,'oauth')) throw new Rejected('oauth_client_not_bound', 403);
  return source;
}

/** A static binding always wins. Dynamic source authority exists only in an approved grant/state. */
function selectedSource(config: OAuthConfig, clientId: unknown, selected: unknown): Source {
  if (typeof clientId !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(clientId)) throw new Rejected('oauth_client_not_bound', 403);
  if (config.clients.some(client => client.client_id === clientId)) {
    const source = sourceForOAuthClient(config, clientId);
    if (selected !== undefined && selected !== source.source_id) throw new Rejected('source_not_authorized', 403);
    return source;
  }
  if (!config.allowDynamicClients || typeof selected !== 'string') throw new Rejected('oauth_client_not_bound', 403);
  const source = config.bindings.sources.find(source => source.source_id === selected && source.enabled&&sourceAllows(source,'oauth'));
  if (!source) throw new Rejected('source_not_authorized', 403);
  return source;
}

export function validatePaScopes(scopes: unknown): PaScope[] {
  if (!Array.isArray(scopes) || scopes.length < 1 || scopes.length > PA_SCOPES.length || new Set(scopes).size !== scopes.length ||
      scopes.some(s => typeof s !== 'string' || !(PA_SCOPES as readonly string[]).includes(s))) throw new Rejected('invalid_scope', 403);
  return [...scopes] as PaScope[];
}

/** Call ONLY inside OAuthProvider.apiHandler, never populate ctx from HTTP headers or JSON. */
export function authorizeOAuthContext(request: Request, ctx: OAuthContext, config: OAuthConfig, needed: PaScope[] = [], now = Date.now()): Source {
  const url = new URL(request.url), auth = ctx?.auth, props = ctx?.props as Partial<OAuthProps> | undefined;
  if (url.origin !== config.bindings.publicOrigin || url.search || url.hash ||
      request.headers.has('origin') && request.headers.get('origin') !== config.bindings.publicOrigin) throw new Rejected('origin_not_accepted', 403);
  if (!auth || auth.audience !== config.resource || auth.userId !== config.ownerSubject ||
      typeof auth.expiresAt !== 'number' || !Number.isFinite(auth.expiresAt) || auth.expiresAt <= now / 1000 ||
      !props || props.version !== 1 || props.owner_id !== config.bindings.ownerId || props.client_id !== auth.clientId) {
    throw new Rejected('invalid_token_binding', 403);
  }
  const source = selectedSource(config, auth.clientId, props.source_id);
  if (props.source_id !== source.source_id || url.pathname !== '/mcp/' + source.source_id) throw new Rejected('source_not_authorized', 403);
  const scopes = validatePaScopes(auth.scope);
  if (needed.some(scope => !scopes.includes(scope))) throw new Rejected('insufficient_scope', 403);
  return source;
}

function authorizeRequest(auth: AuthRequest, config: OAuthConfig): Source | undefined {
  // The library is responsible for registered redirect, response type and PKCE validation.
  if (auth.resource !== config.resource || auth.issuer !== config.bindings.publicOrigin || auth.responseType !== 'code') throw new Rejected('oauth_request_not_bound', 403);
  validatePaScopes(auth.scope);
  if (config.clients.some(client => client.client_id === auth.clientId) || !config.allowDynamicClients) return sourceForOAuthClient(config, auth.clientId);
  if (typeof auth.clientId !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(auth.clientId) || !config.bindings.sources.some(source => source.enabled&&sourceAllows(source,'oauth'))) throw new Rejected('oauth_client_not_bound', 403);
  // Reaching this branch requires the real SDK to have validated this registered client's request.
  return undefined;
}

const escape = (value: string) => value.replace(/[&<>"']/g, char => '&#' + char.charCodeAt(0) + ';');
function consentPage(details: ConsentDescription, handle: string, source: Source | undefined, request: AuthRequest, config: OAuthConfig): string {
  const scopes = validatePaScopes(request.scope).map(scope => `<label><input type="checkbox" name="scope" value="${scope}" checked> ${scope === 'pa:publish' ? '发布此来源的任务状态（写入并可能发送 Discord 通知）' : '查询此来源自己提交的回执'}</label><br>`).join('');
  const sourceChoice = source ? `<p>固定来源：${escape(source.display_name)}（${escape(source.source_id)}）</p><input type="hidden" name="source_id" value="${escape(source.source_id)}">` :
    `<p>此客户端自行登记，名称不证明其身份。请选择你正在连接的来源：</p><label>授权来源 <select name="source_id" required><option value="" selected disabled>请选择你正在连接的 PA</option>${config.bindings.sources.filter(source => source.enabled&&sourceAllows(source,'oauth')).map(source => `<option value="${escape(source.source_id)}">${escape(source.display_name)}（${escape(source.source_id)}）</option>`).join('')}</select></label><p>每次授权仅允许一个来源；同一客户端重新授权会替换它之前的授权。</p>`;
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>授权 PA Terminal</title><h1>允许 ${escape(details.clientName)} 连接？</h1><p>授权将返回 ${escape(details.redirectHost)}。${details.clientDomain ? '客户端域名：' + escape(details.clientDomain) : '客户端名称由其自行声明。'}</p>${details.redirectIsLoopback ? '<p>这会授权你电脑上的应用；仅在你刚发起连接时继续。</p>' : ''}<p>接收人固定为已配置的本人 Discord 私信。这里不批准、恢复或执行原平台任务。</p><form method="post" action="/authorize"><input type="hidden" name="handle" value="${escape(handle)}">${sourceChoice}${scopes}<p><button name="decision" value="approve">允许并登录</button> <button name="decision" value="deny">拒绝</button></p></form></html>`;
}

function hardened(headers = new Headers(), formOrigins: string[] = []): Headers {
  headers.set('cache-control', 'no-store');
  const origins = formOrigins.map(value => {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.origin !== value) throw new Rejected('invalid_form_destination', 503);
    // URL parsers accept characters such as '*' and ';' in hostnames; these have
    // different meanings in CSP and must never be serialized into a directive.
    const host = url.hostname;
    const loopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
    const dnsHost = host.length <= 253 && host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
    if (!(dnsHost || host === '[::1]') || url.protocol === 'http:' && !loopback) throw new Rejected('invalid_form_destination', 503);
    return url.origin;
  });
  headers.set('content-security-policy', "default-src 'none'; form-action 'self'" + (origins.length ? ' ' + [...new Set(origins)].join(' ') : '') + "; frame-ancestors 'none'; base-uri 'none'");
  headers.set('x-frame-options', 'DENY');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  return headers;
}
function randomProof(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function proofValid(value: any): value is UpstreamState {
  return value && typeof value === 'object' && /^[A-Za-z0-9_-]{43}$/.test(value.verifier) && /^[A-Za-z0-9_-]{43}$/.test(value.nonce);
}
async function consentForm(request: Request): Promise<URLSearchParams> {
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/x-www-form-urlencoded') throw new Rejected('form_required', 415);
  const reader = request.body?.getReader();
  if (!reader) throw new Rejected('invalid_consent', 400);
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const next = await reader.read(); if (next.done) break;
    size += next.value.length;
    if (size > 4096) { await reader.cancel(); throw new Rejected('body_too_large', 413); }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let form: URLSearchParams;
  try { form = new URLSearchParams(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)); } catch { throw new Rejected('invalid_consent', 400); }
  if ([...form.keys()].some(k => !['handle', 'decision', 'scope', 'source_id'].includes(k)) || form.getAll('source_id').length > 1 || form.getAll('handle').length !== 1 ||
      form.getAll('decision').length !== 1 || !form.get('handle') || form.get('handle')!.length > 200 ||
      !['approve', 'deny'].includes(form.get('decision')!)) throw new Rejected('invalid_consent', 400);
  return form;
}

/** SDK helpers own CSRF, browser cookies, state, expiry and OAuth redirects. This layer owns app policy. */
export async function handleOAuthAuthorization(request: Request, config: OAuthConfig, oauth: OAuthHelperPort, identity: IdentityPort, trace?:DiagnosticTrace): Promise<Response> {
  let clearHeaders: Headers | undefined;
  try {
    const url = new URL(request.url);
    if (url.origin !== config.bindings.publicOrigin || request.headers.has('authorization')) throw new Rejected('origin_not_accepted', 403);
    if (url.pathname === '/authorize' && request.method === 'GET') {
      // Dynamic mode still delegates registered client/redirect/PKCE validation to the official SDK.
      if (url.searchParams.getAll('client_id').length !== 1) throw new Rejected('oauth_client_not_bound', 403);
      if (!config.allowDynamicClients || config.clients.some(client => client.client_id === url.searchParams.get('client_id'))) sourceForOAuthClient(config, url.searchParams.get('client_id'));
      const auth = await oauth.parseAuthRequest(withDefaultAuthorizationScope(request));trace?.mark('oauth_parse');
      const source = authorizeRequest(auth, config);
      const details = await oauth.describeConsent(auth);
      const consent = await oauth.beginConsent(auth);trace?.mark('oauth_consent');
      // CSP is checked across form redirects in some browsers. Permit only the fixed
      // identity origin and this SDK-validated registered callback (for Deny).
      const formOrigins = [new URL(auth.redirectUri).origin];
      if (identity.formActionOrigin) formOrigins.push(identity.formActionOrigin);
      const headers = hardened(consent.headers, formOrigins); headers.set('content-type', 'text/html; charset=utf-8');
      // no-referrer makes native form POST Origin null. Do not relax the strict
      // POST check: use same-origin only on this HTML page, never sending a Referer
      // to the upstream identity site or the registered cross-origin callback.
      headers.set('referrer-policy', 'same-origin');
      return new Response(consentPage(details, consent.handle, source, auth, config), { headers });
    }
    if (url.pathname === '/authorize' && request.method === 'POST') {
      if (url.search || request.headers.get('origin') !== config.bindings.publicOrigin) throw new Rejected('origin_not_accepted', 403);
      const form = await consentForm(request);
      if (form.get('decision') === 'deny') {
        const denied = await oauth.denyConsent(request, form.get('handle')!);
        return new Response(null, { status: 302, headers: hardened(denied.headers) });
      }
      const scope = validatePaScopes(form.getAll('scope'));
      const approved = await oauth.approveConsent(request, form.get('handle')!, { scope });
      clearHeaders = approved.headers;
      authorizeRequest(approved.request, config);
      const source = selectedSource(config, approved.request.clientId, form.get('source_id') ?? undefined);trace?.source(source.source_id);trace?.mark('oauth_source');
      const proof = { verifier: randomProof(), nonce: randomProof(), source_id: source.source_id };
      const upstream = await oauth.beginUpstream(approved.request, { data: proof, headers: approved.headers });
      clearHeaders = upstream.headers;
      const destination = await identity.authorizationUrl(upstream.state, proof);trace?.mark('oauth_upstream');
      const headers = hardened(upstream.headers); headers.set('location', destination);
      return new Response(null, { status: 302, headers });
    }
    if (url.pathname === '/callback' && request.method === 'GET') {
      if (url.searchParams.getAll('state').length !== 1 || !url.searchParams.get('state')) throw new Rejected('invalid_oauth_state', 400);
      const resumed = await oauth.finishUpstream<UpstreamState>(request);trace?.mark('oauth_callback');
      clearHeaders = resumed.headers;
      authorizeRequest(resumed.request, config);
      if (url.searchParams.has('error')) throw new Rejected('access_denied', 403);
      if (url.searchParams.getAll('code').length !== 1 || !url.searchParams.get('code') || url.searchParams.get('code')!.length > 4096 || !proofValid(resumed.data)) throw new Rejected('invalid_oauth_callback', 400);
      if (typeof resumed.data.source_id !== 'string') throw new Rejected('source_not_authorized', 403);
      const source = selectedSource(config, resumed.request.clientId, resumed.data.source_id);trace?.source(source.source_id);
      const verified = await identity.authenticate(url.searchParams.get('code')!, resumed.data);
      const bySubject=typeof identity.allowedSubject==='string'&&identity.allowedSubject.length>0,byEmail=typeof identity.allowedEmail==='string'&&identity.allowedEmail.length>0;
      if(bySubject===byEmail)throw new Rejected('identity_policy_invalid',503);
      if (!verified || typeof verified.subject !== 'string' || verified.subject.length < 1 ||
          bySubject&&(identity.allowedSubject!==config.bindings.userId||verified.subject!==identity.allowedSubject) ||
          byEmail&&(typeof verified.email!=='string'||verified.email.toLowerCase()!==identity.allowedEmail!.toLowerCase())) throw new Rejected('access_identity_not_allowed', 403);
      const props: OAuthProps = { version: 1, owner_id: config.bindings.ownerId, source_id: source.source_id, client_id: resumed.request.clientId };
      const completed = await oauth.completeAuthorization({ request: resumed.request, userId: config.ownerSubject, metadata: {}, scope: validatePaScopes(resumed.request.scope), props });
      trace?.mark('oauth_complete');const headers = hardened(resumed.headers); headers.set('location', completed.redirectTo);
      return new Response(null, { status: 302, headers });
    }
    return jsonResponse({ error: 'not_found' }, 404);
  } catch (error) {
    // Never include SDK errors, callback codes, state, emails, tokens or secrets in responses/logs.
    const response = error instanceof Rejected ? safeError(error) :
      error instanceof Error && error.name === 'AuthorizationError' ? jsonResponse({ error: 'oauth_request_failed' }, 400) :
      jsonResponse({ error: 'oauth_service_unavailable' }, 503);
    trace?.mark('oauth_policy',error instanceof Rejected?error.code:error instanceof Error&&error.name==='AuthorizationError'?'oauth_authorization_error':'oauth_service_unavailable',response.status);const headers = hardened(clearHeaders ?? new Headers()); headers.set('content-type', 'application/json');
    return new Response(response.body, { status: response.status, headers });
  }
}
