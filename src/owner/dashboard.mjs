import { readDashboardWatchlist } from './dashboard-read-model.mjs';
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
  return { source: selected, watchlist };
}
export function isDashboardRoute(url) {
  return url.pathname === '/dashboard' || url.pathname.startsWith('/dashboard/') ||
    url.pathname === '/callback' && (url.searchParams.get('state') || '').startsWith('rd_');
}
function page() {
  const nonce = random();
  const body = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rivule · 只读任务面板</title>
<style nonce="${nonce}">body{max-width:860px;margin:40px auto;padding:0 20px;font:16px/1.6 system-ui;background:#f7f5ef;color:#243c3d}button{padding:10px 16px;margin:6px 8px 6px 0}article{background:white;border:1px solid #dce0d5;border-radius:8px;padding:16px;margin:14px 0;overflow-wrap:anywhere}small{color:#637471}[hidden]{display:none!important}</style>
<h1>只读任务面板</h1><p>仅限本人查看明确选定的 Zot 任务。这里不发送指令，也不批准任务操作。</p><p id="status" role="status">正在读取连接状态…</p>
<form id="login" method="post" action="/dashboard/login" hidden><button>用 Discord 验证本人</button></form>
<div id="controls" hidden><button id="refresh" type="button">重新读取快照</button><form method="post" action="/dashboard/logout"><button>退出登录</button></form></div><div id="items"></div>
<script nonce="${nonce}">
const status=document.getElementById('status'),items=document.getElementById('items'),login=document.getElementById('login'),controls=document.getElementById('controls'),refresh=document.getElementById('refresh');
const labels={available:'已读取',not_found:'未找到所选任务',withheld:'敏感内容未展示',unavailable:'读取失败'};
async function load(){refresh.disabled=true;items.replaceChildren();status.textContent='正在读取所选任务快照…';try{const response=await fetch('/dashboard/data',{credentials:'same-origin',cache:'no-store',redirect:'error'});if(response.status===401){login.hidden=false;controls.hidden=true;status.textContent='尚未登录或会话已过期。请验证本人身份。';return;}if(!response.ok)throw Error();const data=await response.json();login.hidden=true;controls.hidden=false;status.textContent=data.state==='error'?'部分或全部任务读取失败；不能视为没有任务。':data.items.length?'已读取所选任务快照，不是实时订阅。':'尚未配置要展示的任务，没有加载演示数据。';for(const item of data.items){const card=document.createElement('article'),title=document.createElement('h2'),summary=document.createElement('p'),detail=document.createElement('small');title.textContent=item.task_name||labels[item.state]||'任务状态未知';summary.textContent=item.summary||labels[item.state]||'';detail.textContent=[item.project_name,item.source_status,item.stale?'状态可能已过期':'',item.archived?'已归档':'',item.last_confirmed_at?'来源最后确认：'+item.last_confirmed_at:'',item.observed_at?'读取时间：'+item.observed_at:'',Number.isInteger(item.pending_action_count)?'待决定：'+item.pending_action_count:''].filter(Boolean).join(' · ');card.append(title,summary,detail);items.append(card);}}catch{status.textContent='读取失败，无法确认当前任务状态。请稍后重试。';}finally{refresh.disabled=false;}}
refresh.addEventListener('click',load);window.addEventListener('pageshow',load);
</script></html>`;
  const h = headers('text/html; charset=utf-8');
  h.set('content-security-policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://discord.com/oauth2/authorize`);
  return new Response(body, { headers: h });
}
/** Called only by the owner Durable Object's internal dashboard route. */
export async function dashboardResponse(request, { env, bindings, storage, identity, readSnapshot, now = Date.now }) {
  const url = new URL(request.url);
  if (url.origin !== 'https://owner.internal' || !isDashboardRoute(url)) return json('internal_route_required', 403);
  let config;
  try { config = configuration(env, bindings); } catch { return json('dashboard_configuration_unavailable', 503); }
  if (!config) return json('not_found', 404);
  if (url.hash || url.pathname !== '/callback' && url.search) return json('invalid_dashboard_request', 400);
  const sameOrigin = request.headers.get('origin') === bindings.publicOrigin;
  if (request.method === 'POST' && !sameOrigin) return json('origin_not_accepted', 403);
  const binding = await digest(JSON.stringify([bindings.ownerId, bindings.appId, bindings.userId, bindings.publicOrigin, config.source, config.watchlist]));
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
      await tx.put(sessionKey, { binding, expires: now() + SESSION_TTL });
    });
    h.set('location', '/dashboard');h.append('set-cookie', cookie(SESSION_COOKIE, token, SESSION_TTL / 1000, 'Strict'));
    return new Response(null, { status: 303, headers: h });
  }
  if (!['/dashboard/data', '/dashboard/logout'].includes(url.pathname)) return json('not_found', 404);
  if (url.pathname === '/dashboard/data' && request.method !== 'GET' || url.pathname === '/dashboard/logout' && request.method !== 'POST') return json('method_not_allowed', 405);
  if (url.pathname === '/dashboard/data' && (request.headers.get('sec-fetch-site') !== 'same-origin' || request.headers.has('origin') && !sameOrigin)) return json('origin_not_accepted', 403);
  const token = readCookie(request, SESSION_COOKIE), sessionKey = token ? 'dashboard:session:' + await digest(token) : null;
  const session = sessionKey && await storage.get(sessionKey);
  if (!session || session.expires <= now() || session.binding !== binding) return json('dashboard_login_required', 401);
  if (url.pathname === '/dashboard/logout') {
    await storage.delete(sessionKey);const h = headers();h.set('location', '/dashboard');h.append('set-cookie', cookie(SESSION_COOKIE, '', 0, 'Strict'));
    return new Response(null, { status: 303, headers: h });
  }
  const model = await readDashboardWatchlist({ sourceId: 'zot-main', watchlist: config.watchlist, readSnapshot: query => readSnapshot(config.source, query) });
  return new Response(JSON.stringify(model), { headers: headers() });
}
