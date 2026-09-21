import test from 'node:test';
import assert from 'node:assert/strict';
import {parseChecks} from '../src/index.js';

test('parseChecks accepts configured HTTPS checks', () => {
    assert.deepEqual(parseChecks('[{"id":"api","name":"API","url":"https://example.com/health"}]'), [
        {id: 'api', name: 'API', url: 'https://example.com/health'}
    ]);
});

test('parseChecks rejects insecure and incomplete checks', () => {
    assert.deepEqual(parseChecks('[{"id":"bad","name":"Bad","url":"http://example.com"},{"id":"missing"}]'), []);
});

test('parseChecks rejects a non-array value', () => {
    assert.throws(() => parseChecks('{}'), /array/);
});
