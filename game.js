'use strict';
// VOXEL WORLD — браузерный порт (WebGL2, без внешних библиотек). Блоки и атлас — из Unity-проекта.
(function () {
const SX = 16, SY = 128, SZ = 16, SEA = 44, TILES = 32;
const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const $ = id => document.getElementById(id);

// ---------- блоки и предметы (данные из Unity-проекта) ----------
const GD = window.GAME_DATA, N = 512;
const TOP = new Int16Array(N), SIDE = new Int16Array(N), BOT = new Int16Array(N);
const SOLID = new Uint8Array(N), TRANSP = new Uint8Array(N), OPAQUE = new Uint8Array(N), HARD = new Float32Array(N), DEF = new Array(N);
const B = {};
for (const d of GD.blocks) { const i = d.id; TOP[i] = d.top; SIDE[i] = d.side; BOT[i] = d.bot; SOLID[i] = d.solid ? 1 : 0; TRANSP[i] = d.transp ? 1 : 0; HARD[i] = d.hard; DEF[i] = d; B[d.key] = i;
  OPAQUE[i] = (d.shape === 'Cube' && d.solid && !d.transp) ? 1 : 0; }
SOLID[0] = 0; TRANSP[0] = 1; OPAQUE[0] = 0;
const ITEMS = {}; for (const it of GD.items) ITEMS[it.id] = it;
const WATER = B.Water, AIR = 0;
const LEAVES = new Set([B.OakLeaves, B.BirchLeaves, B.SpruceLeaves, B.JungleLeaves, B.AcaciaLeaves].filter(x => x));
const NOPICK = /^(Air|Water|Lava|Bedrock|Wheat|LootChest|Farmland|Fire|Portal|EndPortal|Nether(Portal)?$)/;
const PICK_BLOCKS = GD.blocks.filter(d => d.id > 0 && !d.hidden && !NOPICK.test(d.key)).map(d => d.id);
const PICK_ITEMS = GD.items.map(d => d.id);
const itemName = id => id >= 1000 ? (ITEMS[id] ? ITEMS[id].name : '?') : (DEF[id & 511] ? DEF[id & 511].name : '?');
const maxStack = id => id >= 1000 ? (ITEMS[id] ? ITEMS[id].max : 64) : 64;
const iconTile = id => { if (id >= 1000) return ITEMS[id] ? ITEMS[id].tile : 0; const d = DEF[id & 511]; return d ? (d.shape === 'Cube' ? d.top : d.side) : 0; };
const facingOf = (fx, fz) => Math.abs(fz) > Math.abs(fx) ? (fz > 0 ? 0 : 2) : (fx > 0 ? 1 : 3);

// ---------- шум ----------
let SEED = 12345;
function hash2(x, z, s) { let h = (Math.imul(x, 374761393) + Math.imul(z, 668265263) + Math.imul(s, 1013904223)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16; return (h >>> 0) / 4294967296; }
function hash3(x, y, z, s) { return hash2(x + Math.imul(y, 7919), z, s); }
function sm(t) { return t * t * (3 - 2 * t); }
function noise2(x, z, s) { const xi = Math.floor(x), zi = Math.floor(z), fx = sm(x - xi), fz = sm(z - zi);
  const a = hash2(xi, zi, s), b = hash2(xi + 1, zi, s), c = hash2(xi, zi + 1, s), d = hash2(xi + 1, zi + 1, s);
  return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fz; }
function noise3(x, y, z, s) { const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), fx = sm(x - xi), fy = sm(y - yi), fz = sm(z - zi);
  const l = (a, b, t) => a + (b - a) * t;
  const c = (dx, dy, dz) => hash3(xi + dx, yi + dy, zi + dz, s);
  return l(l(l(c(0,0,0), c(1,0,0), fx), l(c(0,1,0), c(1,1,0), fx), fy), l(l(c(0,0,1), c(1,0,1), fx), l(c(0,1,1), c(1,1,1), fx), fy), fz); }

function heightAt(wx, wz) { const o = (SEED % 10007) * 0.173;
  const n = noise2(wx * 0.01 + o, wz * 0.01 + o, SEED) * 0.7 + noise2(wx * 0.05 + o, wz * 0.05 + o, SEED + 1) * 0.3;
  return Math.max(2, Math.min(SY - 12, 30 + Math.round(n * 40))); }
// 0 равнины, 1 лес, 2 пустыня, 3 снег, 4 саванна, 5 джунгли
function biomeAt(wx, wz) { const o = (SEED % 10007) * 0.173;
  const t = noise2(wx * 0.004 + o + 1000, wz * 0.004 + o + 1000, SEED + 2), m = noise2(wx * 0.004 + o + 2000, wz * 0.004 + o + 2000, SEED + 3);
  if (t < 0.4) return 3; if (t > 0.6) return m < 0.45 ? 2 : m < 0.55 ? 4 : 5; return m > 0.52 ? 1 : 0; }

// ---------- чанки ----------
class Chunk { constructor(cx, cz) { this.cx = cx; this.cz = cz; this.data = new Uint16Array(SX * SY * SZ); this.mesh = null; this.dirty = true; this.edits = {}; this.maxY = 0; } }
const chunks = new Map(); const key = (cx, cz) => cx + ',' + cz;
let multiplayer = null, remotePlayers = new Map(), lastNetPos = 0, lastProfileSave = 0, lastNetState = null, onlineRoom = '', myPlayerId = '';
let applyingRemoteBlock = false;
const idx = (x, y, z) => x + SX * (z + SZ * y);
function getBlock(wx, y, wz) { if (y < 0) return B.Bedrock; if (y >= SY) return AIR; const c = chunks.get(key(wx >> 4, wz >> 4)); if (!c) return -1; return c.data[idx(wx & 15, y, wz & 15)]; }
function setBlock(wx, y, wz, id, record = true) { if (y < 0 || y >= SY) return; const c = chunks.get(key(wx >> 4, wz >> 4)); if (!c) return;
  const lx = wx & 15, lz = wz & 15; c.data[idx(lx, y, lz)] = id; if (y > c.maxY) c.maxY = y; c.dirty = true;
  if (record) { c.edits[idx(lx, y, lz)] = id; saveDirty = true; if (multiplayer && !applyingRemoteBlock) multiplayer.send({ type: 'block', x: wx, y, z: wz, id }); }
  if (lx === 0) mark(c.cx - 1, c.cz); if (lx === 15) mark(c.cx + 1, c.cz); if (lz === 0) mark(c.cx, c.cz - 1); if (lz === 15) mark(c.cx, c.cz + 1); }
function mark(cx, cz) { const c = chunks.get(key(cx, cz)); if (c) c.dirty = true; }

function treeAt(wx, wz, bi) { const p = bi === 1 ? 0.045 : bi === 5 ? 0.06 : bi === 0 ? 0.008 : bi === 4 ? 0.006 : bi === 3 ? 0.012 : bi === 2 ? 0.006 : 0; return p > 0 && hash2(wx, wz, SEED + 77) < p; }

function genChunk(c) {
  const d = c.data, bx = c.cx * SX, bz = c.cz * SZ; let maxY = 0;
  for (let z = 0; z < SZ; z++) for (let x = 0; x < SX; x++) {
    const wx = bx + x, wz = bz + z, h = heightAt(wx, wz), bi = biomeAt(wx, wz);
    const top = bi === 2 ? B.Sand : bi === 3 ? B.Snow : B.Grass, sub = bi === 2 ? B.Sand : B.Dirt;
    for (let y = 0; y <= Math.max(h, SEA); y++) {
      let id;
      if (y === 0) id = B.Bedrock;
      else if (y > h) id = WATER;
      else if (y === h) id = (h <= SEA + 1 && bi !== 3) ? B.Sand : top;
      else if (y >= h - 3) id = (h <= SEA + 1) ? B.Sand : sub;
      else {
        id = B.Stone;
        const r = hash3(wx, y, wz, SEED + 9);
        if (y < 14 && r < 0.0035) id = B.DiamondOre; else if (y < 28 && r < 0.006) id = B.GoldOre; else if (r < 0.014) id = B.IronOre; else if (r < 0.03) id = B.CoalOre;
        if (y > 2 && y < h - 4 && noise3(wx * 0.07, y * 0.09, wz * 0.07, SEED + 5) > 0.72) id = AIR; // пещеры
      }
      d[idx(x, y, z)] = id; if (id && y > maxY) maxY = y;
    }
  }
  // деревья и кактусы (детерминированно, пересекают границы чанков без швов)
  for (let wz = bz - 3; wz < bz + SZ + 3; wz++) for (let wx = bx - 3; wx < bx + SX + 3; wx++) {
    const bi = biomeAt(wx, wz); if (!treeAt(wx, wz, bi)) continue;
    const h = heightAt(wx, wz); if (h <= SEA + 1) continue;
    const put = (x, y, z, id, onlyAir) => { const lx = x - bx, lz = z - bz; if (lx < 0 || lx >= SX || lz < 0 || lz >= SZ || y >= SY) return; const i = idx(lx, y, lz); if (!onlyAir || d[i] === AIR) { d[i] = id; if (y > maxY) maxY = y; } };
    if (bi === 2) { const hh = 2 + (hash2(wx, wz, 5) * 3 | 0); for (let i = 1; i <= hh; i++) put(wx, h + i, wz, B.Cactus, false); continue; }
    const th = (bi === 5 ? 7 : 4) + (hash2(wx, wz, 6) * 3 | 0);
    const log = bi === 3 ? B.SpruceLog : bi === 5 ? B.JungleLog : bi === 4 ? B.AcaciaLog : B.OakLog;
    const lv = bi === 3 ? B.SpruceLeaves : bi === 5 ? B.JungleLeaves : bi === 4 ? B.AcaciaLeaves : B.OakLeaves;
    for (let ly = th - 2; ly <= th + 1; ly++) { const r = ly >= th ? 1 : 2; for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) { if (r === 2 && Math.abs(dx) === 2 && Math.abs(dz) === 2) continue; put(wx + dx, h + ly, wz + dz, lv, true); } }
    for (let i = 1; i <= th; i++) put(wx, h + i, wz, log, false);
  }
  c.maxY = maxY;
  for (const k in c.edits) { const i = +k, id = c.edits[k]; d[i] = id; const y = (i / (SX * SZ)) | 0; if (y > c.maxY) c.maxY = y; }
}

// ---------- GL ----------
const canvas = $('c');
const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance' });
if (!gl) { document.body.innerHTML = '<div style="padding:30px;font:18px sans-serif;color:#fff">Ваш браузер не поддерживает WebGL 2. Обновите iOS / откройте в Chrome.</div>'; return; }
function prog(vs, fs) { const p = gl.createProgram(); for (const [t, s] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) { const sh = gl.createShader(t); gl.shaderSource(sh, s); gl.compileShader(sh); if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh)); gl.attachShader(p, sh); } gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p)); return p; }
const P = prog(`#version 300 es
in vec3 aP; in vec2 aUV; in float aS; uniform mat4 uVP; uniform vec3 uCam; out vec2 vUV; out float vS; out float vD;
void main(){ vec4 p=uVP*vec4(aP,1.0); gl_Position=p; vUV=aUV; vS=aS; vD=length(aP-uCam); }`,
`#version 300 es
precision mediump float; in vec2 vUV; in float vS; in float vD; uniform sampler2D uT; uniform float uL; uniform vec3 uFog; uniform vec2 uFogR; uniform float uA; out vec4 o;
void main(){ vec4 c=texture(uT,vUV); if(uA>=1.0 && c.a<0.5) discard; vec3 col=c.rgb*vS*uL; float f=clamp((vD-uFogR.x)/(uFogR.y-uFogR.x),0.0,1.0); o=vec4(mix(col,uFog,f), uA<1.0?uA*c.a+0.25*(1.0-c.a)*0.0:1.0); if(uA<1.0 && c.a<0.05) discard; }`);
const PL = prog(`#version 300 es
in vec3 aP; uniform mat4 uVP; void main(){ gl_Position=uVP*vec4(aP,1.0); }`, `#version 300 es
precision mediump float; out vec4 o; void main(){ o=vec4(0.0,0.0,0.0,1.0); }`);
const U = {}; for (const n of ['uVP', 'uCam', 'uT', 'uL', 'uFog', 'uFogR', 'uA']) U[n] = gl.getUniformLocation(P, n);
const ULVP = gl.getUniformLocation(PL, 'uVP');
const tex = gl.createTexture();
function loadAtlas() { return new Promise((res, rej) => { const im = new Image(); im.onload = () => { gl.bindTexture(gl.TEXTURE_2D, tex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, im);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); res(); }; im.onerror = () => rej(new Error('atlas.png не загрузился')); im.src = 'atlas.png'; }); }

