import {STATUS_KEY, HISTORY_KEY, latestSnapshot, appendHistory, historyHours, publicBuckets} from './status-store.js';

const json = (value, init = {}) => new Response(JSON.stringify(value), {
    ...init,
    headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...(init.headers || {})
    }
});

const allowedOrigin = (request, env) => {
    const origin = request.headers.get('Origin') || '';
    const allowedOrigins = String(env.ALLOWED_ORIGINS || env.ALLOWED_ORIGIN || '')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean);
    return origin && allowedOrigins.includes(origin) ? origin : '';
};

const withCors = (response, request, env) => {
    const origin = allowedOrigin(request, env);
    if (!origin) return response;
    const next = new Response(response.body, response);
    next.headers.set('Access-Control-Allow-Origin', origin);
    next.headers.set('Vary', 'Origin');
    return next;
};

export const parseChecks = value => {
    const checks = JSON.parse(value || '[]');
    if (!Array.isArray(checks)) throw new Error('CHECKS_JSON must contain an array');
    return checks.filter(check => check && check.id && check.name && /^https:\/\//.test(check.url));
};

const checkOne = async check => {
    const started = Date.now();
    let statusCode = 0;
    let error = '';
    try {
        const response = await fetch(check.url, {
            method: check.method === 'HEAD' ? 'HEAD' : 'GET',
            redirect: 'follow',
            signal: AbortSignal.timeout(10000),
            headers: {'User-Agent': 'MistWarp-Status/1.0'}
        });
        statusCode = response.status;
        if (!response.ok) error = `HTTP ${response.status}`;
    } catch (caught) {
        error = caught instanceof Error ? caught.message.slice(0, 200) : 'Request failed';
    }
    const latency = Date.now() - started;
    const status = error ? 'unavailable' : latency > 1500 ? 'degraded' : 'operational';
    return {service: check.id, name: check.name, status, statusCode, latency, checkedAt: Date.now(), error};
};

export const runChecks = async env => {
    const results = await Promise.all(parseChecks(env.CHECKS_JSON).map(checkOne));
    const now = Date.now();
    const [previous, incidents] = await Promise.all([
        env.STATUS_KV.get(HISTORY_KEY, 'json'),
        readIncidents(env)
    ]);
    // Cron is the only writer. Two writes per five-minute run = 576 writes/day.
    await env.STATUS_KV.put(HISTORY_KEY, JSON.stringify(appendHistory(previous, results, now)));
    await env.STATUS_KV.put(STATUS_KEY, JSON.stringify({...latestSnapshot(results, now), incidents}));
    return results;
};

// Keys sort newest first. Each incident has its own key, so concurrent creates
// cannot overwrite each other. Cron copies the latest 20 into the public snapshot.
const INCIDENT_PREFIX = 'incident:v1:';
const readIncidents = async env => {
    const {keys} = await env.STATUS_KV.list({prefix: INCIDENT_PREFIX, limit: 20});
    const incidents = await Promise.all(keys.map(key => env.STATUS_KV.get(key.name, 'json')));
    return incidents.filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
};

const unavailable = () => json({ok: false, error: 'status snapshot unavailable'}, {status: 503});

const statusResponse = async env => {
    const snapshot = await env.STATUS_KV.get(STATUS_KEY, 'json');
    if (!snapshot) return unavailable();
    // A stopped cron must not leave a permanently green status page.
    const services = snapshot.services.map(item => Date.now() - item.checkedAt > 15 * 60000 ?
        {...item, status: 'unknown'} : item);
    const overall = services.some(item => item.status === 'unavailable') ? 'unavailable' :
        services.some(item => item.status === 'degraded') ? 'degraded' :
            !services.length || services.some(item => item.status === 'unknown') ? 'unknown' : 'operational';
    return json({ok: true, overall, services, incidents: snapshot.incidents || [], generatedAt: snapshot.generatedAt}, {
        headers: {'Cache-Control': 'public, max-age=60'}
    });
};

const historyResponse = async (request, env) => {
    const hours = historyHours(request);
    const snapshot = await env.STATUS_KV.get(HISTORY_KEY, 'json');
    if (!snapshot) return unavailable();
    return json({ok: true, hours, buckets: publicBuckets(snapshot, hours, Date.now())}, {
        headers: {'Cache-Control': 'public, max-age=300'}
    });
};

// Cache the public response before adding request-specific CORS headers.
const cachedPublicResponse = async (request, env, context, history) => {
    const url = new URL(request.url);
    url.search = history ? `?hours=${historyHours(request)}` : '';
    const key = new Request(url.toString());
    const cache = globalThis.caches?.default;
    const ttl = history ? 300 : 60;
    const cachedAtHeader = 'X-MistWarp-Cached-At';
    const cached = await cache?.match(key);
    // Zone cache rules can lengthen cache headers. Enforce our own expiry too.
    const cachedAt = Number(cached?.headers.get(cachedAtHeader));
    if (cached && cachedAt > 0 && Date.now() - cachedAt < ttl * 1000) {
        const response = new Response(cached.body, cached);
        response.headers.delete(cachedAtHeader);
        response.headers.set('Cache-Control', `public, max-age=${ttl}`);
        return response;
    }
    const response = await (history ? historyResponse(request, env) : statusResponse(env));
    if (cache && response.ok) {
        const stored = response.clone();
        stored.headers.set(cachedAtHeader, String(Date.now()));
        const pending = cache.put(key, stored);
        if (context) context.waitUntil(pending);
        else await pending;
    }
    return response;
};

const analyticsDisabled = () => json({ok: false, error: 'analytics disabled'}, {status: 410});

const eventResponse = (request, env) => allowedOrigin(request, env) ? analyticsDisabled() :
    json({ok: false, error: 'origin not allowed'}, {status: 403});

const authorized = (request, env) => {
    const expected = env.ADMIN_TOKEN || '';
    const supplied = request.headers.get('Authorization') || '';
    return expected && supplied === `Bearer ${expected}`;
};

const metricsResponse = (request, env) => authorized(request, env) ? analyticsDisabled() :
    json({ok: false, error: 'not authorized'}, {status: 401});

const incidentResponse = async (request, env) => {
    if (!authorized(request, env)) return json({ok: false, error: 'not authorized'}, {status: 401});
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return json({ok: false, error: 'invalid incident'}, {status: 400});
    }
    const statuses = ['investigating', 'identified', 'monitoring', 'resolved'];
    const impacts = ['minor', 'major', 'critical'];
    if (!body.title || !statuses.includes(body.status) || !impacts.includes(body.impact)) {
        return json({ok: false, error: 'invalid incident'}, {status: 400});
    }
    const now = Date.now();
    const id = `${String(9999999999999 - now).padStart(13, '0')}-${crypto.randomUUID()}`;
    const incident = {
        id, title: String(body.title).slice(0, 120), body: String(body.body || '').slice(0, 2000),
        status: body.status, impact: body.impact, createdAt: now, updatedAt: now,
        resolvedAt: body.status === 'resolved' ? now : null
    };
    await env.STATUS_KV.put(`${INCIDENT_PREFIX}${id}`, JSON.stringify(incident));
    return json({ok: true, id}, {status: 201});
};

