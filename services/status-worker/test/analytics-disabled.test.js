import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

test('retired analytics endpoints report disabled without accessing storage', async () => {
    const env = {ALLOWED_ORIGIN: 'https://mistwarp.org', ADMIN_TOKEN: 'test'};
    const event = await worker.fetch(new Request('https://status.example/v1/events', {
        method: 'POST', headers: {Origin: 'https://mistwarp.org'}, body: '{}'
    }), env);
    assert.equal(event.status, 410);
    assert.deepEqual(await event.json(), {ok: false, error: 'analytics disabled'});
    const metrics = await worker.fetch(new Request('https://status.example/v1/metrics', {
        headers: {Authorization: 'Bearer test'}
    }), env);
    assert.equal(metrics.status, 410);
    const denied = await worker.fetch(new Request('https://status.example/v1/metrics'), env);
    assert.equal(denied.status, 401);
});