// ---------- геометрия блоков особых форм (порт из VoxelMeshGenerator.cs) ----------
const DOORB = [[0,0,0,1,1,.1875],[0,0,0,.1875,1,1],[0,0,.8125,1,1,1],[.8125,0,0,1,1,1],[.8125,0,0,1,1,1],[0,0,0,1,1,.1875],[0,0,0,.1875,1,1],[0,0,.8125,1,1,1]];
const isShape = (v, sh) => v > 0 && DEF[v & 511] && DEF[v & 511].shape === sh;
const solidCube = v => v > 0 && DEF[v & 511] && DEF[v & 511].shape === 'Cube' && DEF[v & 511].solid;
// raw(x,y,z) -> id блока (координаты внутри мира); coll=true — коллизионные коробки
function boxesFor(raw, x, y, z, id, coll) {
  const base = id & 511, d = DEF[base], st = id >> 9, out = [];
  const add = (x0, y0, z0, x1, y1, z1, tile) => out.push([x0, y0, z0, x1, y1, z1, tile >= 0 ? tile : d.top, tile >= 0 ? tile : d.side, tile >= 0 ? tile : d.bot]);
  const R = (a, b, c) => { const v = raw(a, b, c); return v < 0 ? 0 : v; };
  switch (d.shape) {
    case 'Torch': { if (coll) break; let ox = 0, oy = 0, oz = 0;
      if (!solidCube(R(x, y - 1, z))) { if (solidCube(R(x - 1, y, z))) { ox = -.35; oy = .15; } else if (solidCube(R(x + 1, y, z))) { ox = .35; oy = .15; } else if (solidCube(R(x, y, z - 1))) { oz = -.35; oy = .15; } else if (solidCube(R(x, y, z + 1))) { oz = .35; oy = .15; } }
      add(.4375 + ox, oy, .4375 + oz, .5625 + ox, .625 + oy, .5625 + oz); break; }
    case 'Ladder': { if (coll) break;
      if (solidCube(R(x - 1, y, z))) add(0, 0, 0, .1, 1, 1); else if (solidCube(R(x + 1, y, z))) add(.9, 0, 0, 1, 1, 1); else if (solidCube(R(x, y, z + 1))) add(0, 0, .9, 1, 1, 1); else add(0, 0, 0, 1, 1, .1); break; }
    case 'Rail': { if (coll) break; const ax = isShape(R(x - 1, y, z), 'Rail') || isShape(R(x + 1, y, z), 'Rail'), az = isShape(R(x, y, z - 1), 'Rail') || isShape(R(x, y, z + 1), 'Rail');
      add(0, 0, 0, 1, .0625, 1, ax && !az ? d.side : d.top); break; }
    case 'Door': { const up = st & 1, open = st & 2, f = (st >> 2) & 3, bb = DOORB[open ? f + 4 : f]; add(bb[0], bb[1], bb[2], bb[3], bb[4], bb[5], up ? d.top : d.side); break; }
    case 'Trapdoor': { const top = st & 1, open = st & 2, f = (st >> 2) & 3;
      if (open) { const bb = DOORB[f]; add(bb[0], bb[1], bb[2], bb[3], bb[4], bb[5], d.side); } else if (top) add(0, .8125, 0, 1, 1, 1, d.side); else add(0, 0, 0, 1, .1875, 1, d.side); break; }
    case 'Gate': { const open = st & 2, alongX = (((st >> 2) & 3) & 1) === 0, hh = coll ? 1.5 : 1;
      if (alongX) { add(0, .3125, .4375, .125, hh, .5625, d.side); add(.875, .3125, .4375, 1, hh, .5625, d.side);
        if (!open) { if (coll) add(.125, 0, .4375, .875, 1.5, .5625, d.side); else { add(.125, .375, .4375, .875, .5625, .5625, d.side); add(.125, .75, .4375, .875, .9375, .5625, d.side); } } }
      else { add(.4375, .3125, 0, .5625, hh, .125, d.side); add(.4375, .3125, .875, .5625, hh, 1, d.side);
        if (!open) { if (coll) add(.4375, 0, .125, .5625, 1.5, .875, d.side); else { add(.4375, .375, .125, .5625, .5625, .875, d.side); add(.4375, .75, .125, .5625, .9375, .875, d.side); } } }
      break; }
    case 'Wall': { add(.25, 0, .25, .75, coll ? 1.5 : 1, .75);
      for (let k = 0; k < 4; k++) { const dx = k === 0 ? 1 : k === 1 ? -1 : 0, dz = k === 2 ? 1 : k === 3 ? -1 : 0, nb = R(x + dx, y, z + dz);
        if (!(isShape(nb, 'Wall') || isShape(nb, 'Fence') || isShape(nb, 'Gate') || solidCube(nb))) continue;
        const a0 = dx > 0 ? .75 : dx < 0 ? 0 : .3125, a1 = dx > 0 ? 1 : dx < 0 ? .25 : .6875, b0 = dz > 0 ? .75 : dz < 0 ? 0 : .3125, b1 = dz > 0 ? 1 : dz < 0 ? .25 : .6875;
        add(a0, 0, b0, a1, coll ? 1.5 : .875, b1); } break; }
    case 'Slab': add(0, 0, 0, 1, .5, 1); break;
    case 'Stair': add(0, 0, 0, 1, .5, 1);
      switch (d.facing) { case 0: add(0, .5, .5, 1, 1, 1); break; case 1: add(.5, .5, 0, 1, 1, 1); break; case 2: add(0, .5, 0, 1, 1, .5); break; default: add(0, .5, 0, .5, 1, 1); } break;
    case 'Fence': { const hh = coll ? 1.5 : 1; add(.375, 0, .375, .625, hh, .625);
      for (let k = 0; k < 4; k++) { const dx = k === 0 ? 1 : k === 1 ? -1 : 0, dz = k === 2 ? 1 : k === 3 ? -1 : 0, nb = R(x + dx, y, z + dz);
        if (!(isShape(nb, 'Fence') || isShape(nb, 'Wall') || isShape(nb, 'Gate') || solidCube(nb))) continue;
        const a0 = dx > 0 ? .625 : dx < 0 ? 0 : .4375, a1 = dx > 0 ? 1 : dx < 0 ? .375 : .5625, b0 = dz > 0 ? .625 : dz < 0 ? 0 : .4375, b1 = dz > 0 ? 1 : dz < 0 ? .375 : .5625;
        if (coll) add(a0, 0, b0, a1, 1.5, b1); else { add(a0, .375, b0, a1, .5625, b1); add(a0, .75, b0, a1, .9375, b1); } } break; }
    case 'Pane': { add(.4375, 0, .4375, .5625, 1, .5625);
      for (let k = 0; k < 4; k++) { const dx = k === 0 ? 1 : k === 1 ? -1 : 0, dz = k === 2 ? 1 : k === 3 ? -1 : 0, nb = R(x + dx, y, z + dz);
        if (!(isShape(nb, 'Pane') || solidCube(nb))) continue;
        const a0 = dx > 0 ? .5625 : dx < 0 ? 0 : .4375, a1 = dx > 0 ? 1 : dx < 0 ? .4375 : .5625, b0 = dz > 0 ? .5625 : dz < 0 ? 0 : .4375, b1 = dz > 0 ? 1 : dz < 0 ? .4375 : .5625;
        add(a0, 0, b0, a1, 1, b1); } break; }
    default: add(0, 0, 0, 1, 1, 1);
  }
  return out;
}

