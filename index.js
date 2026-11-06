import { DurableObject } from 'cloudflare:workers';

const MAX_PLAYERS = 20;
const MAX_MESSAGE = 2 * 1024 * 1024;
const ROOM_RE = /^[A-Z0-9]{1,12}$/;

function cleanRoom(value) { return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12); }
function safeName(value) { return String(value || 'Игрок').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 20) || 'Игрок'; }
function newCode() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => (b % 36).toString(36)).join('').toUpperCase();
}
function newId() { return crypto.randomUUID(); }
function newWorld() {
  return { v: 2, seed: Math.floor(Math.random() * 1e9), mode: 'survival', pl: { x: 8.5, y: 80, z: 8.5, yaw: 0, pitch: 0, fly: false }, inv: new Array(36).fill(null), sel: 0, time: 0.1, edits: {}, containers: { chests: {}, furnaces: {} } };
}
function validPos(p) {
  return p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z) && Math.abs(p.x) < 1e7 && Math.abs(p.y) < 512 && Math.abs(p.z) < 1e7;
}
function asText(message) {
  if (typeof message === 'string') return message;
  if (message instanceof ArrayBuffer) return new TextDecoder().decode(message);
  if (ArrayBuffer.isView(message)) return new TextDecoder().decode(message);
  return '';
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/health') {
      return Response.json({ ok: true, service: 'VoxelWorld Cloudflare multiplayer', maxPlayers: MAX_PLAYERS, websocket: '/ws' });
    }
    if (url.pathname !== '/ws') return new Response('Not found', { status: 404 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
    const id = env.HUB.idFromName('voxelworld-global-hub-v1');
    return env.HUB.get(id).fetch(request);
  }
};