const updateIncidentResponse = async (request, env, id) => {
    if (!authorized(request, env)) return json({ok: false, error: 'not authorized'}, {status: 401});
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return json({ok: false, error: 'invalid incident'}, {status: 400});
    }
    const statuses = ['investigating', 'identified', 'monitoring', 'resolved'];
    if (body.status !== undefined && !statuses.includes(body.status)) return json({ok: false, error: 'invalid incident status'}, {status: 400});
    const now = Date.now();
    const key = `${INCIDENT_PREFIX}${id}`;
    const incident = await env.STATUS_KV.get(key, 'json');
    if (!incident) return json({ok: false, error: 'incident not found'}, {status: 404});
    await env.STATUS_KV.put(key, JSON.stringify({
        ...incident,
        status: body.status ?? incident.status,
        body: body.body === undefined ? incident.body : String(body.body ?? '').slice(0, 2000),
        title: body.title === undefined ? incident.title : String(body.title).slice(0, 120),
        updatedAt: now,
        resolvedAt: (body.status ?? incident.status) === 'resolved' ? (incident.resolvedAt ?? now) : null
    }));
    return json({ok: true});
};

const handle = async (request, env, context) => {
    if (request.method === 'OPTIONS') {
        if (!allowedOrigin(request, env)) return new Response(null, {status: 403});
        return new Response(null, {status: 204, headers: {
            'Access-Control-Allow-Origin': allowedOrigin(request, env),
            'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Access-Control-Max-Age': '86400'
        }});
    }
    const {pathname} = new URL(request.url);
    if (request.method === 'GET' && pathname === '/v1/status') return cachedPublicResponse(request, env, context, false);
    if (request.method === 'GET' && pathname === '/v1/history') return cachedPublicResponse(request, env, context, true);
    if (request.method === 'POST' && pathname === '/v1/events') return eventResponse(request, env);
    if (request.method === 'GET' && pathname === '/v1/metrics') return metricsResponse(request, env);
    if (request.method === 'POST' && pathname === '/v1/incidents') return incidentResponse(request, env);
    const incidentMatch = pathname.match(/^\/v1\/incidents\/([a-f0-9-]{1,64})$/);
    if (request.method === 'PATCH' && incidentMatch) return updateIncidentResponse(request, env, incidentMatch[1]);
    return json({ok: false, error: 'not found'}, {status: 404});
};

export default {
    fetch: (request, env, context) => Promise.resolve(handle(request, env, context)).then(response => withCors(response, request, env)),
    scheduled: (_controller, env, context) => context.waitUntil(runChecks(env))
};