// ---------- меши ----------
const FACES = [
  { n: [0, 1, 0], s: 1.0, v: [[0,1,1],[1,1,1],[1,1,0],[0,1,0]], t: 'top' },
  { n: [0, -1, 0], s: 0.5, v: [[0,0,0],[1,0,0],[1,0,1],[0,0,1]], t: 'bot' },
  { n: [1, 0, 0], s: 0.8, v: [[1,0,1],[1,0,0],[1,1,0],[1,1,1]], t: 'side' },
  { n: [-1, 0, 0], s: 0.8, v: [[0,0,0],[0,0,1],[0,1,1],[0,1,0]], t: 'side' },
  { n: [0, 0, 1], s: 0.65, v: [[0,0,1],[1,0,1],[1,1,1],[0,1,1]], t: 'side' },
  { n: [0, 0, -1], s: 0.65, v: [[1,0,0],[0,0,0],[0,1,0],[1,1,0]], t: 'side' }];
const UVC = [[0, 1], [1, 1], [1, 0], [0, 0]];
function neighbor(c, x, y, z) { if (y < 0) return B.Bedrock; if (y >= SY) return AIR; if (x >= 0 && x < SX && z >= 0 && z < SZ) return c.data[idx(x, y, z)];
  const n = chunks.get(key(c.cx + (x >> 4), c.cz + (z >> 4))); return n ? n.data[idx(x & 15, y, z & 15)] : -1; }
function buildMesh(c) {
  const op = [], tr = [], d = c.data, bx = c.cx * SX, bz = c.cz * SZ, E = 0.0004, ts = 1 / TILES;
  const raw = (x, y, z) => neighbor(c, x, y, z);
  for (let y = 0; y <= Math.min(c.maxY + 1, SY - 1); y++) for (let z = 0; z < SZ; z++) for (let x = 0; x < SX; x++) {
    const id = d[idx(x, y, z)]; if (!id) continue; const base = id & 511, def = DEF[base]; if (!def) continue;
    if (def.shape === 'Cube') { const arr = (base === WATER) ? tr : op;
      for (let f = 0; f < 6; f++) { const F = FACES[f], nb = neighbor(c, x + F.n[0], y + F.n[1], z + F.n[2]);
        if (nb === -1) continue; const nbb = nb & 511;
        if (nb !== 0 && (OPAQUE[nbb] || (TRANSP[nbb] && nbb === base && DEF[nbb].shape === 'Cube'))) continue;
        const t = F.t === 'top' ? TOP[base] : F.t === 'bot' ? BOT[base] : SIDE[base], u0 = (t % TILES) * ts, v0 = ((t / TILES) | 0) * ts;
        const yo = (base === WATER && f === 0) ? -0.1 : 0;
        for (const q of [0, 1, 2, 0, 2, 3]) { const v = F.v[q], uv = UVC[q];
          arr.push(bx + x + v[0], y + v[1] + (v[1] ? yo : 0), bz + z + v[2], u0 + (uv[0] ? ts - E : E), v0 + (uv[1] ? ts - E : E), F.s); } }
    } else {
      for (const bb of boxesFor(raw, bx + x, y, bz + z, id, false)) {
        const [x0, y0, z0, x1, y1, z1] = bb;
        for (let f = 0; f < 6; f++) { const F = FACES[f];
          const onB = f === 0 ? y1 >= 1 : f === 1 ? y0 <= 0 : f === 2 ? x1 >= 1 : f === 3 ? x0 <= 0 : f === 4 ? z1 >= 1 : z0 <= 0;
          if (onB) { const nb = neighbor(c, x + F.n[0], y + F.n[1], z + F.n[2]); if (nb === -1 || (nb > 0 && OPAQUE[nb & 511])) continue; }
          const t = F.t === 'top' ? bb[6] : F.t === 'bot' ? bb[8] : bb[7], u0 = (t % TILES) * ts, v0 = ((t / TILES) | 0) * ts;
          for (const q of [0, 1, 2, 0, 2, 3]) { const v = F.v[q], px = x0 + v[0] * (x1 - x0), py = y0 + v[1] * (y1 - y0), pz = z0 + v[2] * (z1 - z0);
            let u, w; if (f < 2) { u = px; w = pz; } else if (f === 2) { u = 1 - pz; w = 1 - py; } else if (f === 3) { u = pz; w = 1 - py; } else if (f === 4) { u = px; w = 1 - py; } else { u = 1 - px; w = 1 - py; }
            op.push(bx + x + px, y + py, bz + z + pz, u0 + E + u * (ts - 2 * E), v0 + E + w * (ts - 2 * E), F.s); } }
      }
    }
  }
  const up = (old, a) => { if (old) { gl.deleteBuffer(old.buf); gl.deleteVertexArray(old.vao); } if (!a.length) return null; const vao = gl.createVertexArray(), buf = gl.createBuffer(); gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(a), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 24, 12); gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 24, 20); gl.bindVertexArray(null); return { vao, buf, n: a.length / 6 }; };
  const m = c.mesh || {}; c.mesh = { op: up(m.op, op), tr: up(m.tr, tr) }; c.dirty = false;
}
function freeChunk(c) { if (c.mesh) for (const k of ['op', 'tr']) { const m = c.mesh[k]; if (m) { gl.deleteBuffer(m.buf); gl.deleteVertexArray(m.vao); } } }

// ---------- матрицы ----------
function persp(f, a, n, fa) { const t = 1 / Math.tan(f / 2), r = 1 / (n - fa); return [t / a, 0, 0, 0, 0, t, 0, 0, 0, 0, (fa + n) * r, -1, 0, 0, 2 * fa * n * r, 0]; }
function mul(a, b) { const o = new Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; }
function viewM(px, py, pz, yaw, pitch) { const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  const r = [cy, 0, -sy], u = [sp * sy, cp, sp * cy], f = [sy * cp, -sp, cy * cp]; // f = назад; камера смотрит в -f
  return [r[0], u[0], f[0], 0, r[1], u[1], f[1], 0, r[2], u[2], f[2], 0, -(r[0] * px + r[1] * py + r[2] * pz), -(u[0] * px + u[1] * py + u[2] * pz), -(f[0] * px + f[1] * py + f[2] * pz), 1]; }
const lineBuf = gl.createBuffer(), lineVao = gl.createVertexArray();
(function () { const v = []; const e = [[0,0,0,1,0,0],[1,0,0,1,0,1],[1,0,1,0,0,1],[0,0,1,0,0,0],[0,1,0,1,1,0],[1,1,0,1,1,1],[1,1,1,0,1,1],[0,1,1,0,1,0],[0,0,0,0,1,0],[1,0,0,1,1,0],[1,0,1,1,1,1],[0,0,1,0,1,1]]; for (const s of e) v.push(...s);
  gl.bindVertexArray(lineVao); gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STATIC_DRAW); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0); gl.bindVertexArray(null); })();

// ---------- игрок ----------
const pl = { x: 8.5, y: 100, z: 8.5, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, ground: false, fly: false, inWater: false, onLadder: false };
const HW = 0.3, HH = 1.8, EYE = 1.62;
const rawW = (x, y, z) => getBlock(x, y, z);
function collides(x, y, z) {
  for (let by = Math.floor(y); by <= Math.floor(y + HH - 0.001); by++) for (let bz = Math.floor(z - HW); bz <= Math.floor(z + HW); bz++) for (let bx = Math.floor(x - HW); bx <= Math.floor(x + HW); bx++) {
    const b = getBlock(bx, by, bz); if (b === -1) return true; if (b <= 0) continue; const base = b & 511; if (!SOLID[base]) continue;
    if (DEF[base].shape === 'Cube') return true;
    for (const q of boxesFor(rawW, bx, by, bz, b, true)) if (x + HW > bx + q[0] && x - HW < bx + q[3] && y + HH > by + q[1] && y < by + q[4] && z + HW > bz + q[2] && z - HW < bz + q[5]) return true; }
  return false; }
function stepPlayer(dt, mv, jump) {
  const sp = pl.fly ? 10 : (pl.inWater ? 2.6 : 4.4), s = Math.sin(pl.yaw), c = Math.cos(pl.yaw);
  const wx = mv.x * c - mv.y * s, wz = -mv.x * s - mv.y * c;
  pl.vx = wx * sp; pl.vz = wz * sp;
  const px0 = Math.floor(pl.x), pz0 = Math.floor(pl.z);
  pl.inWater = (getBlock(px0, Math.floor(pl.y + 0.5), pz0) & 511) === WATER;
  pl.onLadder = isShape(getBlock(px0, Math.floor(pl.y + 0.2), pz0), 'Ladder') || isShape(getBlock(px0, Math.floor(pl.y + 1.2), pz0), 'Ladder');
  if (pl.fly) { pl.vy = jump ? 7 : (mv.sneak ? -7 : 0); }
  else if (pl.onLadder) { pl.vy = (jump || mv.y > 0.2) ? 3 : (mv.sneak ? -3 : -1.2); }
  else if (pl.inWater) { pl.vy = Math.max(pl.vy - 12 * dt, -3); if (jump) pl.vy = 3.2; }
  else { pl.vy -= 28 * dt; if (pl.vy < -50) pl.vy = -50; if (jump && pl.ground) { pl.vy = 8.6; pl.ground = false; } }
  const mvAxis = (ax, dd) => { const n = ax === 0 ? pl.x + pl.vx * dd : ax === 1 ? pl.y + pl.vy * dd : pl.z + pl.vz * dd;
    const px = ax === 0 ? n : pl.x, py = ax === 1 ? n : pl.y, pz = ax === 2 ? n : pl.z;
    if (!collides(px, py, pz)) { if (ax === 0) pl.x = n; else if (ax === 1) { pl.y = n; pl.ground = false; } else pl.z = n; return true; }
    if (ax === 1) { if (pl.vy < 0) pl.ground = true; pl.vy = 0; } return false; };
  const sub = Math.ceil(Math.max(Math.abs(pl.vy) * dt, 0.001) / 0.4), sdt = dt / sub;
  for (let i = 0; i < sub; i++) {
    for (const ax of [0, 2]) { if (!mvAxis(ax, sdt) && pl.ground) { // авто-подъём на ступеньку/плиту/блок
      const nx = ax === 0 ? pl.x + pl.vx * sdt : pl.x, nz = ax === 2 ? pl.z + pl.vz * sdt : pl.z;
      for (const h of [0.55, 1.02]) { if (!collides(nx, pl.y + h, nz) && !collides(pl.x, pl.y + h, pl.z)) { pl.y += h; pl.x = nx; pl.z = nz; break; } } } }
    mvAxis(1, sdt); }
  if (pl.y < -20) { pl.y = 100; pl.vy = 0; }
}

