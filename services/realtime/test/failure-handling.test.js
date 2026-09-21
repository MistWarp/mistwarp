import test from 'node:test';
import assert from 'node:assert/strict';
import {GameRoom} from '../src/index.js';
import {validateGameEvent} from '../src/protocol.js';

test('a broken socket cannot stop broadcasts to healthy peers', () => {
    const room = new GameRoom({});
    const sent = [];
    room.players.set('broken', {id: 'broken', socket: {readyState: 1, send() {throw new Error('closed');}}});
    room.players.set('healthy', {id: 'healthy', socket: {readyState: 1, send(value) {sent.push(JSON.parse(value));}}});
    room.broadcast({type: 'test'});
    assert.ok(sent.some(packet => packet.type === 'test'));
    assert.equal(room.players.has('broken'), false);
});

test('a legacy authenticate frame is accepted after the HTTP identity check', () => {
    const sent = [];
    const player = {id: 'p', messageTimes: [], socket: {readyState: 1, send(value) {sent.push(value);}}};
    const room = new GameRoom({});
    room.players.set(player.id, player);
    room.onMessage(player, JSON.stringify({type: 'authenticate', ticket: 'already verified'}));
    assert.equal(sent.length, 0);
});

test('invalid private event recipients cannot become broadcasts', () => {
    for (const to of [null, 42, {}, []]) {
        assert.throws(() => validateGameEvent({name: 'private', value: 'secret', to}), /player ID/);
    }
});

test('WebSocket Upgrade matching is case insensitive', async () => {
    const room = new GameRoom({});
    for (let i = 0; i < 50; i++) room.players.set(i, {});
    const response = await room.fetch(new Request('https://example.com', {headers: {Upgrade: 'WebSocket'}}));
    assert.equal(response.status, 503); // Valid upgrade reaches the room-capacity check.
});
