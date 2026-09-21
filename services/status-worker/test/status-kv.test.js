import test from 'node:test';
import assert from 'node:assert/strict';
import worker, {runChecks} from '../src/index.js';
import {HOUR, RETENTION, STATUS_KEY, HISTORY_KEY, appendHistory} from '../src/status-store.js';

const fixture = () => {
    const data = new Map();
    const reads = [];
    const writes = [];
    const env = {
        ALLOWED_ORIGINS: 'https://mistwarp.org,https://warp.mistium.com',
        STATUS_KV: {
            list: async ({prefix, limit}) => ({keys: [...data.keys()].filter(key => key.startsWith(prefix)).sort().slice(0, limit).map(name => ({name}))}),
            get: async key => { reads.push(key); return JSON.parse(data.get(key) || 'null'); },
            put: async (key, value) => { writes.push(key); data.set(key, value); }
        },
        STATUS_DB: {prepare: () => { throw new Error('public status must not query D1'); }}
    };
    return {env, data, reads, writes};
};
const request = (path, origin = 'https://mistwarp.org') => new Request(`https://status.example${path}`, {
    headers: {Origin: origin}
});

test('scheduled checks and public reads work with D1 unavailable and only two KV writes', async t => {
    t.mock.method(globalThis, 'fetch', async () => new Response(null, {status: 200}));
    const {env, data, writes} = fixture();
    env.CHECKS_JSON = JSON.stringify([{id: 'api', name: 'API', url: 'https://example.com'}]);
    await runChecks(env);
    assert.deepEqual(writes, [HISTORY_KEY, STATUS_KEY]);
    const status = await worker.fetch(request('/v1/status'), env);
    assert.equal(status.status, 200);
    const result = await status.json();
    assert.equal(result.overall, 'operational');
    assert.equal(result.services[0].statusCode, 200);
    assert.equal(typeof result.services[0].latencyMs, 'number');
    const history = await (await worker.fetch(request('/v1/history?hours=168'), env)).json();
    assert.equal(history.buckets[0].samples, 1);
    assert.equal(history.buckets[0].uptime, 100);
    const saved = JSON.parse(data.get(STATUS_KEY));
    saved.services[0].checkedAt -= HOUR;
    data.set(STATUS_KEY, JSON.stringify(saved));
    const stale = await (await worker.fetch(request('/v1/status'), env)).json();
    assert.equal(stale.overall, 'unknown');
    assert.equal(stale.generatedAt, saved.generatedAt);
});

test('missing KV snapshots fail closed without querying D1 or caching success', async () => {
    const {env} = fixture();
    for (const path of ['/v1/status', '/v1/history']) {
        const response = await worker.fetch(request(path), env);
        assert.equal(response.status, 503);
        assert.equal(response.headers.get('Cache-Control'), 'no-store');
    }
});

test('hourly history keeps weighted totals, handles boundaries, and prunes old buckets', async () => {
    const now = Math.floor(Date.now() / HOUR) * HOUR + HOUR / 2;
    const result = {service: 'api', name: 'API', status: 'operational', latency: 101, checkedAt: now};
    const old = appendHistory(null, [{...result, checkedAt: now - RETENTION - HOUR}], now - RETENTION - HOUR);
    const first = appendHistory(old, [result, {...result, latency: 200, status: 'degraded'}], now);
    const next = appendHistory(first, [{...result, latency: 302}, {...result, checkedAt: now - HOUR}], now);
    assert.equal(next.buckets.length, 2);
    assert.equal(next.buckets[1].samples, 3);
    assert.equal(next.buckets[1].operational, 2);
    assert.equal(next.buckets[1].latencyTotal, 603);
    assert.equal(first.buckets[0].samples, 2, 'previous snapshot is not mutated');
    const {env, data} = fixture();
    data.set(HISTORY_KEY, JSON.stringify(next));
    const history = await (await worker.fetch(request('/v1/history?hours=1'), env)).json();
    assert.equal(history.buckets.length, 2, 'include the partial boundary hour');
    assert.equal(history.buckets[1].uptime, 66.67);
    assert.equal(history.buckets[1].latencyMs, 201);
});

