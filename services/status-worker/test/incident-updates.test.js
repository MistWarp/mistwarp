import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const request = (body, method = 'PATCH', suffix = '/a') => new Request(`https://example.com/v1/incidents${suffix}`, {
    method, headers: {Authorization: 'Bearer test', 'Content-Type': 'application/json'}, body: JSON.stringify(body)
});

test('null incident bodies return 400 instead of throwing', async () => {
    for (const [method, suffix] of [['POST', ''], ['PATCH', '/a']]) {
        const response = await worker.fetch(request(null, method, suffix), {ADMIN_TOKEN: 'test'});
        assert.equal(response.status, 400);
    }
});

test('partial incident updates preserve description and resolution history', async () => {
    let incident = {id:'a',title:'Original',body:'Keep this',status:'resolved',resolvedAt:123};
    const env = {ADMIN_TOKEN:'test',STATUS_KV:{get:async()=>incident,put:async(key,value)=>{incident=JSON.parse(value);}}};
    const response = await worker.fetch(request({title:'Updated'}), env);
    assert.equal(response.status,200);
    assert.equal(incident.title,'Updated');
    assert.equal(incident.body,'Keep this');
    assert.equal(incident.resolvedAt,123);
    await worker.fetch(request({status:'investigating',body:''}),env);
    assert.equal(incident.resolvedAt,null);
    assert.equal(incident.body,'');
});
