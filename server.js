// Pixel Dungeon: Monster Hunt / Pixel Dungeon Heroes - Online PvP Server
// Node.js + Express + Socket.IO.

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ ok: true, lobbies: lobbies.size, queue: matchQueue.length }));

const ROOM_WIDTH = 800;
const ROOM_HEIGHT = 500;
const MONSTER_START_TIME = 180;
const MONSTER_INTERVAL = 14;

const lobbies = new Map();      // key -> lobby
const matchQueue = [];          // [{ socket, name }] waiting for ranked 1v1

function normKey(name) { return (name || '').trim().toLowerCase().slice(0, 20); }

function makeLobby(key, displayName, password, minPlayers, ranked) {
  return {
    key, displayName, password: password || '',
    minPlayers: Math.max(2, Math.min(8, minPlayers || 2)),
    ranked: !!ranked,
    players: new Map(),
    state: 'waiting',
    arenaWidth: 0, arenaHeight: ROOM_HEIGHT, walls: [],
    monsters: new Map(), nextMonsterId: 1,
    matchTime: 0, monsterTimer: MONSTER_INTERVAL, tickHandle: null,
  };
}

function publicPlayerList(lobby) {
  return Array.from(lobby.players.values()).map(p => ({ id: p.id, name: p.name, ready: p.ready, weapon: p.weapon }));
}
function fullPlayerList(lobby) {
  return Array.from(lobby.players.values()).map(p => ({
    id: p.id, name: p.name, x: p.x, y: p.y, facing: p.facing, hp: p.hp, alive: p.alive, weapon: p.weapon,
  }));
}
function generateWallsForRoom(offsetX) {
  const walls = [];
  const count = 4 + Math.floor(Math.random() * 5);
  let tries = 0;
  while (walls.length < count && tries < 100) {
    tries++;
    let w, h;
    if (Math.random() < 0.5) { w = 50 + Math.random() * 70; h = 10 + Math.random() * 10; }
    else { w = 10 + Math.random() * 10; h = 50 + Math.random() * 90; }
    const x = offsetX + 40 + Math.random() * (ROOM_WIDTH - 80 - w);
    const y = 40 + Math.random() * (ROOM_HEIGHT - 80 - h);
    walls.push({ x, y, w, h });
  }
  return walls;
}
function buildArena(lobby) {
  const ids = Array.from(lobby.players.keys());
  const n = ids.length;
  lobby.arenaWidth = ROOM_WIDTH * n;
  lobby.walls = [];
  for (let i = 0; i < n; i++) lobby.walls.push(...generateWallsForRoom(i * ROOM_WIDTH));
  ids.forEach((id, i) => {
    const p = lobby.players.get(id);
    p.x = i * ROOM_WIDTH + ROOM_WIDTH / 2; p.y = ROOM_HEIGHT / 2; p.hp = 100; p.alive = true;
  });
}

function broadcastLobby(lobby) {
  io.to(lobby.key).emit('lobby_update', {
    name: lobby.displayName, minPlayers: lobby.minPlayers, players: publicPlayerList(lobby),
  });
}

function addPlayerToLobby(socket, lobby, playerName) {
  socket.data.lobbyKey = lobby.key;
  socket.join(lobby.key);
  lobby.players.set(socket.id, {
    id: socket.id, name: (playerName || 'Player').trim().slice(0, 14) || 'Player',
    weapon: 'ranged', ready: false, x: 0, y: 0, facing: 0, hp: 100, alive: true,
  });
  broadcastLobby(lobby);
  socket.emit('joined_lobby', { name: lobby.displayName, minPlayers: lobby.minPlayers, ranked: lobby.ranked });
  console.log('[joined]', socket.id, '->', lobby.key, 'players now:', lobby.players.size);
}

function maybeStart(lobby) {
  if (lobby.state !== 'waiting') return;
  if (lobby.players.size < lobby.minPlayers) return;
  if (!Array.from(lobby.players.values()).every(p => p.ready)) return;
  startMatch(lobby);
}