// ---------- луч ----------
function raycast(ox, oy, oz, dx, dy, dz, maxD) {
  let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz); const sx = Math.sign(dx), sy = Math.sign(dy), sz = Math.sign(dz);
  const tdx = dx ? Math.abs(1 / dx) : 1e30, tdy = dy ? Math.abs(1 / dy) : 1e30, tdz = dz ? Math.abs(1 / dz) : 1e30;
  let tx = dx ? ((sx > 0 ? x + 1 - ox : ox - x) * tdx) : 1e30, ty = dy ? ((sy > 0 ? y + 1 - oy : oy - y) * tdy) : 1e30, tz = dz ? ((sz > 0 ? z + 1 - oz : oz - z) * tdz) : 1e30; let face = [0, 0, 0], t = 0;
  while (t <= maxD) { const b = getBlock(x, y, z); if (b > 0 && (b & 511) !== WATER) return { x, y, z, face, b, t, hy: oy + dy * t };
    if (tx < ty && tx < tz) { x += sx; t = tx; tx += tdx; face = [-sx, 0, 0]; } else if (ty < tz) { y += sy; t = ty; ty += tdy; face = [0, -sy, 0]; } else { z += sz; t = tz; tz += tdz; face = [0, 0, -sz]; } }
  return null; }

// ---------- инвентарь ----------
let mode = 'survival'; // 'survival' | 'creative'
let inv = new Array(36).fill(null), sel = 0;
const containers = { chests: {}, furnaces: {} };
const pkey = (x, y, z) => x + ',' + y + ',' + z;
function newStack(id, count) { const it = ITEMS[id]; return { id, count, dur: it && it.dur ? it.dur : 0 }; }
function invAdd(id, count, dur) { // возвращает остаток, не поместившийся в инвентарь
  const mx = maxStack(id);
  for (let i = 0; i < 36 && count > 0; i++) { const s = inv[i]; if (s && s.id === id && mx > 1 && s.count < mx) { const t = Math.min(mx - s.count, count); s.count += t; count -= t; } }
  for (let i = 0; i < 36 && count > 0; i++) if (!inv[i]) { const t = Math.min(mx, count); inv[i] = { id, count: t, dur: dur !== undefined ? dur : (ITEMS[id] && ITEMS[id].dur) || 0 }; count -= t; }
  saveDirty = true; buildHotbar(); return count; }
function heldStack() { return inv[sel]; }
function consumeHeld() { const s = inv[sel]; if (!s || mode === 'creative') return; if (--s.count <= 0) inv[sel] = null; buildHotbar(); saveDirty = true; }
function recipeFind(grid, gw) {
  let minx = gw, miny = gw, maxx = -1, maxy = -1;
  for (let y = 0; y < gw; y++) for (let x = 0; x < gw; x++) if (grid[y * gw + x]) { minx = Math.min(minx, x); miny = Math.min(miny, y); maxx = Math.max(maxx, x); maxy = Math.max(maxy, y); }
  if (maxx < 0) return null; const w = maxx - minx + 1, h = maxy - miny + 1;
  for (const r of RECIPES) { if (r.W !== w || r.H !== h) continue;
    for (const mirror of [false, true]) { let ok = true;
      for (let y = 0; y < h && ok; y++) for (let x = 0; x < w; x++) { const want = r.cells[y * w + (mirror ? w - 1 - x : x)], g = grid[(miny + y) * gw + minx + x]; if (want !== (g ? g.id : 0)) { ok = false; break; } }
      if (ok) return r; } }
  return null; }
const RECIPES = GD.recipes.map(r => { const W = Math.max(...r.p.map(x => x.length)), cells = new Array(W * r.p.length).fill(0);
  r.p.forEach((row, y) => { for (let x = 0; x < W; x++) { const ch = x < row.length ? row[x] : ' '; if (ch !== ' ') cells[y * W + x] = r.k[ch] || 0; } }); return { W, H: r.p.length, cells, result: r.r, count: r.n }; });

// ---------- печи ----------
function furnaceGet(k) { return containers.furnaces[k] || (containers.furnaces[k] = { slots: [null, null, null], burnLeft: 0, burnMax: 0, cook: 0 }); }
function furnaceTick(f, dt) {
  const sm = GD.smelt, fu = GD.fuel; const s0 = f.slots[0], s1 = f.slots[1], s2 = f.slots[2]; const res = s0 ? sm[s0.id] : 0;
  const can = !!s0 && !!res && (!s2 || (s2.id === res && s2.count < maxStack(res)));
  if (f.burnLeft <= 0 && can && s1) { const t = fu[s1.id] || 0; if (t > 0) { f.burnMax = f.burnLeft = t; if (--s1.count <= 0) f.slots[1] = null; } }
  if (f.burnLeft > 0) { f.burnLeft = Math.max(0, f.burnLeft - dt);
    if (can) { f.cook += dt; if (f.cook >= 10) { f.cook = 0; if (--f.slots[0].count <= 0) f.slots[0] = null; if (!f.slots[2]) f.slots[2] = newStack(res, 1); else f.slots[2].count++; saveDirty = true; } } else f.cook = 0; }
  else f.cook = Math.max(0, f.cook - dt * 2);
}

