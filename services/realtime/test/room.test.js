import test from 'node:test';
import assert from 'node:assert/strict';
import {GameRoom} from '../src/index.js';

class FakeSocket {
    constructor () {
        this.readyState = 1;
        this.sent = [];
        this.listeners = new Map();
    }

    accept () {}

    addEventListener (type, listener) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(listener);
    }

    emit (type, value = {}) {
        for (const listener of this.listeners.get(type) || []) listener(value);
    }

    send (value) {
        this.sent.push(JSON.parse(value));
    }

    close () {
        this.readyState = 3;
        this.emit('close');
    }
}

class FakeResponse {
    constructor (body, options = {}) {
        this.body = body;
        Object.assign(this, options);
    }
}

const connect = async (room, pairs, userId, username) => {
    const response = await room.fetch({
        headers: new Headers({
            Upgrade: 'websocket',
            'X-MistWarp-Identity': JSON.stringify({userId, username})
        })
    });
    assert.equal(response.status, 101);
    return pairs.at(-1)[1];
};

test('two players join, move, send events, and leave a room', async t => {
    const OriginalResponse = globalThis.Response;
    const OriginalWebSocketPair = globalThis.WebSocketPair;
    const pairs = [];
    globalThis.Response = FakeResponse;
    globalThis.WebSocketPair = class {
        constructor () {
            const pair = [new FakeSocket(), new FakeSocket()];
            pairs.push(pair);
            return pair;
        }
    };
    t.after(() => {
        globalThis.Response = OriginalResponse;
        globalThis.WebSocketPair = OriginalWebSocketPair;
    });

    const room = new GameRoom({});
    const alice = await connect(room, pairs, 'alice-id', 'Alice');
    const alicePlayerId = alice.sent[0].self;
    assert.deepEqual(alice.sent[0], {
        type: 'welcome',
        self: alicePlayerId,
        players: [{id: alicePlayerId, userId: 'alice-id', username: 'Alice', state: {}}]
    });

    const bob = await connect(room, pairs, 'bob-id', 'Bob');
    const bobPlayerId = bob.sent[0].self;
    assert.notEqual(alicePlayerId, bobPlayerId);
    assert.deepEqual(bob.sent[0].players.map(player => player.id), [alicePlayerId, bobPlayerId]);
    assert.deepEqual(alice.sent.at(-1), {
        type: 'player_joined',
        player: {id: bobPlayerId, userId: 'bob-id', username: 'Bob', state: {}}
    });

    alice.emit('message', {data: JSON.stringify({type: 'state', value: {x: 45, y: -20}})});
    assert.deepEqual(bob.sent.at(-1), {
        type: 'player_state',
        player: {id: alicePlayerId, userId: 'alice-id', username: 'Alice', state: {x: 45, y: -20}}
    });

    bob.emit('message', {
        data: JSON.stringify({type: 'game_event', name: 'wave', value: 'hello', to: alicePlayerId})
    });
    assert.deepEqual(alice.sent.at(-1), {
        type: 'game_event',
        name: 'wave',
        value: 'hello',
        sender: {id: bobPlayerId, userId: 'bob-id', username: 'Bob'}
    });

    alice.close();
    assert.deepEqual(bob.sent.at(-1), {
        type: 'player_left',
        player: {id: alicePlayerId, userId: 'alice-id', username: 'Alice'}
    });
    assert.equal(room.players.has(alicePlayerId), false);
    assert.equal(room.players.has(bobPlayerId), true);
});

test('two tabs signed in to the same account remain separate players', async t => {
    const OriginalResponse = globalThis.Response;
    const OriginalWebSocketPair = globalThis.WebSocketPair;
    const pairs = [];
    globalThis.Response = FakeResponse;
    globalThis.WebSocketPair = class {
        constructor () {
            const pair = [new FakeSocket(), new FakeSocket()];
            pairs.push(pair);
            return pair;
        }
    };
    t.after(() => {
        globalThis.Response = OriginalResponse;
        globalThis.WebSocketPair = OriginalWebSocketPair;
    });

    const room = new GameRoom({});
    const firstTab = await connect(room, pairs, 'mist-account', 'Mist');
    const secondTab = await connect(room, pairs, 'mist-account', 'Mist');

    assert.equal(firstTab.readyState, 1);
    assert.equal(secondTab.readyState, 1);
    assert.equal(room.players.size, 2);
    assert.notEqual(firstTab.sent[0].self, secondTab.sent[0].self);
    assert.deepEqual(secondTab.sent[0].players.map(player => player.userId), ['mist-account', 'mist-account']);
});