function startMatch(lobby) {
  lobby.state = 'playing';
  buildArena(lobby);
  lobby.matchTime = 0;
  lobby.monsterTimer = MONSTER_INTERVAL;
  lobby.monsters = new Map();
  io.to(lobby.key).emit('match_start', {
    arenaWidth: lobby.arenaWidth, arenaHeight: lobby.arenaHeight, walls: lobby.walls, players: fullPlayerList(lobby),
  });
  console.log('[match_start]', lobby.key, 'players:', lobby.players.size);
  lobby.tickHandle = setInterval(() => tick(lobby), 100);
}

function killPlayer(lobby, p) {
  if (!p.alive) return;
  p.alive = false; p.hp = 0;
  io.to(lobby.key).emit('player_died', { id: p.id, name: p.name });
  checkMatchEnd(lobby);
}

function checkMatchEnd(lobby) {
  if (lobby.state !== 'playing') return;
  const alive = Array.from(lobby.players.values()).filter(p => p.alive);
  if (alive.length <= 1) {
    lobby.state = 'ended';
    if (lobby.tickHandle) clearInterval(lobby.tickHandle);
    io.to(lobby.key).emit('match_over', { winner: alive[0] ? { id: alive[0].id, name: alive[0].name } : null });
    console.log('[match_over]', lobby.key);
    // clean up non-persistent ranked lobbies once the match ends
    setTimeout(() => { if (lobby.players.size === 0) lobbies.delete(lobby.key); }, 30000);
  }
}

function tick(lobby) {
  lobby.matchTime += 0.1;
  if (lobby.matchTime >= MONSTER_START_TIME) {
    lobby.monsterTimer -= 0.1;
    if (lobby.monsterTimer <= 0) {
      const alive = Array.from(lobby.players.values()).filter(p => p.alive);
      if (alive.length) {
        const near = alive[Math.floor(Math.random() * alive.length)];
        const id = 'm' + (lobby.nextMonsterId++);
        lobby.monsters.set(id, {
          id, x: near.x + (Math.random() - 0.5) * 200, y: near.y + (Math.random() - 0.5) * 200, speed: 70, dmg: 6,
        });
      }
      lobby.monsterTimer = MONSTER_INTERVAL;
    }
  }
  lobby.monsters.forEach((m) => {
    let target = null, bestD = Infinity;
    lobby.players.forEach((p) => {
      if (!p.alive) return;
      const d = Math.hypot(p.x - m.x, p.y - m.y);
      if (d < bestD) { bestD = d; target = p; }
    });
    if (target && bestD > 1) {
      m.x += (target.x - m.x) / bestD * m.speed * 0.1;
      m.y += (target.y - m.y) / bestD * m.speed * 0.1;
      if (bestD < 28) {
        target.hp = Math.max(0, target.hp - m.dmg * 0.1);
        if (target.hp <= 0) killPlayer(lobby, target);
      }
    }
  });
  io.to(lobby.key).emit('tick', {
    time: lobby.matchTime, players: fullPlayerList(lobby), monsters: Array.from(lobby.monsters.values()),
  });
  checkMatchEnd(lobby);
}

function removeFromQueue(socketId) {
  const idx = matchQueue.findIndex(q => q.socket.id === socketId);
  if (idx !== -1) matchQueue.splice(idx, 1);
}

function tryMatchQueue() {
  while (matchQueue.length >= 2) {
    const a = matchQueue.shift();
    const b = matchQueue.shift();
    if (a.socket.disconnected) { matchQueue.unshift(b); continue; }
    if (b.socket.disconnected) { matchQueue.unshift(a); continue; }
    const key = 'quick_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
    const lobby = makeLobby(key, 'Ranked 1v1', '', 2, true);
    lobbies.set(key, lobby);
    addPlayerToLobby(a.socket, lobby, a.name);
    addPlayerToLobby(b.socket, lobby, b.name);
    lobby.players.forEach(p => { p.ready = true; });
    broadcastLobby(lobby);
    startMatch(lobby);
  }
}