// ---------- сохранение (IndexedDB) ----------
let db = null, saveDirty = false;
function dbOpen() { return new Promise(res => { try { const r = indexedDB.open('voxelworld', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => { db = r.result; res(); }; r.onerror = () => res(); } catch (e) { res(); } }); }
function dbGet(k) { return new Promise(res => { if (!db) return res(null); try { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); } catch (e) { res(null); } }); }
function dbSet(k, v) { return new Promise(res => { if (!db) return res(); try { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = res; } catch (e) { res(); } }); }
function dbDel(k) { return new Promise(res => { if (!db) return res(); try { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').delete(k); t.oncomplete = res; t.onerror = res; } catch (e) { res(); } }); }
const allEdits = {};
let playing = false, dayT = 0.1, RD = isMobile ? 3 : 5;
function saveWorld() { if (!playing) return Promise.resolve(); for (const [k, c] of chunks) if (Object.keys(c.edits).length) allEdits[k] = c.edits;
  const snapshot = { v: 2, seed: SEED, mode, pl: { x: pl.x, y: pl.y, z: pl.z, yaw: pl.yaw, pitch: pl.pitch, fly: pl.fly }, inv, sel, time: dayT, edits: allEdits, containers };
  return dbSet('world', snapshot).then(() => { if (multiplayer) multiplayer.send({ type: 'save', world: snapshot }); saveDirty = false; }); }

// ---------- состояние ----------
const input = { mx: 0, my: 0, jump: false, brk: false, sneak: false, keys: {} };
let target = null, breakT = 0, breakKey = '';
function msg(t) { const m = $('msg'); m.textContent = t; m.style.opacity = 1; clearTimeout(msg.t); msg.t = setTimeout(() => m.style.opacity = 0, 1800); }
function setIcon(el, id) { const t = iconTile(id); el.style.backgroundImage = 'url(atlas.png)'; el.style.backgroundSize = (TILES * 100) + '% ' + (TILES * 100) + '%';
  el.style.backgroundPosition = ((t % TILES) * 100 / (TILES - 1)) + '% ' + (((t / TILES) | 0) * 100 / (TILES - 1)) + '%'; }
function slotEl(stack, cls) { const el = document.createElement('div'); el.className = 'slot' + (cls ? ' ' + cls : ''); if (stack) { const ic = document.createElement('div'); ic.className = 'ic'; setIcon(ic, stack.id); el.appendChild(ic); el.title = itemName(stack.id);
    if (stack.count > 1) { const c = document.createElement('span'); c.className = 'cnt'; c.textContent = stack.count; el.appendChild(c); }
    const it = ITEMS[stack.id]; if (it && it.dur && stack.dur < it.dur) { const b = document.createElement('div'); b.className = 'dur'; const i = document.createElement('i'); i.style.width = (100 * stack.dur / it.dur) + '%'; b.appendChild(i); el.appendChild(b); } }
  return el; }
function buildHotbar() { const bar = $('bar'); bar.innerHTML = ''; for (let i = 0; i < 9; i++) { const s = slotEl(inv[i], i === sel ? 'sel' : ''); s.addEventListener('pointerdown', e => { e.stopPropagation(); sel = i; buildHotbar(); if (inv[i]) msg(itemName(inv[i].id)); }); bar.appendChild(s); } }

// ---------- окна: инвентарь / верстак / сундук / печь / палитра ----------
const ui = { type: null, key: '', craft: [], gw: 2, held: null, split: false, tab: 'blocks' };
function openUI(type, key) {
  if (document.pointerLockElement) document.exitPointerLock();
  ui.type = type; ui.key = key || ''; ui.held = null; ui.craft = new Array(type === 'table' ? 9 : 4).fill(null); ui.gw = type === 'table' ? 3 : 2;
  $('inv').style.display = 'flex'; renderPanel(); }
function closeUI() { if (!ui.type) return; // вернуть предметы из сетки крафта и из руки
  for (const s of ui.craft) if (s) invAdd(s.id, s.count, s.dur); ui.craft = []; if (ui.held) { invAdd(ui.held.id, ui.held.count, ui.held.dur); ui.held = null; }
  ui.type = null; $('inv').style.display = 'none'; buildHotbar(); saveDirty = true; }
function clickSlot(arr, i, takeOnly) {
  const s = arr[i], h = ui.held;
  if (!h) { if (s) { if (ui.split && s.count > 1) { const t = Math.ceil(s.count / 2); ui.held = { ...s, count: t }; s.count -= t; } else { ui.held = s; arr[i] = null; } } }
  else if (takeOnly) { if (s && s.id === h.id && h.count + s.count <= maxStack(h.id)) { h.count += s.count; arr[i] = null; } }
  else if (!s) { if (ui.split && h.count > 1) { arr[i] = { ...h, count: 1 }; h.count--; } else { arr[i] = h; ui.held = null; } }
  else if (s.id === h.id && maxStack(h.id) > 1) { const room = maxStack(h.id) - s.count, mv = ui.split ? Math.min(1, h.count, room) : Math.min(h.count, room); s.count += mv; h.count -= mv; if (h.count <= 0) ui.held = null; }
  else { arr[i] = h; ui.held = s; }
  saveDirty = true; renderPanel(); }
function renderPanel() {
  const body = $('pbody'); body.innerHTML = ''; const t = ui.type; if (!t) return;
  $('ptitle').textContent = { inv: 'Инвентарь', table: 'Верстак', chest: 'Сундук', furnace: 'Печь', palette: 'Творчество: выберите предмет' }[t];
  $('split').style.display = t === 'palette' ? 'none' : 'inline-block'; $('split').classList.toggle('on', ui.split); $('split').textContent = ui.split ? 'Делить: ВКЛ' : 'Делить';
  const hd = $('held'); hd.innerHTML = ''; if (ui.held) { const e = slotEl(ui.held); hd.appendChild(e); }
  if (t === 'palette') { const tabs = document.createElement('div'); tabs.className = 'row'; for (const [k, n] of [['blocks', 'Блоки'], ['items', 'Предметы']]) { const b = document.createElement('button'); b.className = 'btn tab' + (ui.tab === k ? ' on' : ''); b.textContent = n; b.onclick = () => { ui.tab = k; renderPanel(); }; tabs.appendChild(b); } body.appendChild(tabs);
    const g = document.createElement('div'); g.className = 'grid pal'; for (const id of (ui.tab === 'blocks' ? PICK_BLOCKS : PICK_ITEMS)) { const e = slotEl({ id, count: 1 }); e.onclick = () => { inv[sel] = newStack(id, maxStack(id) > 1 ? 64 : 1); buildHotbar(); msg(itemName(id)); saveDirty = true; closeUI(); }; g.appendChild(e); } body.appendChild(g); return; }
  const left = document.createElement('div'); left.className = 'pcol'; const right = document.createElement('div'); right.className = 'pcol';
  const grid = (arr, from, to, cb) => { const g = document.createElement('div'); g.className = 'grid'; for (let i = from; i < to; i++) { const e = slotEl(arr[i]); e.onclick = () => cb(i); g.appendChild(e); } return g; };
  if (t === 'inv' || t === 'table') { const gw = ui.gw, wrap = document.createElement('div'); wrap.className = 'crow';
    const cg = document.createElement('div'); cg.className = 'grid'; cg.style.gridTemplateColumns = `repeat(${gw},var(--ss))`; ui.craft.forEach((s, i) => { const e = slotEl(s); e.onclick = () => clickSlot(ui.craft, i); cg.appendChild(e); }); wrap.appendChild(cg);
    const ar = document.createElement('div'); ar.className = 'arrow'; ar.textContent = '➜'; wrap.appendChild(ar);
    const rec = recipeFind(ui.craft, gw), out = rec ? newStack(rec.result, rec.count) : null; const oe = slotEl(out, 'out'); oe.onclick = () => { if (!rec) return; const h = ui.held; if (h && (h.id !== out.id || h.count + out.count > maxStack(h.id))) return;
      if (h) h.count += out.count; else ui.held = out; for (let i = 0; i < ui.craft.length; i++) { const s = ui.craft[i]; if (s && --s.count <= 0) ui.craft[i] = null; } saveDirty = true; renderPanel(); }; wrap.appendChild(oe); left.appendChild(wrap); }
  else if (t === 'chest') { const arr = containers.chests[ui.key] || (containers.chests[ui.key] = new Array(27).fill(null)); left.appendChild(grid(arr, 0, 27, i => clickSlot(arr, i))); }
  else if (t === 'furnace') { const f = furnaceGet(ui.key), wrap = document.createElement('div'); wrap.className = 'crow';
    const col = document.createElement('div'); col.className = 'fcol'; const l1 = document.createElement('small'); l1.textContent = 'Сырьё'; const e0 = slotEl(f.slots[0]); e0.onclick = () => clickSlot(f.slots, 0); const l2 = document.createElement('small'); l2.textContent = 'Топливо'; const e1 = slotEl(f.slots[1]); e1.onclick = () => clickSlot(f.slots, 1); col.append(l1, e0, l2, e1); wrap.appendChild(col);
    const pr = document.createElement('div'); pr.className = 'prog'; pr.id = 'fprog'; pr.innerHTML = '<div class="fire"><i></i></div><div class="bar"><i></i></div>'; wrap.appendChild(pr);
    const col2 = document.createElement('div'); col2.className = 'fcol'; const l3 = document.createElement('small'); l3.textContent = 'Результат'; const e2 = slotEl(f.slots[2], 'out'); e2.onclick = () => clickSlot(f.slots, 2, true); col2.append(l3, e2); wrap.appendChild(col2); left.appendChild(wrap); }
  right.appendChild(grid(inv, 9, 36, i => clickSlot(inv, i))); const sep = document.createElement('div'); sep.style.height = '6px'; right.appendChild(sep); right.appendChild(grid(inv, 0, 9, i => clickSlot(inv, i)));
  body.append(left, right); updateFurnaceUI(); }
function updateFurnaceUI() { if (ui.type !== 'furnace') return; const f = containers.furnaces[ui.key], p = $('fprog'); if (!f || !p) return; p.querySelector('.fire i').style.height = (f.burnMax ? 100 * f.burnLeft / f.burnMax : 0) + '%'; p.querySelector('.bar i').style.width = (100 * f.cook / 10) + '%'; }
function toggleInv() { if (ui.type) closeUI(); else openUI(mode === 'creative' ? 'palette' : 'inv'); }

// ---------- действия ----------
const FUNC = { [B.CraftingTable]: 'table', [B.Chest]: 'chest', [B.LootChest]: 'chest', [B.Furnace]: 'furnace' };
function heldTool() { const s = inv[sel]; const it = s && ITEMS[s.id]; return it && it.tool ? { it, s } : null; }
function doPlace() {
  if (!target || ui.type) return; const tb = target.b, tbase = tb & 511, td = DEF[tbase];
  if (!input.sneak && !input.keys.ShiftLeft) {
    if (FUNC[tbase]) { openUI(FUNC[tbase], pkey(target.x, target.y, target.z)); return; }
    if (td.shape === 'Door' || td.shape === 'Trapdoor' || td.shape === 'Gate') { if (tbase === B.IronDoor || tbase === B.IronTrapdoor) return; const st = tb >> 9; setBlock(target.x, target.y, target.z, tbase | ((st ^ 2) << 9));
      if (td.shape === 'Door') { const oy = target.y + ((st & 1) ? -1 : 1), o = getBlock(target.x, oy, target.z); if (o > 0 && (o & 511) === tbase) setBlock(target.x, oy, target.z, tbase | (((o >> 9) ^ 2) << 9)); } return; } }
  const hs = inv[sel]; if (!hs || hs.id >= 1000) return; const id = hs.id, d = DEF[id & 511]; if (!d) return;
  const x = target.x + target.face[0], y = target.y + target.face[1], z = target.z + target.face[2];
  const cur = getBlock(x, y, z); if (cur === -1) return;
  // плита на плиту -> полный блок
  if (d.shape === 'Slab' && d.full && tbase === id && target.face[1] === 1) { setBlock(target.x, target.y, target.z, d.full); consumeHeld(); return; }
  if (cur > 0 && (cur & 511) !== WATER) return;
  if (SOLID[id & 511] && x + 1 > pl.x - HW && x < pl.x + HW && z + 1 > pl.z - HW && z < pl.z + HW && y + 1 > pl.y && y < pl.y + HH) return;
  const f = facingOf(-Math.sin(pl.yaw), -Math.cos(pl.yaw));
  if (d.shape === 'Stair') setBlock(x, y, z, id + f);
  else if (d.shape === 'Door') { if (getBlock(x, y + 1, z) > 0) return; setBlock(x, y, z, id | (f << 11)); setBlock(x, y + 1, z, id | ((1 | (f << 2)) << 9)); }
  else if (d.shape === 'Trapdoor') { const top = target.face[1] === -1 ? 1 : target.face[1] === 1 ? 0 : ((target.hy - Math.floor(target.hy)) > 0.5 ? 1 : 0); setBlock(x, y, z, id | ((top | (f << 2)) << 9)); }
  else if (d.shape === 'Gate') setBlock(x, y, z, id | (f << 11));
  else setBlock(x, y, z, id);
  consumeHeld(); }
function giveDrops(base, tb, bx, by, bz) {
  const d = DEF[base]; const k = pkey(bx, by, bz);
  if (containers.chests[k]) { for (const s of containers.chests[k]) if (s) invAdd(s.id, s.count, s.dur); delete containers.chests[k]; }
  if (containers.furnaces[k]) { for (const s of containers.furnaces[k].slots) if (s) invAdd(s.id, s.count, s.dur); delete containers.furnaces[k]; }
  if (mode === 'creative') return;
  let ok = true; if (d.tier >= 0 && d.tool) { const ht = heldTool(); ok = !!ht && ht.it.tool === d.tool && ht.it.tier >= d.tier; }
  if (d.shape === 'Door' && (tb >> 9) & 1) return;
  if (ok && d.drop) { const left = invAdd(d.drop, 1); if (left === 0) msg('+ ' + itemName(d.drop)); } }
function breakTarget() { const tb = target.b, base = tb & 511, d = DEF[base]; const bx = target.x, by = target.y, bz = target.z;
  giveDrops(base, tb, bx, by, bz);
  const ht = heldTool(); if (mode === 'survival' && ht && ht.it.tool !== 'sword' || (mode === 'survival' && ht)) { ht.s.dur--; if (ht.s.dur <= 0) { inv[sel] = null; msg('Инструмент сломался'); } buildHotbar(); }
  setBlock(bx, by, bz, AIR);
  if (d.shape === 'Door') { const oy = by + (((tb >> 9) & 1) ? -1 : 1), o = getBlock(bx, oy, bz); if (o > 0 && (o & 511) === base) setBlock(bx, oy, bz, AIR); } }
function updateBreak(dt) { if (!input.brk || !target || ui.type) { breakT = 0; breakKey = ''; return; } const k = target.x + ',' + target.y + ',' + target.z; if (k !== breakKey) { breakKey = k; breakT = 0; }
  const base = target.b & 511, d = DEF[base]; if (d.hard < 0 || base === B.Bedrock) return; breakT += dt;
  let need = 0.2; if (mode === 'survival') { const ht = heldTool(); const match = ht && d.tool && ht.it.tool === d.tool; const can = d.tier < 0 || !d.tool || (match && ht.it.tier >= d.tier);
    need = d.hard <= 0 ? 0.05 : d.hard * (can ? 1.5 : 5) / (match ? ht.it.speed : 1) + 0.05; }
  if (breakT >= need) { breakTarget(); breakT = 0; breakKey = ''; } }

// ---------- онлайн-мультиплеер ----------
const mpStore = { server: localStorage.getItem('vw_mp_server') || '', name: localStorage.getItem('vw_mp_name') || 'Игрок', ownerToken: localStorage.getItem('vw_mp_owner') || '', playerToken: localStorage.getItem('vw_mp_player') || '' };
if (!mpStore.ownerToken) { mpStore.ownerToken = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()); localStorage.setItem('vw_mp_owner', mpStore.ownerToken); }
if (!mpStore.playerToken) { mpStore.playerToken = (crypto.randomUUID ? crypto.randomUUID() : 'p' + String(Date.now()) + Math.random()); localStorage.setItem('vw_mp_player', mpStore.playerToken); }
function mpStatus(t) { const el = $('onlineStatus'); if (el) el.textContent = t; }
function mpSend(o) { if (multiplayer && multiplayer.ws && multiplayer.ws.readyState === 1) multiplayer.ws.send(JSON.stringify(o)); }
function mpDisconnect() { if (multiplayer && multiplayer.ws) { try { multiplayer.ws.close(); } catch (_) {} } multiplayer = null; remotePlayers.clear(); onlineRoom = ''; myPlayerId = ''; $('playersHud').textContent = ''; }
function mpConnect(action) {
  const url = $('mpServer').value.trim(), name = ($('mpName').value.trim() || 'Игрок').slice(0,20), room = $('mpRoom').value.trim().toUpperCase();
  if (!/^wss?:\/\//i.test(url)) { mpStatus('Укажи адрес WebSocket-сервера (ws:// или wss://).'); return; }
  if (action === 'join' && !room) { mpStatus('Введи код комнаты.'); return; }
  mpStore.server = url; mpStore.name = name; localStorage.setItem('vw_mp_server', url); localStorage.setItem('vw_mp_name', name);
  mpStatus('Подключение к серверу…');
  const ws = new WebSocket(url); multiplayer = { ws, send: o => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); } };
  ws.onopen = () => ws.send(JSON.stringify({ type: action, room, name, ownerToken: mpStore.ownerToken, playerToken: mpStore.playerToken, maxPlayers: 20 }));
  ws.onmessage = async ev => {
    let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
    if (m.type === 'error') { mpStatus(m.message || 'Ошибка подключения'); return; }
    if (m.type === 'joined') {
      onlineRoom = m.room; myPlayerId = m.id; $('mpRoom').value = m.room; mpStatus('Подключено: ' + m.room + ' · ' + m.players.length + '/20');
      remotePlayers = new Map((m.players || []).filter(p => p.id !== myPlayerId).map(p => [p.id, p]));
      if (m.world) { const clientWorld = m.world; if (m.profile) { if (m.profile.pl) clientWorld.pl = m.profile.pl; if (m.profile.inv) clientWorld.inv = m.profile.inv; if (Number.isInteger(m.profile.sel)) clientWorld.sel = m.profile.sel; } else if (!m.owner) { clientWorld.inv = new Array(36).fill(null); } await dbSet('world', clientWorld); for (const k in allEdits) delete allEdits[k]; Object.assign(allEdits, clientWorld.edits || {}); await startGame(false); if (!m.owner && !m.profile && mode === 'creative') { [B.Grass, B.Dirt, B.Stone, B.Cobblestone, B.Planks, B.OakLog, B.Sand, B.Glass, B.Torch].forEach((id, i) => inv[i] = newStack(id, 64)); buildHotbar(); } mpSend({ type:'profile', profile:{ pl:{x:pl.x,y:pl.y,z:pl.z,yaw:pl.yaw,pitch:pl.pitch,fly:pl.fly}, inv, sel, mode } }); if (m.owner) mpSend({ type: 'save', world: currentSnapshot() }); }
      else { await startGame(false); mpSend({ type: 'save', world: currentSnapshot() }); }
      updatePlayersHud();
    } else if (m.type === 'players') { remotePlayers = new Map((m.players || []).filter(p => p.id !== myPlayerId).map(p => [p.id, p])); updatePlayersHud(); }
    else if (m.type === 'player') { if (m.player && m.player.id !== myPlayerId) remotePlayers.set(m.player.id, m.player); updatePlayersHud(); }
    else if (m.type === 'left') { remotePlayers.delete(m.id); updatePlayersHud(); }
    else if (m.type === 'block') { const cx = Math.floor(m.x / 16), cz = Math.floor(m.z / 16), lx = ((m.x % 16) + 16) % 16, lz = ((m.z % 16) + 16) % 16, ck = cx + ',' + cz, ix = lx + 16 * (lz + 16 * m.y); if (!allEdits[ck]) allEdits[ck] = {}; allEdits[ck][ix] = m.id; applyingRemoteBlock = true; setBlock(m.x, m.y, m.z, m.id, true); applyingRemoteBlock = false; saveDirty = true; }
    else if (m.type === 'world') { if (m.world) { await dbSet('world', m.world); mpStatus('Мир загружен.'); } }
    else if (m.type === 'count') mpStatus('Комната ' + onlineRoom + ' · ' + m.count + '/20');
  };
  ws.onerror = () => mpStatus('Не удалось подключиться. Проверь адрес сервера.');
  ws.onclose = () => { if (multiplayer && multiplayer.ws === ws) { multiplayer = null; remotePlayers.clear(); onlineRoom = ''; updatePlayersHud(); mpStatus('Соединение закрыто. Локальная игра доступна.'); } };
}
function currentSnapshot() { const edits = {}; for (const [k,c] of chunks) if (Object.keys(c.edits).length) edits[k] = c.edits; Object.assign(edits, allEdits); return { v:2, seed:SEED, mode, pl:{x:pl.x,y:pl.y,z:pl.z,yaw:pl.yaw,pitch:pl.pitch,fly:pl.fly}, inv, sel, time:dayT, edits, containers }; }
function updatePlayersHud() { const el = $('playersHud'); if (!el) return; if (!multiplayer) { el.textContent=''; return; } el.textContent = 'Комната ' + onlineRoom + ' · ' + (remotePlayers.size + 1) + '/20\n' + [mpStore.name, ...Array.from(remotePlayers.values()).map(p=>p.name)].join('\n'); }
function mpTick(ts) { if (!multiplayer || !playing) return; const moved = !lastNetState || Math.hypot(pl.x-lastNetState.x, pl.y-lastNetState.y, pl.z-lastNetState.z) > 0.08 || Math.abs(pl.yaw-lastNetState.yaw) > 0.06 || Math.abs(pl.pitch-lastNetState.pitch) > 0.06; if (moved && ts-lastNetPos >= 1000) { lastNetPos = ts; lastNetState = {x:pl.x,y:pl.y,z:pl.z,yaw:pl.yaw,pitch:pl.pitch}; mpSend({ type:'move', player:{ name:mpStore.name, x:pl.x, y:pl.y, z:pl.z, yaw:pl.yaw, pitch:pl.pitch } }); } if (ts-lastProfileSave >= 60000) { lastProfileSave = ts; mpSend({ type:'profile', profile:{ pl:{x:pl.x,y:pl.y,z:pl.z,yaw:pl.yaw,pitch:pl.pitch,fly:pl.fly}, inv, sel, mode } }); } }

// Кубические аватары других игроков, рисуются тем же WebGL-атласом.
const remoteVao = gl.createVertexArray(), remoteBuf = gl.createBuffer();
gl.bindVertexArray(remoteVao); gl.bindBuffer(gl.ARRAY_BUFFER, remoteBuf); gl.bufferData(gl.ARRAY_BUFFER, 4, gl.DYNAMIC_DRAW);
gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,3,gl.FLOAT,false,24,0); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1,2,gl.FLOAT,false,24,12); gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2,1,gl.FLOAT,false,24,20); gl.bindVertexArray(null);
function addAvatarBox(a,x,y,z,w,h,d,tile) { const faces=[[[0,1,1],[1,1,1],[1,1,0],[0,1,0],1],[[0,0,0],[1,0,0],[1,0,1],[0,0,1],.5],[[1,0,1],[1,0,0],[1,1,0],[1,1,1],.8],[[0,0,0],[0,0,1],[0,1,1],[0,1,0],.8],[[0,0,1],[1,0,1],[1,1,1],[0,1,1],.65],[[1,0,0],[0,0,0],[0,1,0],[1,1,0],.65]]; const ts=1/TILES, u0=(tile%TILES)*ts, v0=((tile/TILES)|0)*ts, uv=[[0,1],[1,1],[1,0],[0,0]]; for(let f=0;f<6;f++){const q=[0,1,2,0,2,3];for(const j of q){const v=faces[f][j],t=uv[j];a.push(x+v[0]*w,y+v[1]*h,z+v[2]*d,u0+(t[0]?ts-.0004:.0004),v0+(t[1]?ts-.0004:.0004),faces[f][4]);}} }
function drawRemotePlayers(VP, ex, ey, ez, light) { if (!remotePlayers.size) return; const a=[], skin=TOP[B.Sand]||TOP[B.Dirt], shirt=TOP[B.Planks]||TOP[B.Grass], pants=TOP[B.Stone]||TOP[B.Dirt]; for(const p of remotePlayers.values()){ if(!Number.isFinite(p.x)||Math.hypot(p.x-ex,p.z-ez)>RD*16) continue; const x=p.x-.3,y=p.y,z=p.z-.3; addAvatarBox(a,x+.08,y+1.35,z+.08,.44,.44,.44,skin); addAvatarBox(a,x+.05,y+.72,z+.05,.5,.62,.3,shirt); addAvatarBox(a,x-.08,y+.74,z+.06,.14,.58,.14,shirt); addAvatarBox(a,x+.44,y+.74,z+.06,.14,.58,.14,shirt); addAvatarBox(a,x+.08,y,z+.06,.16,.72,.2,pants); addAvatarBox(a,x+.32,y,z+.06,.16,.72,.2,pants); } if(!a.length)return; gl.bindBuffer(gl.ARRAY_BUFFER,remoteBuf); gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(a),gl.DYNAMIC_DRAW); gl.useProgram(P); gl.uniformMatrix4fv(U.uVP,false,VP); gl.uniform3f(U.uCam,ex,ey,ez); gl.uniform1f(U.uL,light); gl.uniform1f(U.uA,1); gl.bindVertexArray(remoteVao); gl.drawArrays(gl.TRIANGLES,0,a.length/6); gl.bindVertexArray(null); }

