/** Cloudflare Access SaaS is the identity provider; jose validates its signed ID token. */
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import { Rejected, safeUrl } from './contracts.ts';
import type { OAuthConfig, IdentityPort, UpstreamState, VerifiedIdentity } from './oauth.ts';

export type AccessConfig = {
  clientId: string; issuer: string; authorizationUrl: string; tokenUrl: string;
  jwksUrl: string; callbackUrl: string; allowedEmail: string;
};
export type FetchPort = (url: string, init: RequestInit) => Promise<Response>;

export function loadAccessConfig(env: Record<string, any>, oauth: OAuthConfig): AccessConfig {
  const clientId = env.ACCESS_CLIENT_ID, domain = env.ACCESS_TEAM_DOMAIN;
  if (typeof clientId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(clientId) ||
      typeof domain !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(domain) ||
      typeof env.ACCESS_ALLOWED_EMAIL !== 'string' || !/^[A-Za-z0-9.!#$%&'+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/.test(env.ACCESS_ALLOWED_EMAIL) ||
      env.ACCESS_ALLOWED_EMAIL.length > 254) throw new Rejected('access_config_invalid', 503);
  const base = `https://${domain}/cdn-cgi/access/sso/oidc/${clientId}`;
  for (const [key, suffix] of [['ACCESS_AUTHORIZATION_URL', '/authorization'], ['ACCESS_TOKEN_URL', '/token'], ['ACCESS_JWKS_URL', '/jwks']]) {
    if (env[key] !== base + suffix) throw new Rejected('access_endpoint_config_invalid', 503);
  }
  // Copy the issuer from the SaaS app's verified OIDC metadata. Do not derive it from a JWT or user input.
  try {
    if (typeof env.ACCESS_ISSUER !== 'string' || !safeUrl(env.ACCESS_ISSUER) || new URL(env.ACCESS_ISSUER).hostname !== domain) throw new Error();
  } catch { throw new Rejected('access_issuer_config_invalid', 503); }
  return { clientId, issuer: env.ACCESS_ISSUER, authorizationUrl: env.ACCESS_AUTHORIZATION_URL, tokenUrl: env.ACCESS_TOKEN_URL,
    jwksUrl: env.ACCESS_JWKS_URL, callbackUrl: oauth.bindings.publicOrigin + '/callback', allowedEmail: env.ACCESS_ALLOWED_EMAIL.toLowerCase() };
}

async function boundedResponse(response: Response, max: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Rejected('access_invalid_response', 502);
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const next = await reader.read(); if (next.done) break;
    size += next.value.length;
    if (size > max) { await reader.cancel(); throw new Rejected('access_response_too_large', 502); }
    chunks.push(next.value);
  }
  const data = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(data);
}

/** Exported to test actual jose signature/claims validation using local public keys, with no network. */
export async function verifyAccessIdToken(token: string, config: AccessConfig, nonce: string, keys: JWTVerifyGetKey, now = Date.now()): Promise<VerifiedIdentity> {
  if (typeof token !== 'string' || token.length < 1 || token.length > 24000 || !/^[A-Za-z0-9_-]{43}$/.test(nonce)) throw new Rejected('access_identity_invalid', 403);
  try {
    const { payload } = await jwtVerify(token, keys, {
      algorithms: ['RS256'], issuer: config.issuer, audience: config.clientId,
      requiredClaims: ['iss', 'aud', 'sub', 'exp', 'iat', 'nonce', 'email'],
      currentDate: new Date(now), clockTolerance: 5, maxTokenAge: '10m',
    });
    if (payload.nonce !== nonce || typeof payload.sub !== 'string' || payload.sub.length < 1 || payload.sub.length > 512 ||
        typeof payload.email !== 'string' || payload.email.toLowerCase() !== config.allowedEmail ||
        payload.email_verified !== undefined && payload.email_verified !== true || typeof payload.azp !== 'undefined' && payload.azp !== config.clientId ||
        Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== config.clientId) throw new Error('identity claim mismatch');
    // No upstream access/refresh/ID token is stored in grant props or sent to an MCP client.
    return { subject: payload.sub, email: payload.email.toLowerCase() };
  } catch { throw new Rejected('access_identity_invalid', 403); }
}

export function createAccessIdentity(env: Record<string, any>, oauth: OAuthConfig, transport: FetchPort = fetch): IdentityPort {
  const config = loadAccessConfig(env, oauth), secret = env.ACCESS_CLIENT_SECRET;
  if (typeof secret !== 'string' || secret.length < 16 || secret.length > 2048) throw new Rejected('access_secret_missing', 503);
  const keys = createRemoteJWKSet(new URL(config.jwksUrl), {
    timeoutDuration: 5000, cooldownDuration: 30000, cacheMaxAge: 300000,
    [customFetch]: async (url, init) => {
      if (url !== config.jwksUrl || init?.method !== 'GET') throw new Rejected('access_endpoint_not_allowed', 503);
      const response = await transport(url, { ...init, redirect: 'manual' });
      if (response.status !== 200) throw new Rejected('access_keys_unavailable', 502);
      const body = await boundedResponse(response, 65536);
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  return {
    formActionOrigin: new URL(config.authorizationUrl).origin,
    allowedEmail: config.allowedEmail,
    async authorizationUrl(state: string, proof: UpstreamState) {
      if (typeof state !== 'string' || state.length < 1 || state.length > 200 || !/^[A-Za-z0-9_-]{43}$/.test(proof.verifier) || !/^[A-Za-z0-9_-]{43}$/.test(proof.nonce)) throw new Rejected('invalid_oauth_state', 400);
      const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(proof.verifier)));
      const challenge = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const url = new URL(config.authorizationUrl);
      url.search = new URLSearchParams({ response_type: 'code', client_id: config.clientId, redirect_uri: config.callbackUrl,
        scope: 'openid email', state, nonce: proof.nonce, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
      return url.href;
    },
    async authenticate(code: string, proof: UpstreamState) {
      if (typeof code !== 'string' || !code || code.length > 4096 || !/^[A-Za-z0-9_-]{43}$/.test(proof.verifier) || !/^[A-Za-z0-9_-]{43}$/.test(proof.nonce)) throw new Rejected('invalid_oauth_callback', 400);
      let response: Response;
      try {
        response = await transport(config.tokenUrl, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000),
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: config.clientId, client_secret: secret,
            redirect_uri: config.callbackUrl, code_verifier: proof.verifier }).toString() });
      } catch { throw new Rejected('access_exchange_unavailable', 502); }
      if (response.status !== 200) throw new Rejected('access_exchange_failed', 403);
      let body: any;
      try { body = JSON.parse(await boundedResponse(response, 32768)); } catch { throw new Rejected('access_invalid_response', 502); }
      if (!body || typeof body.id_token !== 'string') throw new Rejected('access_identity_invalid', 403);
      return verifyAccessIdToken(body.id_token, config, proof.nonce, keys);
    },
  };
}