io.on('connection', (socket) => {
  console.log('[connect]', socket.id);

  socket.on('create_lobby', ({ lobbyName, password, playerName, minPlayers }) => {
    const key = normKey(lobbyName);
    console.log('[create_lobby]', socket.id, key);
    if (!key) return socket.emit('lobby_error', 'Enter a lobby name.');
    if (lobbies.has(key)) return socket.emit('lobby_error', 'That lobby name is taken - try joining it instead, or pick a different name.');
    const lobby = makeLobby(key, (lobbyName || '').trim().slice(0, 20), password, minPlayers, false);
    lobbies.set(key, lobby);
    addPlayerToLobby(socket, lobby, playerName);
  });

  socket.on('join_lobby', ({ lobbyName, password, playerName }) => {
    const key = normKey(lobbyName);
    console.log('[join_lobby]', socket.id, key);
    const lobby = lobbies.get(key);
    if (!lobby) return socket.emit('lobby_error', 'Lobby not found. Check the exact name with whoever created it.');
    if (lobby.password && lobby.password !== (password || '')) return socket.emit('lobby_error', 'Wrong password.');
    if (lobby.state !== 'waiting') return socket.emit('lobby_error', 'That match already started.');
    addPlayerToLobby(socket, lobby, playerName);
  });

  socket.on('quick_match', ({ playerName }) => {
    removeFromQueue(socket.id);
    matchQueue.push({ socket, name: (playerName || 'Player').trim().slice(0, 14) || 'Player' });
    socket.emit('queued', { position: matchQueue.length });
    console.log('[quick_match] queued', socket.id, 'queue size:', matchQueue.length);
    tryMatchQueue();
  });

  socket.on('cancel_quick_match', () => {
    removeFromQueue(socket.id);
  });

  socket.on('set_weapon', (weapon) => {
    const lobby = lobbies.get(socket.data.lobbyKey);
    if (!lobby) return;
    const p = lobby.players.get(socket.id);
    if (p) p.weapon = weapon === 'melee' ? 'melee' : 'ranged';
  });

  socket.on('set_ready', (ready) => {
    const lobby = lobbies.get(socket.data.lobbyKey);
    if (!lobby) return;
    const p = lobby.players.get(socket.id);
    if (p) p.ready = !!ready;
    broadcastLobby(lobby);
    maybeStart(lobby);
  });

  socket.on('player_move', ({ x, y, facing }) => {
    const lobby = lobbies.get(socket.data.lobbyKey);
    if (!lobby) return;
    const p = lobby.players.get(socket.id);
    if (!p || !p.alive) return;
    p.x = x; p.y = y; p.facing = facing;
  });

  socket.on('player_shoot', (data) => {
    const lobby = lobbies.get(socket.data.lobbyKey);
    if (!lobby) return;
    socket.to(lobby.key).emit('player_shoot', { ...data, from: socket.id });
  });

  socket.on('report_hit', ({ targetId, dmg }) => {
    const lobby = lobbies.get(socket.data.lobbyKey);
    if (!lobby) return;
    const target = lobby.players.get(targetId);
    if (!target || !target.alive) return;
    target.hp = Math.max(0, target.hp - (dmg || 15));
    if (target.hp <= 0) killPlayer(lobby, target);
  });

  socket.on('disconnect', (reason) => {
    console.log('[disconnect]', socket.id, reason);
    removeFromQueue(socket.id);
    const lobby = lobbies.get(socket.data.lobbyKey);
    if (!lobby) return;
    lobby.players.delete(socket.id);
    if (lobby.players.size === 0) {
      if (lobby.tickHandle) clearInterval(lobby.tickHandle);
      lobbies.delete(lobby.key);
    } else {
      broadcastLobby(lobby);
      checkMatchEnd(lobby);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Pixel Dungeon Heroes PvP server running on port ' + PORT));