// ---------- главный цикл ----------
let last = 0, fpsA = 0, fpsN = 0, fps = 0;
function resize() { const dpr = Math.min(window.devicePixelRatio || 1, isMobile ? 2 : 1.5); const w = Math.floor(canvas.clientWidth * dpr), h = Math.floor(canvas.clientHeight * dpr); if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; } $('rot').style.display = (isMobile && innerHeight > innerWidth) ? 'flex' : 'none'; }
function lerp(a, b, t) { return a + (b - a) * t; }
function frame(ts) { requestAnimationFrame(frame); const dt = Math.min(0.05, (ts - last) / 1000 || 0.016); last = ts; resize();
  fpsA += dt; fpsN++; if (fpsA > 0.5) { fps = Math.round(fpsN / fpsA); fpsA = 0; fpsN = 0; if (playing) $('info').textContent = fps + ' FPS  ' + Math.floor(pl.x) + ' ' + Math.floor(pl.y) + ' ' + Math.floor(pl.z) + (mode === 'creative' ? '  [творчество]' : ''); }
  if (!playing) { gl.clearColor(0.55, 0.75, 0.95, 1); gl.clear(gl.COLOR_BUFFER_BIT); return; }
  mpTick(ts);
  for (const k in containers.furnaces) furnaceTick(containers.furnaces[k], dt); if (ui.type === 'furnace') updateFurnaceUI();
  dayT = (dayT + dt / 600) % 1; const sun = Math.sin(dayT * Math.PI * 2), light = Math.min(1, Math.max(0.18, 0.55 + sun * 0.6)), k = Math.min(1, Math.max(0, 0.5 + sun * 1.2));
  const sky = [lerp(0.02, 0.55, k), lerp(0.03, 0.75, k), lerp(0.08, 0.95, k)];
  const blocked = !!ui.type;
  const kx = (input.keys.KeyD ? 1 : 0) - (input.keys.KeyA ? 1 : 0), ky = (input.keys.KeyW ? 1 : 0) - (input.keys.KeyS ? 1 : 0);
  const mv = blocked ? { x: 0, y: 0, sneak: false } : { x: input.mx + kx, y: input.my + ky, sneak: input.sneak || input.keys.ShiftLeft }; const ml = Math.hypot(mv.x, mv.y); if (ml > 1) { mv.x /= ml; mv.y /= ml; }
  const jump = !blocked && (input.jump || input.keys.Space); const cx = Math.floor(pl.x) >> 4, cz = Math.floor(pl.z) >> 4;
  if (getBlock(Math.floor(pl.x), Math.floor(pl.y), Math.floor(pl.z)) !== -1) stepPlayer(dt, mv, jump);
  const cp = Math.cos(pl.pitch), dx = -Math.sin(pl.yaw) * cp, dy = Math.sin(pl.pitch), dz = -Math.cos(pl.yaw) * cp; const ex = pl.x, ey = pl.y + EYE, ez = pl.z;
  target = raycast(ex, ey, ez, dx, dy, dz, 5.5); updateBreak(dt);
  streamChunks(cx, cz, 5);
  gl.viewport(0, 0, canvas.width, canvas.height); gl.clearColor(sky[0], sky[1], sky[2], 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); gl.enable(gl.DEPTH_TEST); gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK);
  const aspect = canvas.width / canvas.height, VP = mul(persp((isMobile ? 75 : 72) * Math.PI / 180, aspect, 0.1, 400), viewM(ex, ey, ez, pl.yaw, pl.pitch));
  gl.useProgram(P); gl.uniformMatrix4fv(U.uVP, false, VP); gl.uniform3f(U.uCam, ex, ey, ez); gl.uniform1i(U.uT, 0); gl.uniform1f(U.uL, light); gl.uniform3f(U.uFog, sky[0], sky[1], sky[2]); gl.uniform2f(U.uFogR, RD * 16 * 0.6, RD * 16 * 0.95);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
  const fx = dx, fz = dz; const vis = [];
  for (const c of chunks.values()) { if (!c.mesh) continue; const mx = c.cx * 16 + 8 - ex, mz = c.cz * 16 + 8 - ez, dist = Math.hypot(mx, mz); if (dist > 20 && (mx * fx + mz * fz) / dist < -0.45) continue; vis.push(c); }
  gl.uniform1f(U.uA, 1); gl.disable(gl.CULL_FACE); for (const c of vis) if (c.mesh.op) { gl.bindVertexArray(c.mesh.op.vao); gl.drawArrays(gl.TRIANGLES, 0, c.mesh.op.n); }
  gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false); gl.uniform1f(U.uA, 0.7);
  for (const c of vis) if (c.mesh.tr) { gl.bindVertexArray(c.mesh.tr.vao); gl.drawArrays(gl.TRIANGLES, 0, c.mesh.tr.n); }
  gl.depthMask(true); gl.disable(gl.BLEND);
  drawRemotePlayers(VP, ex, ey, ez, light);
  if (target && !ui.type) { gl.useProgram(PL); gl.uniformMatrix4fv(ULVP, false, mul(VP, [1.002, 0, 0, 0, 0, 1.002, 0, 0, 0, 0, 1.002, 0, target.x - 0.001, target.y - 0.001, target.z - 0.001, 1])); gl.bindVertexArray(lineVao); gl.drawArrays(gl.LINES, 0, 24); }
  gl.bindVertexArray(null);
}
let genQ = [], lastCenter = '';
function streamChunks(cx, cz, ms) {
  const t0 = performance.now();
  const ck = cx + ',' + cz; if (ck !== lastCenter) { lastCenter = ck; genQ = []; for (let r = 0; r <= RD + 1; r++) for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) if (Math.max(Math.abs(dx), Math.abs(dz)) === r) genQ.push([cx + dx, cz + dz]);
    for (const [k, c] of chunks) if (Math.max(Math.abs(c.cx - cx), Math.abs(c.cz - cz)) > RD + 3) { if (Object.keys(c.edits).length) allEdits[k] = c.edits; freeChunk(c); chunks.delete(k); } }
  while (genQ.length && performance.now() - t0 < ms) { const [x, z] = genQ[0]; if (chunks.has(key(x, z))) { genQ.shift(); continue; } const c = new Chunk(x, z); const e = allEdits[key(x, z)]; if (e) c.edits = e; genChunk(c); chunks.set(key(x, z), c); genQ.shift(); for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) mark(x + ax, z + az); }
  if (performance.now() - t0 >= ms) return;
  let best = null, bd = 1e9; for (const c of chunks.values()) if (c.dirty) { const d = Math.abs(c.cx - cx) + Math.abs(c.cz - cz); if (d < bd) { bd = d; best = c; } if (d === 0) break; }
  while (best && performance.now() - t0 < ms) { buildMesh(best); best = null; bd = 1e9; for (const c of chunks.values()) if (c.dirty) { const d = Math.abs(c.cx - cx) + Math.abs(c.cz - cz); if (d < bd) { bd = d; best = c; } } }
}

