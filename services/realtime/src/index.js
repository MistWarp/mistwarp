import {parseClientMessage, validateGameEvent, validateState} from './protocol.js';

const json = (value, status = 200) => new Response(JSON.stringify(value), {
    status,
    headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}
});

const socketOpen = socket => socket.readyState === 1;
const multiplayerEnabled = false;

export class GameRoom {
    constructor (state) {
        this.state = state;
        this.players = new Map();
    }

    async fetch (request) {
        if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ok: false, error: 'websocket required'}, 426);
        if (this.players.size >= 50) return json({ok: false, error: 'room is full'}, 503);
        const identity = JSON.parse(request.headers.get('X-MistWarp-Identity') || '{}');
        if (!identity.userId || !identity.username) return json({ok: false, error: 'identity required'}, 401);

        const pair = new WebSocketPair();
        const client = pair[0];
        const socket = pair[1];
        socket.accept();
        const player = {
            id: crypto.randomUUID(),
            userId: String(identity.userId),
            username: String(identity.username).slice(0, 64),
            state: {},
            socket,
            messageTimes: []
        };
        this.players.set(player.id, player);
        socket.addEventListener('message', event => this.onMessage(player, event.data));
        socket.addEventListener('close', () => this.onClose(player));
        socket.addEventListener('error', () => this.onClose(player));

        this.send(player, {type: 'welcome', self: player.id, players: this.roster()});
        this.broadcast({type: 'player_joined', player: this.publicPlayer(player)}, player.id);
        return new Response(null, {status: 101, webSocket: client});
    }

    publicPlayer (player) {
        return {id: player.id, userId: player.userId, username: player.username, state: player.state};
    }

    roster () {
        return [...this.players.values()].map(player => this.publicPlayer(player));
    }

    allow (times, maximum, windowMs) {
        const cutoff = Date.now() - windowMs;
        while (times.length && times[0] < cutoff) times.shift();
        if (times.length >= maximum) return false;
        times.push(Date.now());
        return true;
    }

    onMessage (player, raw) {
        try {
            if (!this.allow(player.messageTimes, 30, 1000)) throw new Error('sending updates too quickly');
            const message = parseClientMessage(raw);
            // Identity was verified before upgrading the HTTP request.
            if (message.type === 'authenticate') return;
            if (message.type === 'ping') {
                this.send(player, {type: 'pong', at: Date.now()});
                return;
            }
            if (message.type === 'state') {
                player.state = validateState(message.value);
                this.broadcast({type: 'player_state', player: this.publicPlayer(player)});
                return;
            }
            if (message.type === 'game_event') {
                const event = validateGameEvent(message);
                const packet = {
                    type: 'game_event',
                    name: event.name,
                    value: event.value,
                    sender: {id: player.id, userId: player.userId, username: player.username}
                };
                if (event.to) {
                    const recipient = this.players.get(event.to);
                    if (!recipient) throw new Error('event player is not in the room');
                    this.send(recipient, packet);
                } else {
                    this.broadcast(packet);
                }
                return;
            }
            throw new Error('unknown message type');
        } catch (error) {
            this.send(player, {type: 'error', error: error instanceof Error ? error.message : 'invalid message'});
        }
    }

    onClose (player) {
        if (this.players.get(player.id) !== player) return;
        this.players.delete(player.id);
        this.broadcast({
            type: 'player_left',
            player: {id: player.id, userId: player.userId, username: player.username}
        });
    }

    send (player, message) {
        this.sendEncoded(player, JSON.stringify(message));
    }

    sendEncoded (player, encoded) {
        try {
            if (socketOpen(player.socket)) {
                player.socket.send(encoded);
                return;
            }
        } catch (error) { /* A failed peer must not interrupt delivery to others. */ }
        this.onClose(player);
    }

    broadcast (message, exceptId = '') {
        const encoded = JSON.stringify(message);
        for (const player of this.players.values()) {
            if (player.id !== exceptId) this.sendEncoded(player, encoded);
        }
    }
}

const allowedOrigin = (request, env) => {
    const origin = request.headers.get('Origin') || '';
    const allowedOrigins = String(env.ALLOWED_ORIGINS || env.ALLOWED_ORIGIN || '')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean);
    if (allowedOrigins.includes(origin)) return true;
    return /^http:\/\/localhost:\d+$/.test(origin) && allowedOrigins.some(value => /localhost/.test(value));
};

const verifyTicket = async (ticket, env) => {
    const response = await fetch(`${env.API_URL}/internal/multiplayer/verify`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Realtime-Service-Key': env.REALTIME_SERVICE_KEY
        },
        body: JSON.stringify({ticket})
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || 'ticket verification failed');
    return result.identity;
};

export default {
    async fetch (request, env) {
        const url = new URL(request.url);
        if (url.pathname === '/health') return json({ok: true});
        if (url.pathname !== '/v1/connect') return json({ok: false, error: 'not found'}, 404);
        if (!multiplayerEnabled) return json({ok: false, error: 'multiplayer is disabled'}, 503);
        if (!allowedOrigin(request, env)) return json({ok: false, error: 'origin not allowed'}, 403);
        if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ok: false, error: 'websocket required'}, 426);
        const ticket = url.searchParams.get('ticket') || '';
        if (!/^mwt_[A-Za-z0-9_-]{40,80}$/.test(ticket)) return json({ok: false, error: 'invalid ticket'}, 401);
        try {
            const identity = await verifyTicket(ticket, env);
            const roomName = `${identity.projectId}:${identity.projectVersion}:${identity.context}:${identity.room}`;
            const room = env.ROOMS.getByName(roomName);
            const headers = new Headers(request.headers);
            headers.set('X-MistWarp-Identity', JSON.stringify(identity));
            return room.fetch(new Request(request, {headers}));
        } catch (error) {
            return json({ok: false, error: error instanceof Error ? error.message : 'connection failed'}, 401);
        }
    }
};
