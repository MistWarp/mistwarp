const MAX_STATE_BYTES = 8192;
const MAX_EVENT_BYTES = 4096;
const MAX_MESSAGE_BYTES = 16384;

const byteLength = value => new TextEncoder().encode(value).byteLength;

const isPlainObject = value => Boolean(value) && typeof value === 'object' &&
    !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

const safeJSONValue = (value, depth = 0) => {
    if (depth > 8) return false;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (Array.isArray(value)) return value.length <= 256 && value.every(item => safeJSONValue(item, depth + 1));
    if (!isPlainObject(value)) return false;
    const keys = Object.keys(value);
    return keys.length <= 128 && keys.every(key =>
        key.length <= 64 && !key.startsWith('$') && key !== '__proto__' && key !== 'prototype' &&
        key !== 'constructor' && safeJSONValue(value[key], depth + 1));
};

const parseClientMessage = raw => {
    if (typeof raw !== 'string' || byteLength(raw) > MAX_MESSAGE_BYTES) throw new Error('message is too large');
    const message = JSON.parse(raw);
    if (!isPlainObject(message) || typeof message.type !== 'string') throw new Error('invalid message');
    return message;
};

const validateState = value => {
    if (!isPlainObject(value) || !safeJSONValue(value) || byteLength(JSON.stringify(value)) > MAX_STATE_BYTES) {
        throw new Error('state must be a safe JSON object no larger than 8 KiB');
    }
    return value;
};

const validateGameEvent = message => {
    const name = typeof message.name === 'string' ? message.name.trim() : '';
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(name)) {
        throw new Error('event name must be 1 to 64 letters, numbers, dots, colons, underscores, or dashes');
    }
    if (!safeJSONValue(message.value) || byteLength(JSON.stringify(message.value)) > MAX_EVENT_BYTES) {
        throw new Error('event value must be safe JSON no larger than 4 KiB');
    }
    if (message.to !== undefined && typeof message.to !== 'string') {
        throw new Error('event player ID must be a string');
    }
    const to = typeof message.to === 'string' ? message.to.trim() : '';
    if (to.length > 128) throw new Error('event player ID is too long');
    return {name, value: message.value, to};
};

export {parseClientMessage, validateState, validateGameEvent};