// ---------- ввод ----------
function bindInput() {
  let joyId = null, joyO = null, lookId = null, lx = 0, ly = 0; const joy = $('joy'), knob = $('knob'); const sens = 0.0055;
  const onBtn = (id, down, up) => { const e = $(id); e.addEventListener('pointerdown', ev => { ev.preventDefault(); ev.stopPropagation(); e.classList.add('on'); down(); }); const end = () => { e.classList.remove('on'); up && up(); }; e.addEventListener('pointerup', end); e.addEventListener('pointercancel', end); e.addEventListener('pointerleave', end); };
  onBtn('jb', () => input.jump = true, () => input.jump = false); onBtn('bb', () => input.brk = true, () => input.brk = false); onBtn('pb', () => doPlace());
  $('fb').addEventListener('pointerdown', e => { e.stopPropagation(); pl.fly = !pl.fly; pl.vy = 0; $('fb').classList.toggle('on', pl.fly); msg(pl.fly ? 'Полёт: вкл (ПРЫЖОК — вверх)' : 'Полёт: выкл'); });
  $('ib').addEventListener('pointerdown', e => { e.stopPropagation(); toggleInv(); }); $('mb').addEventListener('pointerdown', e => { e.stopPropagation(); showMenu(); });
  $('invx').addEventListener('click', closeUI); $('split').addEventListener('click', () => { ui.split = !ui.split; renderPanel(); });
  canvas.addEventListener('pointerdown', e => { if (!playing || ui.type) return;
    if (e.pointerType === 'mouse') { if (document.pointerLockElement !== canvas) { canvas.requestPointerLock && canvas.requestPointerLock(); return; } if (e.button === 0) input.brk = true; else if (e.button === 2) doPlace(); return; }
    canvas.setPointerCapture(e.pointerId);
    if (e.clientX < innerWidth * 0.45 && joyId === null) { joyId = e.pointerId; joyO = [e.clientX, e.clientY]; joy.style.display = 'block'; joy.style.left = e.clientX + 'px'; joy.style.top = e.clientY + 'px'; knob.style.transform = ''; }
    else if (lookId === null) { lookId = e.pointerId; lx = e.clientX; ly = e.clientY; } });
  canvas.addEventListener('pointermove', e => { if (e.pointerType === 'mouse') return;
    if (e.pointerId === joyId) { let dx = e.clientX - joyO[0], dy = e.clientY - joyO[1]; const m = Math.hypot(dx, dy), R = 50; if (m > R) { dx *= R / m; dy *= R / m; } knob.style.transform = `translate(${dx}px,${dy}px)`; input.mx = dx / R; input.my = -dy / R; if (Math.hypot(input.mx, input.my) < 0.15) { input.mx = 0; input.my = 0; } }
    else if (e.pointerId === lookId) { pl.yaw -= (e.clientX - lx) * sens; pl.pitch = Math.max(-1.5, Math.min(1.5, pl.pitch - (e.clientY - ly) * sens)); lx = e.clientX; ly = e.clientY; } });
  const up = e => { if (e.pointerType === 'mouse') { if (e.button === 0) input.brk = false; return; } if (e.pointerId === joyId) { joyId = null; joy.style.display = 'none'; input.mx = 0; input.my = 0; } if (e.pointerId === lookId) lookId = null; };
  canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
  document.addEventListener('mousemove', e => { if (document.pointerLockElement === canvas) { pl.yaw -= e.movementX * 0.0022; pl.pitch = Math.max(-1.5, Math.min(1.5, pl.pitch - e.movementY * 0.0022)); } });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('wheel', e => { sel = (sel + (e.deltaY > 0 ? 1 : 8)) % 9; buildHotbar(); }, { passive: true });
  let lastSpace = 0;
  addEventListener('keydown', e => { if (!playing) return; input.keys[e.code] = true;
    if (e.code === 'KeyE' || (e.code === 'Escape' && ui.type)) { toggleInv(); return; } if (ui.type) return;
    if (e.code === 'Space') { const t = performance.now(); if (mode === 'creative' && t - lastSpace < 300) { pl.fly = !pl.fly; pl.vy = 0; $('fb').classList.toggle('on', pl.fly); } lastSpace = t; e.preventDefault(); }
    if (e.code === 'KeyF' && mode === 'creative') { pl.fly = !pl.fly; pl.vy = 0; $('fb').classList.toggle('on', pl.fly); } if (/^Digit[1-9]$/.test(e.code)) { sel = +e.code[5] - 1; buildHotbar(); } });
  addEventListener('keyup', e => { input.keys[e.code] = false; });
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(g => document.addEventListener(g, e => e.preventDefault()));
  document.addEventListener('touchmove', e => { if (!e.target.closest('#pbody')) e.preventDefault(); }, { passive: false });
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveWorld(); }); addEventListener('pagehide', () => saveWorld());
  setInterval(() => { if (playing && saveDirty) saveWorld(); }, 15000);
  addEventListener('beforeunload', () => { if (multiplayer) { mpSend({ type:'profile', profile:{ pl:{x:pl.x,y:pl.y,z:pl.z,yaw:pl.yaw,pitch:pl.pitch,fly:pl.fly}, inv, sel, mode } }); if (mpStore.ownerToken) mpSend({ type:'save', world:currentSnapshot() }); } });
}