test('edge cache reuses canonical URLs and adds CORS separately for each origin', async t => {
    const {env, data, reads} = fixture();
    data.set(STATUS_KEY, JSON.stringify({services: [], generatedAt: Date.now()}));
    data.set(HISTORY_KEY, JSON.stringify({buckets: []}));
    const cache = new Map();
    const original = Object.getOwnPropertyDescriptor(globalThis, 'caches');
    Object.defineProperty(globalThis, 'caches', {configurable: true, value: {default: {
        match: async key => cache.get(key.url)?.clone(),
        put: async (key, response) => {
            assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
            // Reproduce the live zone's browser cache TTL override.
            response.headers.set('Cache-Control', 'public, max-age=14400');
            cache.set(key.url, response);
        }
    }}});
    t.after(() => {
        if (original) Object.defineProperty(globalThis, 'caches', original);
        else delete globalThis.caches;
    });
    const pending = [];
    const context = {waitUntil: promise => pending.push(promise)};
    await worker.fetch(request('/v1/status?bust=1'), env, context);
    await Promise.all(pending);
    const second = await worker.fetch(request('/v1/status?bust=2', 'https://warp.mistium.com'), env, context);
    assert.equal(second.headers.get('Access-Control-Allow-Origin'), 'https://warp.mistium.com');
    assert.equal(second.headers.get('Cache-Control'), 'public, max-age=60');
    assert.equal(second.headers.get('X-MistWarp-Cached-At'), null);
    assert.equal(reads.length, 1);
    const denied = await worker.fetch(request('/v1/status', 'https://untrusted.example'), env, context);
    assert.equal(denied.headers.get('Access-Control-Allow-Origin'), null);
    for (const query of ['hours=168.9', 'hours=168&bust=2', 'hours=NaN', '']) {
        await worker.fetch(request(`/v1/history?${query}`), env, context);
        await Promise.all(pending);
    }
    assert.equal(reads.filter(key => key === HISTORY_KEY).length, 1);
    cache.get('https://status.example/v1/status').headers.set('X-MistWarp-Cached-At', String(Date.now() - 61000));
    await worker.fetch(request('/v1/status'), env, context);
    assert.equal(reads.filter(key => key === STATUS_KEY).length, 2, 'refresh despite the longer zone cache TTL');
});

test('concurrent incident creates keep separate records and cron publishes the newest 20', async t => {
    t.mock.method(globalThis, 'fetch', async () => new Response(null, {status: 200}));
    const {env} = fixture();
    env.ADMIN_TOKEN = 'test';
    const edit = (path, method, body, token = 'test') => worker.fetch(new Request(`https://status.example${path}`, {
        method, headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'}, body: JSON.stringify(body)
    }), env);
    const responses = await Promise.all(Array.from({length: 22}, (_, index) =>
        edit('/v1/incidents', 'POST', {title: `Outage ${index}`, status: 'investigating', impact: 'major'})));
    const ids = await Promise.all(responses.map(async response => {
        assert.equal(response.status, 201);
        return (await response.json()).id;
    }));
    assert.equal(new Set(ids).size, 22);
    const key = `incident:v1:${ids[0]}`;
    assert.equal((await env.STATUS_KV.get(key)).title, 'Outage 0');
    assert.equal((await edit(`/v1/incidents/${ids[0]}`, 'PATCH', {status: 'resolved', body: 'Fixed'})).status, 200);
    const resolved = await env.STATUS_KV.get(key);
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.body, 'Fixed');
    assert.ok(resolved.resolvedAt);
    assert.equal((await edit('/v1/incidents/999', 'PATCH', {status: 'resolved'})).status, 404);
    assert.equal((await edit(`/v1/incidents/${ids[0]}`, 'PATCH', {status: 'resolved'}, 'wrong')).status, 401);
    assert.equal((await edit(`/v1/incidents/${ids[0]}`, 'PATCH', {status: 'nonsense'})).status, 400);
    await runChecks(env);
    const status = await (await worker.fetch(request('/v1/status'), env)).json();
    assert.equal(status.incidents.length, 20);
    const expected = ids.sort().slice(0, 20);
    assert.deepEqual(status.incidents.map(incident => incident.id).sort(), expected);
});