// A single SQLite-backed hub keeps room codes dynamic while preserving room data
// independently of whether the room owner is connected. Runtime sockets are hibernatable.
export class VoxelRoomHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS rooms (
      code TEXT PRIMARY KEY,
      owner_token TEXT NOT NULL,
      owner_name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      world TEXT NOT NULL,
      profiles TEXT NOT NULL
    )`);
  }

  async fetch(request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ room: '', id: '', name: 'Игрок', owner: false, playerToken: '', x: 8.5, y: 80, z: 8.5, yaw: 0, pitch: 0 });
    return new Response(null, { status: 101, webSocket: client });
  }

  _room(code) {
    const row = this.ctx.storage.sql.exec('SELECT code, owner_token, owner_name, created_at, world, profiles FROM rooms WHERE code = ?', code).toArray()[0];
    if (!row) return null;
    try {
      return { code: row.code, ownerToken: row.owner_token, ownerName: row.owner_name, createdAt: row.created_at, world: JSON.parse(row.world), profiles: JSON.parse(row.profiles || '{}') };
    } catch (_) { return null; }
  }

  _save(room) {
    this.ctx.storage.sql.exec(
      'INSERT INTO rooms (code, owner_token, owner_name, created_at, world, profiles) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(code) DO UPDATE SET owner_token=excluded.owner_token, owner_name=excluded.owner_name, created_at=excluded.created_at, world=excluded.world, profiles=excluded.profiles',
      room.code, room.ownerToken, room.ownerName, room.createdAt, JSON.stringify(room.world), JSON.stringify(room.profiles || {})
    );
  }

  _send(ws, value) {
    try { ws.send(JSON.stringify(value)); } catch (_) {}
  }

  _players(code) {
    const result = [];
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a && a.room === code && a.id) result.push({ id: a.id, name: a.name, x: a.x, y: a.y, z: a.z, yaw: a.yaw, pitch: a.pitch });
    }
    return result;
  }

  _broadcast(code, value, except) {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      const a = ws.deserializeAttachment();
      if (a && a.room === code && a.id) this._send(ws, value);
    }
  }

  async webSocketMessage(ws, message) {
    const raw = asText(message);
    if (!raw || raw.length > MAX_MESSAGE) { this._send(ws, { type: 'error', message: 'Сообщение слишком большое или пустое.' }); return; }
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { this._send(ws, { type: 'error', message: 'Некорректное сообщение.' }); return; }
    if (!msg || typeof msg !== 'object') return;
    const state = ws.deserializeAttachment() || {};

    if (!state.id) {
      if (msg.type !== 'create' && msg.type !== 'join') { this._send(ws, { type: 'error', message: 'Сначала создай комнату или войди по коду.' }); return; }
      const isCreate = msg.type === 'create';
      let code = isCreate ? '' : cleanRoom(msg.room);
      let room = null;
      if (isCreate) {
        for (let i = 0; i < 8; i++) { code = newCode(); if (!this._room(code)) break; }
        if (this._room(code)) { this._send(ws, { type: 'error', message: 'Не удалось создать код комнаты. Попробуй ещё раз.' }); return; }
        room = { code, ownerToken: String(msg.ownerToken || '').slice(0, 128), ownerName: safeName(msg.name), createdAt: Date.now(), world: newWorld(), profiles: {} };
        this._save(room);
      } else {
        if (!ROOM_RE.test(code)) { this._send(ws, { type: 'error', message: 'Неверный код комнаты.' }); return; }
        room = this._room(code);
        if (!room) { this._send(ws, { type: 'error', message: 'Комната не найдена. Проверь код.' }); return; }
      }
      const active = this._players(code);
      if (active.length >= MAX_PLAYERS) { this._send(ws, { type: 'error', message: 'В комнате уже 20 игроков.' }); return; }
      const owner = !!room.ownerToken && String(msg.ownerToken || '') === room.ownerToken;
      const id = newId();
      const playerToken = String(msg.playerToken || '').slice(0, 128);
      const player = { room: code, id, name: safeName(msg.name), owner, playerToken, x: 8.5, y: 80, z: 8.5, yaw: 0, pitch: 0 };
      ws.serializeAttachment(player);
      const clientWorld = structuredClone(room.world);
      const profile = playerToken ? room.profiles[playerToken] || null : null;
      if (profile && profile.pl) clientWorld.pl = profile.pl;
      else if (!owner && clientWorld.pl) { const offset = Math.max(1, active.length) * 2; clientWorld.pl.x += offset; clientWorld.pl.z += offset; }
      if (profile && profile.inv) clientWorld.inv = profile.inv;
      else if (!owner) clientWorld.inv = new Array(36).fill(null);
      this._send(ws, { type: 'joined', id, room: code, owner, players: [...active, { id, name: player.name, x: player.x, y: player.y, z: player.z, yaw: 0, pitch: 0 }], world: clientWorld, profile, maxPlayers: MAX_PLAYERS });
      this._broadcast(code, { type: 'players', id, players: [...active, { id, name: player.name, x: player.x, y: player.y, z: player.z, yaw: 0, pitch: 0 }], count: active.length + 1 }, ws);
      this._broadcast(code, { type: 'count', count: active.length + 1 });
      return;
    }

    const room = this._room(state.room);
    if (!room) { this._send(ws, { type: 'error', message: 'Данные комнаты не найдены.' }); return; }

    if (msg.type === 'move' && validPos(msg.player)) {
      const p = msg.player;
      const next = { ...state, x: p.x, y: p.y, z: p.z, yaw: Number(p.yaw) || 0, pitch: Number(p.pitch) || 0 };
      ws.serializeAttachment(next);
      this._broadcast(state.room, { type: 'player', id: state.id, player: { id: state.id, name: state.name, x: next.x, y: next.y, z: next.z, yaw: next.yaw, pitch: next.pitch } }, ws);
    } else if (msg.type === 'block') {
      const x = Math.trunc(msg.x), y = Math.trunc(msg.y), z = Math.trunc(msg.z), blockId = Math.trunc(msg.id);
      if (![x, y, z, blockId].every(Number.isFinite) || Math.abs(x) > 1e7 || Math.abs(z) > 1e7 || y < 0 || y > 127 || blockId < 0 || blockId > 65535) return;
      const cx = Math.floor(x / 16), cz = Math.floor(z / 16), lx = ((x % 16) + 16) % 16, lz = ((z % 16) + 16) % 16;
      const index = lx + 16 * (lz + 16 * y), chunkKey = cx + ',' + cz;
      if (!room.world.edits) room.world.edits = {};
      if (!room.world.edits[chunkKey]) room.world.edits[chunkKey] = {};
      room.world.edits[chunkKey][index] = blockId;
      this._save(room);
      this._broadcast(state.room, { type: 'block', x, y, z, id: blockId, by: state.id }, ws);
    } else if (msg.type === 'profile' && state.playerToken && msg.profile && typeof msg.profile === 'object') {
      const p = msg.profile;
      if (p.pl && validPos(p.pl) && Array.isArray(p.inv) && p.inv.length <= 36) {
        room.profiles[state.playerToken] = { pl: p.pl, inv: p.inv, sel: Number.isInteger(p.sel) ? p.sel : 0, mode: p.mode === 'creative' ? 'creative' : 'survival', updatedAt: Date.now() };
        this._save(room);
      }
    } else if (msg.type === 'save' && state.owner && msg.world && typeof msg.world === 'object') {
      const w = msg.world;
      if (Number.isFinite(w.seed) && w.edits && typeof w.edits === 'object') {
        const mergedEdits = { ...(room.world.edits || {}) };
        for (const [chunkKey, chunkEdits] of Object.entries(w.edits)) mergedEdits[chunkKey] = { ...(mergedEdits[chunkKey] || {}), ...(chunkEdits || {}) };
        room.world = { ...room.world, v: w.v || 2, seed: w.seed, mode: w.mode || room.world.mode, pl: w.pl || room.world.pl, inv: w.inv || room.world.inv, sel: Number.isInteger(w.sel) ? w.sel : room.world.sel, time: Number.isFinite(w.time) ? w.time : room.world.time, containers: w.containers || room.world.containers, edits: mergedEdits };
        this._save(room);
      }
    } else if (msg.type === 'ping') {
      this._send(ws, { type: 'pong', at: Date.now() });
    }
  }

  async webSocketClose(ws) {
    const state = ws.deserializeAttachment() || {};
    if (!state.room || !state.id) return;
    const left = this._players(state.room).filter(player => player.id !== state.id);
    this._broadcast(state.room, { type: 'left', id: state.id, count: left.length });
    this._broadcast(state.room, { type: 'count', count: left.length });
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }
}