// ---------- старт ----------
async function startGame(fresh) {
  $('menu').style.display = 'none'; $('load').style.display = 'flex'; RD = +$('rd').value; localStorage.setItem('vw_rd', RD);
  let s = fresh ? null : await dbGet('world');
  inv = new Array(36).fill(null); sel = 0; containers.chests = {}; containers.furnaces = {};
  if (s) { SEED = s.seed; Object.assign(pl, s.pl); dayT = s.time || 0.1; mode = s.mode || 'creative'; sel = s.sel || 0; for (const k in s.edits) allEdits[k] = s.edits[k];
    if (s.inv) inv = s.inv; else if (s.hot) s.hot.forEach((id, i) => { if (id) inv[i] = newStack(id, 64); });
    if (s.containers) { containers.chests = s.containers.chests || {}; containers.furnaces = s.containers.furnaces || {}; } }
  else { mode = $('mode').value; localStorage.setItem('vw_mode', mode);
    const sv = $('seed').value.trim(); SEED = sv ? (/^-?\d+$/.test(sv) ? parseInt(sv, 10) : [...sv].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) | 0, 7)) : (Math.random() * 1e9) | 0;
    if (mode === 'creative') [B.Grass, B.Dirt, B.Stone, B.Cobblestone, B.Planks, B.OakLog, B.Sand, B.Glass, B.Torch].forEach((id, i) => inv[i] = newStack(id, 64));
    for (const k in allEdits) delete allEdits[k]; pl.x = 8.5; pl.z = 8.5; pl.y = heightAt(8, 8) + 3; pl.yaw = 0; pl.pitch = 0; pl.fly = false; pl.vy = 0; await dbDel('world'); }
  for (const c of chunks.values()) freeChunk(c); chunks.clear(); lastCenter = '';
  playing = true; $('hud').style.display = 'block'; buildHotbar(); $('fb').classList.toggle('on', pl.fly); $('fb').style.display = mode === 'creative' ? 'flex' : 'none';
  const cx = Math.floor(pl.x) >> 4, cz = Math.floor(pl.z) >> 4;
  await new Promise(res => { const t = () => { streamChunks(cx, cz, 14); let ready = 0, need = 0; for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) { need++; const c = chunks.get(key(cx + dx, cz + dz)); if (c && c.mesh) ready++; } $('lp').textContent = ready + ' / ' + need; if (ready >= need) res(); else setTimeout(t, 0); }; t(); });
  if (!s) { let y = SY - 2; while (y > 1 && (getBlock(Math.floor(pl.x), y, Math.floor(pl.z)) || 0) <= 0) y--; pl.y = y + 1.01; }
  $('load').style.display = 'none'; msg(isMobile ? 'Левая часть — джойстик, правая — камера' : 'Клик по экрану — захват мыши'); }
function showMenu() { closeUI(); if (multiplayer) mpSend({ type:'profile', profile:{ pl:{x:pl.x,y:pl.y,z:pl.z,yaw:pl.yaw,pitch:pl.pitch,fly:pl.fly}, inv, sel, mode } }); saveWorld().then(() => { if (multiplayer) mpDisconnect(); }); playing = false; if (document.pointerLockElement) document.exitPointerLock(); $('hud').style.display = 'none'; $('menu').style.display = 'flex'; dbGet('world').then(w => { $('play').textContent = w ? 'Продолжить игру' : 'Играть'; $('newbtn').style.display = w ? 'block' : 'none'; }); }
window.addEventListener('error', e => { const el = $('err'); if (el) el.textContent = 'Ошибка: ' + (e.message || e); });
(async function init() {
  try { await dbOpen(); await loadAtlas(); } catch (e) { $('err').textContent = String(e); return; }
  $('rd').value = localStorage.getItem('vw_rd') || String(isMobile ? 3 : 5); $('mode').value = localStorage.getItem('vw_mode') || 'survival'; $('mpServer').value = mpStore.server; $('mpName').value = mpStore.name; $('mpCreate').onclick = () => mpConnect('create'); $('mpJoin').onclick = () => mpConnect('join'); bindInput();
  $('play').onclick = () => startGame(false); $('newbtn').onclick = () => { if (confirm('Удалить сохранённый мир и начать новый?')) startGame(true); };
  const w = await dbGet('world'); if (w) { $('play').textContent = 'Продолжить игру'; $('newbtn').style.display = 'block'; }
  window.__vw = { pl, chunks, getBlock, setBlock, B, DEF, ITEMS, RECIPES, inv: () => inv, giveItem: invAdd, openUI, closeUI, ui, containers, get target() { return target; }, get mode() { return mode; }, get playing() { return playing; }, doPlace, setSel: i => { sel = i; buildHotbar(); }, itemName };
  requestAnimationFrame(frame);
})();
})();
