import test from 'node:test';
import assert from 'node:assert/strict';
import {parseClientMessage, validateGameEvent, validateState} from '../src/protocol.js';

test('accepts compact player JSON state', () => {
    const value = {position: {x: 12, y: -8}, animation: 'walk'};
    assert.deepEqual(validateState(value), value);
    assert.deepEqual(parseClientMessage(JSON.stringify({type: 'state', value})).value, value);
});

test('rejects unsafe or oversized state', () => {
    assert.throws(() => validateState({$server: true}), /safe JSON/);
    assert.throws(() => validateState({constructor: 'bad'}), /safe JSON/);
    assert.throws(() => validateState({value: 'x'.repeat(9000)}), /8 KiB/);
});

test('validates broadcast and targeted game events', () => {
    assert.deepEqual(validateGameEvent({name: 'round.started', value: {round: 2}}), {
        name: 'round.started',
        value: {round: 2},
        to: ''
    });
    assert.deepEqual(validateGameEvent({name: 'your-turn', value: true, to: 'player-2'}), {
        name: 'your-turn',
        value: true,
        to: 'player-2'
    });
    assert.throws(() => validateGameEvent({name: 'bad event', value: 1}), /event name/);
    assert.throws(() => validateGameEvent({name: 'large', value: 'x'.repeat(5000)}), /4 KiB/);
});
