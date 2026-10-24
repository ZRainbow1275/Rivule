import { dashboardBridge, isBridgeSettingsPath } from './bridge-controller.mjs';
import { TASK_PICKER_VERSION, isTaskPickerPath, dashboardTaskPicker, dashboardDynamicSelections } from './dashboard-task-picker.mjs';
import { sourceBrand } from './brand-identity.mjs';
import { dashboardQQSettings, isQQSettingsPath } from './dashboard-settings.mjs';
import { ownerDashboardHtml } from './presentation.mjs';
import { dashboardText } from './dashboard-activity.mjs';
import { readDashboardWatchlist } from './dashboard-read-model.mjs';
import { validateDashboardTestReceipt } from './dashboard-receipt.mjs';
const LOGIN_TTL = 5 * 60_000, SESSION_TTL = 15 * 60_000;
const LOGIN_COOKIE = '__Host-rivule-dashboard-login', SESSION_COOKIE = '__Host-rivule-dashboard-session';
const fields = ['project_id', 'task_id', 'run_id', 'branch_id'];
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(value);
const random = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), x => x.toString(16).padStart(2, '0')).join('');
const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), x => x.toString(16).padStart(2, '0')).join('');
const cookie = (name, value, ttl, sameSite) => `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=${sameSite}; Max-Age=${ttl}`;
function readCookie(request, name) {
  const matches = (request.headers.get('cookie') || '').split(';').map(v => v.trim()).filter(v => v.startsWith(name + '='));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(name.length + 1);
  return /^[a-f0-9]{64}$/.test(value) ? value : null;
}
function headers(type = 'application/json; charset=utf-8') {
  return new Headers({ 'content-type': type, 'cache-control': 'no-store', 'pragma': 'no-cache',
    'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
}
const json = (error, status) => new Response(JSON.stringify({ error }), { status, headers: headers() });
function configuration(env, bindings) {
  if (env.DASHBOARD_ENABLED !== 'true') return null;
  const selected = bindings.sources.find(source => source.source_id === 'zot-main' && source.enabled);
  if (!selected) throw Error('dashboard_configuration_unavailable');
  const watchlist = JSON.parse(env.DASHBOARD_WATCHLIST_JSON || '[]');
  if (!Array.isArray(watchlist) || watchlist.length > 20 || watchlist.some(q => !q || Array.isArray(q) ||
      Object.keys(q).length !== 4 || fields.some(key => !Object.hasOwn(q, key) || !validId(q[key])) ||
      !bindings.allowedProjectIds.includes(q.project_id))) throw Error('dashboard_configuration_unavailable');
  if (new Set(watchlist.map(q => JSON.stringify(fields.map(key => q[key])))).size !== watchlist.length)
    throw Error('dashboard_configuration_unavailable');
  const testReceipt = validateDashboardTestReceipt(JSON.parse(env.DASHBOARD_TEST_RECEIPT_JSON || 'null'));
  if (testReceipt && watchlist.length >= 20) throw Error('dashboard_configuration_unavailable');
  const additional = JSON.parse(env.DASHBOARD_SOURCE_WATCHLISTS_JSON || '{}');
  if (!additional || Array.isArray(additional) || typeof additional !== 'object') throw Error('dashboard_configuration_unavailable');
  const sources = bindings.sources.filter(s=>s.enabled && s.source_id !== 'zot-main');
  let count = watchlist.length + (testReceipt ? 1 : 0);
  for (const [sourceId,list] of Object.entries(additional)) {
    if (!sources.some(s=>s.source_id===sourceId) || !Array.isArray(list) || list.some(q=>!q || Array.isArray(q) || Object.keys(q).length!==4 || fields.some(k=>!validId(q[k])) || !bindings.allowedProjectIds.includes(q.project_id)) || new Set(list.map(q=>JSON.stringify(fields.map(k=>q[k])))).size!==list.length) throw Error('dashboard_configuration_unavailable');
    count += list.length;
  }
  if(count>20) throw Error('dashboard_configuration_unavailable');
  return { source: selected, watchlist, testReceipt, sources, additional };
}
export function isDashboardRoute(url) {
  return url.pathname === '/dashboard' || url.pathname.startsWith('/dashboard/') ||
    url.pathname === '/callback' && (url.searchParams.get('state') || '').startsWith('rd_');
}
function page() {
  const nonce = random();
  const body = ownerDashboardHtml(nonce);
  const h = headers('text/html; charset=utf-8');
  // Native same-origin form POSTs need a non-null Origin; no-referrer suppresses it.
  // External navigations still receive no Referer under same-origin policy.
  h.set('referrer-policy', 'same-origin');
  h.set('content-security-policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://discord.com/oauth2/authorize`);
  return new Response(body, { headers: h });
}
/** Called only by the owner Durable Object's internal dashboard route. */
export async function dashboardResponse(request, { env, bindings, storage, identity, readSnapshot, readActivity, readTestReceipt, readConnection, manageQQ, manageBridge, readCatalog, readSelection, now = Date.now }) {
  const url = new URL(request.url);
  if (url.origin !== 'https://owner.internal' || !isDashboardRoute(url)) return json('internal_route_required', 403);
  let config;
  try { config = configuration(env, bindings); } catch { return json('dashboard_configuration_unavailable', 503); }
  if (!config) return json('not_found', 404);
  if (url.hash || url.pathname !== '/callback' && url.search) return json('invalid_dashboard_request', 400);
  const sameOrigin = request.headers.get('origin') === bindings.publicOrigin;
  if (request.method === 'POST' && !sameOrigin) return json('origin_not_accepted', 403);
  const binding = await digest(JSON.stringify([TASK_PICKER_VERSION, bindings.ownerId, bindings.appId, bindings.userId, bindings.dmId, bindings.publicOrigin, bindings.allowedProjectIds, config.source, config.watchlist, config.testReceipt, config.sources, config.additional]));
  if (url.pathname === '/dashboard' && request.method === 'GET') return page();
  if (url.pathname === '/dashboard/login' && request.method === 'POST') {
    const state = 'rd_' + random(), browser = random(), key = 'dashboard:login:' + await digest(state);
    const allowed = await storage.transaction(async tx => {
      const timestamp = now(), minute = Math.floor(timestamp / 60_000);
      const rate = await tx.get('dashboard:login-rate');
      if (rate?.minute === minute && rate.count >= 6) return false;
      const active = await tx.list({ prefix: 'dashboard:login:', limit: 65 });
      let count = 0;
      for (const [key, value] of active) { if (value.expires <= timestamp) await tx.delete(key); else count++; }
      if (count >= 32) return false;
      await tx.put('dashboard:login-rate', { minute, count: rate?.minute === minute ? rate.count + 1 : 1 });
      await tx.put(key, { browser: await digest(browser), binding, expires: timestamp + LOGIN_TTL });
      return true;
    });
    if (!allowed) return json('dashboard_login_rate_limited', 429);
    let destination;
    try { destination = await identity.authorizationUrl(state); } catch { return json('dashboard_login_unavailable', 503); }
    const target = new URL(destination);
    if (target.origin !== 'https://discord.com' || target.pathname !== '/oauth2/authorize' || target.searchParams.get('state') !== state ||
        target.searchParams.get('scope') !== 'identify' || target.searchParams.get('client_id') !== bindings.appId ||
        target.searchParams.get('redirect_uri') !== bindings.publicOrigin + '/callback') return json('dashboard_login_unavailable', 503);
    const h = headers();h.set('location', target.href);h.append('set-cookie', cookie(LOGIN_COOKIE, browser, LOGIN_TTL / 1000, 'Lax'));
    return new Response(null, { status: 303, headers: h });
  }
  if (url.pathname === '/callback' && request.method === 'GET') {
    const states = url.searchParams.getAll('state'), codes = url.searchParams.getAll('code');
    const browser = readCookie(request, LOGIN_COOKIE);
    if (states.length !== 1 || !/^rd_[a-f0-9]{64}$/.test(states[0]) || !browser) return json('invalid_dashboard_login', 403);
    const key = 'dashboard:login:' + await digest(states[0]), browserHash = await digest(browser);
    const consumed = await storage.transaction(async tx => {
      const record = await tx.get(key);
      if (!record || record.expires <= now() || record.binding !== binding || record.browser !== browserHash) return false;
      await tx.delete(key);return true;
    });
    if (!consumed) return json('invalid_dashboard_login', 403);
    const h = headers();h.append('set-cookie', cookie(LOGIN_COOKIE, '', 0, 'Lax'));
    if (url.searchParams.has('error') || codes.length !== 1 || !codes[0] || codes[0].length > 4096)
      return new Response('Login was not completed.', { status: 403, headers: h });
    let verified;
    try { verified = await identity.authenticate(codes[0]); } catch { return new Response('Owner verification failed.', { status: 403, headers: h }); }
    if (verified?.subject !== bindings.userId) return new Response('Owner verification failed.', { status: 403, headers: h });
    const token = random(), sessionKey = 'dashboard:session:' + await digest(token);
    await storage.transaction(async tx => {
      const sessions = await tx.list({ prefix: 'dashboard:session:', limit: 100 });
      // At most 16 recent owner sessions; old sessions are revoked, never reused.
      const active = [...sessions].filter(([, value]) => value.expires > now()).sort((a, b) => a[1].expires - b[1].expires);
      for (const [key, value] of sessions) if (value.expires <= now()) await tx.delete(key);
      for (const [key] of active.slice(0, Math.max(0, active.length - 15))) await tx.delete(key);
      await tx.put(sessionKey, { binding, csrf: random(), expires: now() + SESSION_TTL });
    });
    h.set('location', '/dashboard');h.append('set-cookie', cookie(SESSION_COOKIE, token, SESSION_TTL / 1000, 'Strict'));
    return new Response(null, { status: 303, headers: h });
  }
  if (!['/dashboard/data', '/dashboard/logout'].includes(url.pathname) && !isQQSettingsPath(url.pathname) && !isTaskPickerPath(url.pathname) && !isBridgeSettingsPath(url.pathname)) return json('not_found', 404);
  if (url.pathname === '/dashboard/data' && request.method !== 'GET' || url.pathname === '/dashboard/logout' && request.method !== 'POST') return json('method_not_allowed', 405);
  if ((url.pathname === '/dashboard/data' || isQQSettingsPath(url.pathname) || isTaskPickerPath(url.pathname) || isBridgeSettingsPath(url.pathname)) && (request.headers.get('sec-fetch-site') !== 'same-origin' || request.headers.has('origin') && !sameOrigin)) return json('origin_not_accepted', 403);
  const token = readCookie(request, SESSION_COOKIE), sessionKey = token ? 'dashboard:session:' + await digest(token) : null;
  const session = sessionKey && await storage.get(sessionKey);
  if (!session || session.expires <= now() || session.binding !== binding) return json('dashboard_login_required', 401);
  if (isBridgeSettingsPath(url.pathname)) return dashboardBridge(request, {session,sessionKey,storage,config,now,manageBridge,headers});
  if (isTaskPickerPath(url.pathname)) return dashboardTaskPicker(request, {storage,sessionKey,binding,config,now,headers,readCatalog,readSelection,readTestReceipt});
  if (isQQSettingsPath(url.pathname)) return dashboardQQSettings(request, {env,storage,session,sessionKey,binding,now,manageQQ,headers});
  if (url.pathname === '/dashboard/logout') {
    await storage.transaction(async tx => { await tx.delete(sessionKey); });const h = headers();h.set('location', '/dashboard');h.append('set-cookie', cookie(SESSION_COOKIE, '', 0, 'Strict'));
    return new Response(null, { status: 303, headers: h });
  }
  let dynamic;
  try { dynamic = await dashboardDynamicSelections({session,config,readSelection,now}); } catch { return json('task_selection_unavailable',409); }
  let selectedTest = null;
  const watchlist = [...config.watchlist, ...(dynamic[config.source.source_id] || [])];
  if (config.testReceipt) {
    try { selectedTest = await readTestReceipt(config.source, config.testReceipt); } catch { return json('dashboard_receipt_unavailable', 503); }
    if (!selectedTest || fields.some(k => !validId(selectedTest[k])) || !bindings.allowedProjectIds.includes(selectedTest.project_id)) return json('dashboard_receipt_unavailable', 503);
    if (!watchlist.some(q => fields.every(k => q[k] === selectedTest[k]))) watchlist.push(selectedTest);
  }
  const model = await readDashboardWatchlist({ sourceId: 'zot-main', watchlist, readSnapshot: query => readSnapshot(config.source, query), readActivity: readActivity ? query => readActivity(config.source, query) : undefined });
  if (selectedTest) for (const item of model.items) if (fields.every(k => item[k] === selectedTest[k])) item.selection_kind = 'verified_test';
  if (readConnection) {
    try { model.connection = await readConnection(config.source); }
    catch { model.connection = { source: { status: 'unknown', evidence_kind: null, last_verified_at: null, proof_max_age_ms: 86400000 }, qq: { status: 'unknown', reason: 'state_unavailable', scope: 'owner_producer_only' }, observed_at: new Date(now()).toISOString() }; }
  }
  model.session_expires_at = new Date(session.expires).toISOString();
  model.sources = [];
  for (const source of config.sources) {
    const projection = await readDashboardWatchlist({sourceId:source.source_id, authorizedSourceIds:[source.source_id], watchlist:[...(config.additional[source.source_id] || []), ...(dynamic[source.source_id] || [])], readSnapshot:query=>readSnapshot(source,query),readActivity:readActivity ? query=>readActivity(source,query) : undefined});
    const brand=sourceBrand(source);
    projection.display_name = dashboardText(brand.name,120);
    projection.provider = ['dot','qq','muse'].includes(source.provider) ? source.provider : null;
    projection.connection = {source:{status:'unknown'},observed_at:new Date(now()).toISOString()};
    if(readConnection) try { projection.connection = await readConnection(source); } catch {}
    model.sources.push(projection);
  }
  return new Response(JSON.stringify(model), { headers: headers() });
}
