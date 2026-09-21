import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {runChecks} from '../src/index.js';
import {STATUS_KEY, HISTORY_KEY} from '../src/status-store.js';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const wrangler = (...args) => execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...args], {
    encoding: 'utf8', maxBuffer: 20 * 1024 * 1024
});
const keys = JSON.parse(wrangler('kv', 'key', 'list', '--binding', 'STATUS_KV', '--remote'));
if (keys.some(key => [STATUS_KEY, HISTORY_KEY].includes(key.name))) {
    throw new Error('Status KV already contains snapshots. Refusing to overwrite live data.');
}
mkdirSync('.wrangler', {recursive: true});
const backup = mkdtempSync('.wrangler/kv-init-');
const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
await runChecks({
    CHECKS_JSON: config.vars.CHECKS_JSON,
    STATUS_KV: {
        list: async ({prefix, limit}) => ({keys: keys.filter(key => key.name.startsWith(prefix)).slice(0, limit)}),
        get: async key => keys.some(item => item.name === key) ?
            JSON.parse(wrangler('kv', 'key', 'get', key, '--binding', 'STATUS_KV', '--remote', '--text')) : null,
        put: async (key, value) => {
            const path = join(backup, `${key}.json`);
            writeFileSync(path, value, {mode: 0o600});
            wrangler('kv', 'key', 'put', key, '--binding', 'STATUS_KV', '--remote', '--path', path);
        }
    }
});
console.log(`Initialized KV from fresh health checks. Local snapshot copies: ${backup}`);
