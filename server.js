'use strict';
// VoxelWorld persistent multiplayer server. Room data is stored on disk in ./data.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const PORT = Number(process.env.PORT || 2567);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MAX_PLAYERS = 20;
const MAX_MESSAGE = 2 * 1024 * 1024;
fs.mkdirSync(DATA_DIR, { recursive: true });
const rooms = new Map();
const clients = new Map();

function cleanRoom(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12); }
function safeName(s) { return String(s || 'Игрок').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 20) || 'Игрок'; }
function roomFile(code) { return path.join(DATA_DIR, code + '.json'); }
function newWorld() { return { v: 2, seed: Math.floor(Math.random() * 1e9), mode: 'survival', pl: { x: 8.5, y: 80, z: 8.5, yaw: 0, pitch: 0, fly: false }, inv: new Array(36).fill(null), sel: 0, time: 0.1, edits: {}, containers: { chests: {}, furnaces: {} } }; }
function loadRoom(code) {
  if (rooms.has(code)) return rooms.get(code);
  let room;
  try { room = JSON.parse(fs.readFileSync(roomFile(code), 'utf8')); } catch (_) { return null; }
  if (!room || !room.world) return null;
  room.players = new Map(); room.profiles = room.profiles || {}; rooms.set(code, room); return room;
}
let saveQueue = Promise.resolve();
function persist(room) {
  const serial = { code: room.code, ownerToken: room.ownerToken, ownerName: room.ownerName, createdAt: room.createdAt, world: room.world, profiles: room.profiles || {} };
  const file = roomFile(room.code), tmp = file + '.tmp';
  saveQueue = saveQueue.then(() => fs.promises.writeFile(tmp, JSON.stringify(serial))).then(() => fs.promises.rename(tmp, file)).catch(err => console.error('save failed', err));
  return saveQueue;
}
function send(ws, obj) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
function publicPlayers(room) { return [...room.players.values()].map(p => ({ id: p.id, name: p.name, x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch })); }
function broadcast(room, obj, except) { for (const p of room.players.values()) if (p.ws !== except) send(p.ws, obj); }
function validPos(p) { return p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z) && Math.abs(p.x) < 1e7 && Math.abs(p.y) < 512 && Math.abs(p.z) < 1e7; }
function join(ws, msg, isCreate) {
  let code = isCreate ? '' : cleanRoom(msg.room);
  if (isCreate) { do { code = crypto.randomBytes(3).toString('hex').toUpperCase(); } while (loadRoom(code)); }
  let room = loadRoom(code);
  if (!room && !isCreate) return send(ws, { type: 'error', message: 'Комната не найдена. Проверь код.' });
  if (!room) {
    room = { code, ownerToken: String(msg.ownerToken || ''), ownerName: safeName(msg.name), createdAt: Date.now(), world: newWorld(), profiles: {}, players: new Map() };
    rooms.set(code, room);
  }
  if (room.players.size >= MAX_PLAYERS) return send(ws, { type: 'error', message: 'В комнате уже 20 игроков.' });
  const id = crypto.randomUUID();
  const player = { id, ws, name: safeName(msg.name), x: 8.5, y: 80, z: 8.5, yaw: 0, pitch: 0, joinedAt: Date.now() };
  const playerToken = String(msg.playerToken || '').slice(0, 128);
  room.players.set(id, player); clients.set(ws, { room, player, owner: !!room.ownerToken && msg.ownerToken === room.ownerToken, playerToken });
  const clientWorld = JSON.parse(JSON.stringify(room.world));
  const profile = playerToken ? room.profiles[playerToken] || null : null;
  if (profile && profile.pl) clientWorld.pl = profile.pl;
  else if (!clients.get(ws).owner && clientWorld.pl) { const offset = Math.max(1, room.players.size - 1) * 2; clientWorld.pl.x += offset; clientWorld.pl.z += offset; }
  if (profile && profile.inv) clientWorld.inv = profile.inv;
  else if (!clients.get(ws).owner) clientWorld.inv = new Array(36).fill(null);
  send(ws, { type: 'joined', id, room: code, owner: clients.get(ws).owner, players: publicPlayers(room), world: clientWorld, profile, maxPlayers: MAX_PLAYERS });
  broadcast(room, { type: 'players', id, players: publicPlayers(room), count: room.players.size }, ws);
  broadcast(room, { type: 'count', count: room.players.size });
  if (isCreate) persist(room);
  console.log(`${player.name} joined ${code} (${room.players.size}/${MAX_PLAYERS})`);
}
function applyMessage(ws, msg) {
  const state = clients.get(ws);
  if (!state) {
    if (msg.type === 'create') return join(ws, msg, true);
    if (msg.type === 'join') return join(ws, msg, false);
    return send(ws, { type: 'error', message: 'Сначала создай комнату или войди по коду.' });
  }
  const { room, player, owner, playerToken } = state;
  if (msg.type === 'move' && validPos(msg.player)) {
    const p = msg.player; player.x = p.x; player.y = p.y; player.z = p.z; player.yaw = Number(p.yaw) || 0; player.pitch = Number(p.pitch) || 0;
    broadcast(room, { type: 'player', id: player.id, player: { id: player.id, name: player.name, x: player.x, y: player.y, z: player.z, yaw: player.yaw, pitch: player.pitch } }, ws);
  } else if (msg.type === 'block') {
    const x = Math.trunc(msg.x), y = Math.trunc(msg.y), z = Math.trunc(msg.z), id = Math.trunc(msg.id);
    if (![x,y,z,id].every(Number.isFinite) || Math.abs(x)>1e7 || Math.abs(z)>1e7 || y<0 || y>127 || id<0 || id>65535) return;
    const cx = Math.floor(x / 16), cz = Math.floor(z / 16), lx = ((x % 16) + 16) % 16, lz = ((z % 16) + 16) % 16;
    const index = lx + 16 * (lz + 16 * y), ck = cx + ',' + cz;
    if (!room.world.edits) room.world.edits = {};
    if (!room.world.edits[ck]) room.world.edits[ck] = {};
    room.world.edits[ck][index] = id;
    broadcast(room, { type: 'block', x, y, z, id, by: player.id }, ws);
    persist(room);
  } else if (msg.type === 'profile' && playerToken && msg.profile && typeof msg.profile === 'object') {
    const profile = msg.profile;
    if (profile.pl && validPos(profile.pl) && Array.isArray(profile.inv) && profile.inv.length <= 36) {
      room.profiles[playerToken] = { pl: profile.pl, inv: profile.inv, sel: Number.isInteger(profile.sel) ? profile.sel : 0, mode: profile.mode === 'creative' ? 'creative' : 'survival', updatedAt: Date.now() };
      persist(room);
    }
  } else if (msg.type === 'save' && owner && msg.world && typeof msg.world === 'object') {
    // Owner may update global world metadata; edits from every player are also persisted as block events.
    const w = msg.world;
    if (Number.isFinite(w.seed) && w.edits && typeof w.edits === 'object') {
      const mergedEdits = { ...(room.world.edits || {}) };
      for (const [chunkKey, chunkEdits] of Object.entries(w.edits)) mergedEdits[chunkKey] = { ...(mergedEdits[chunkKey] || {}), ...(chunkEdits || {}) };
      room.world = { ...room.world, v: w.v || 2, seed: w.seed, mode: w.mode || room.world.mode, pl: w.pl || room.world.pl, inv: w.inv || room.world.inv, sel: Number.isInteger(w.sel) ? w.sel : room.world.sel, time: Number.isFinite(w.time) ? w.time : room.world.time, containers: w.containers || room.world.containers, edits: mergedEdits };
      persist(room);
    }
  } else if (msg.type === 'ping') send(ws, { type: 'pong', at: Date.now() });
}
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, service: 'VoxelWorld multiplayer', rooms: rooms.size, maxPlayers: MAX_PLAYERS })); }
  res.writeHead(404); res.end('Not found');
});
const wss = new WebSocketServer({ server, maxPayload: MAX_MESSAGE });
wss.on('connection', ws => {
  ws.on('message', raw => { try { const msg = JSON.parse(raw.toString()); if (!msg || typeof msg !== 'object') return; applyMessage(ws, msg); } catch (e) { send(ws, { type: 'error', message: 'Некорректное сообщение.' }); } });
  ws.on('close', () => { const s = clients.get(ws); if (!s) return; const { room, player } = s; room.players.delete(player.id); clients.delete(ws); broadcast(room, { type: 'left', id: player.id, count: room.players.size }); broadcast(room, { type: 'count', count: room.players.size }); persist(room); console.log(`${player.name} left ${room.code}`); });
  ws.on('error', () => {});
});
server.listen(PORT, '0.0.0.0', () => console.log(`VoxelWorld multiplayer listening on ${PORT}`));
