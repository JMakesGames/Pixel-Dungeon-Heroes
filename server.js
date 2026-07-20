// Pixel Dungeon: Monster Hunt / Pixel Dungeon Heroes - Online PvP Server
// Node.js + Express + Socket.IO.

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
const SERVER_VERSION = 'v10-teams-redesign-and-wall-fix';
app.get('/health', (req, res) => res.json({ ok: true, version: SERVER_VERSION, lobbies: lobbies.size, queue: matchQueue.length }));

const ROOM_WIDTH = 800;
const ROOM_HEIGHT = 500;
const MONSTER_START_TIME = 180;
const MONSTER_INTERVAL = 14;

const RANK_TIERS = [
  { name: 'Noob Warrior',          min: 0,    max: 99 },
  { name: 'Still A Noob Warrior',  min: 100,  max: 199 },
  { name: 'Warrior',               min: 200,  max: 299 },
  { name: 'Advanced Warrior',      min: 300,  max: 399 },
  { name: 'Pro-Warrior',           min: 400,  max: 499 },
  { name: 'Legendary Warrior',     min: 500,  max: 999 },
  { name: 'God Warrior',           min: 1000, max: 4999 },
  { name: 'The G.O.A.T. Warrior',  min: 5000, max: 10000 },
];
function getRankName(points) {
  points = Math.max(0, Math.floor(points) || 0);
  for (const tier of RANK_TIERS) { if (points >= tier.min && points <= tier.max) return tier.name; }
  return RANK_TIERS[RANK_TIERS.length - 1].name;
}
function randomWinPoints() { return 7 + Math.floor(Math.random() * 4); }   // 7-10
function randomLosePoints() { return -(3 + Math.floor(Math.random() * 5)); } // -3 to -7

const lobbies = new Map();      // key -> lobby
const matchQueue = [];          // [{ socket, name, points, rank }] waiting for ranked 1v1

function normKey(name) { return (name || '').trim().toLowerCase().slice(0, 20); }

function makeLobby(key, displayName, password, minPlayers, ranked) {
  return {
    key, displayName, password: password || '',
    minPlayers: Math.max(2, Math.min(8, minPlayers || 2)),
    ranked: !!ranked,
    teamsEnabled: false,
    teamsQuestionAsked: false,
    hostId: null,
    players: new Map(),
    state: 'waiting',
    arenaWidth: 0, arenaHeight: ROOM_HEIGHT, walls: [],
    monsters: new Map(), nextMonsterId: 1,
    matchTime: 0, monsterTimer: MONSTER_INTERVAL, tickHandle: null,
  };
}

function publicPlayerList(lobby) {
  return Array.from(lobby.players.values()).map(p => ({ id: p.id, name: p.name, ready: p.ready, weapon: p.weapon, team: p.team || null }));
}
function fullPlayerList(lobby) {
  return Array.from(lobby.players.values()).map(p => ({
    id: p.id, name: p.name, x: p.x, y: p.y, facing: p.facing, hp: p.hp, alive: p.alive, weapon: p.weapon, team: p.team || null,
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
function generateApples(walls) {
  const apples = [];
  let tries = 0;
  const rectHit = (x, y, r, rect) => {
    const cx = Math.max(rect.x, Math.min(x, rect.x + rect.w));
    const cy = Math.max(rect.y, Math.min(y, rect.y + rect.h));
    const dx = x - cx, dy = y - cy;
    return (dx * dx + dy * dy) < r * r;
  };
  while (apples.length < 6 && tries < 200) {
    tries++;
    const x = 40 + Math.random() * (ROOM_WIDTH - 80);
    const y = 40 + Math.random() * (ROOM_HEIGHT - 80);
    if (walls.some(w => rectHit(x, y, 24, w))) continue;
    if (apples.some(a => Math.hypot(a.x - x, a.y - y) < 60)) continue;
    apples.push({ id: 'apple' + apples.length, x, y, taken: false });
  }
  return apples;
}

function buildArena(lobby) {
  const ids = Array.from(lobby.players.keys());
  const n = ids.length;
  // One shared room, always the same size as a single-player dungeon room -
  // no more stitching a separate room per player side by side.
  lobby.arenaWidth = ROOM_WIDTH;
  lobby.walls = generateWallsForRoom(0);
  lobby.apples = generateApples(lobby.walls);
  const margin = 110;
  const usableWidth = ROOM_WIDTH - margin * 2;
  ids.forEach((id, i) => {
    const p = lobby.players.get(id);
    const t = n > 1 ? i / (n - 1) : 0.5;
    p.x = margin + usableWidth * t;
    p.y = ROOM_HEIGHT / 2 + (i % 2 === 0 ? -40 : 40);
    p.hp = 100; p.alive = true;
  });
}

function broadcastLobby(lobby) {
  io.to(lobby.key).emit('lobby_update', {
    name: lobby.displayName, minPlayers: lobby.minPlayers, players: publicPlayerList(lobby),
    teamsEnabled: lobby.teamsEnabled,
  });
}

function nameTakenInLobby(lobby, name) {
  const norm = (name || '').trim().toLowerCase();
  return Array.from(lobby.players.values()).some(p => p.name.toLowerCase() === norm);
}

function addPlayerToLobby(socket, lobby, playerName, opts) {
  opts = opts || {};
  let finalName = (playerName || 'Player').trim().slice(0, 14) || 'Player';
  if (nameTakenInLobby(lobby, finalName)) {
    if (opts.autoUniquify) {
      let suffix = 2;
      while (nameTakenInLobby(lobby, (finalName + ' ' + suffix).slice(0, 14))) suffix++;
      finalName = (finalName + ' ' + suffix).slice(0, 14);
    } else {
      socket.emit('lobby_error', 'That name is already taken in this lobby - pick a different name.');
      return false;
    }
  }
  socket.data.lobbyKey = lobby.key;
  socket.join(lobby.key);
  if (!lobby.hostId) lobby.hostId = socket.id;
  lobby.players.set(socket.id, {
    id: socket.id, name: finalName,
    weapon: 'ranged', ready: false, x: 0, y: 0, facing: 0, hp: 100, alive: true, team: null,
  });
  broadcastLobby(lobby);
  socket.emit('joined_lobby', { name: lobby.displayName, minPlayers: lobby.minPlayers, ranked: lobby.ranked });
  console.log('[joined]', socket.id, '->', lobby.key, 'players now:', lobby.players.size);

  if (!lobby.ranked && !lobby.teamsQuestionAsked && lobby.players.size >= 3 && lobby.state === 'waiting') {
    lobby.teamsQuestionAsked = true;
    io.to(lobby.hostId).emit('prompt_teams_question');
    console.log('[teams] asking host', lobby.hostId, 'in', lobby.key);
  }
  return true;
}

function maybeStart(lobby) {
  if (lobby.state !== 'waiting') return;
  if (lobby.players.size < lobby.minPlayers) return;
  if (!Array.from(lobby.players.values()).every(p => p.ready)) return;
  if (lobby.teamsEnabled) {
    const players = Array.from(lobby.players.values());
    if (!players.every(p => p.team === 'red' || p.team === 'blue')) return;
    if (!players.some(p => p.team === 'red') || !players.some(p => p.team === 'blue')) return;
  }
  startMatch(lobby);
}

function startMatch(lobby) {
  lobby.state = 'playing';
  buildArena(lobby);
  lobby.matchTime = 0;
  lobby.monsterTimer = MONSTER_INTERVAL;
  lobby.monsters = new Map();
  io.to(lobby.key).emit('match_start', {
    arenaWidth: lobby.arenaWidth, arenaHeight: lobby.arenaHeight, walls: lobby.walls,
    apples: lobby.apples, players: fullPlayerList(lobby),
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
  const alivePlayers = Array.from(lobby.players.values()).filter(p => p.alive);

  let matchOver = false;
  let winningTeam = null;
  let winningPlayer = null;

  if (lobby.teamsEnabled) {
    const aliveTeams = new Set(alivePlayers.map(p => p.team));
    if (aliveTeams.size <= 1) {
      matchOver = true;
      winningTeam = alivePlayers.length ? alivePlayers[0].team : null;
    }
  } else if (alivePlayers.length <= 1) {
    matchOver = true;
    winningPlayer = alivePlayers[0] || null;
  }

  if (!matchOver) return;

  lobby.state = 'ended';
  if (lobby.tickHandle) clearInterval(lobby.tickHandle);

  let winnerDelta = 0, loserDelta = 0;
  const awardPoints = lobby.ranked && winningPlayer;
  if (awardPoints) { winnerDelta = randomWinPoints(); loserDelta = randomLosePoints(); }

  // Always compute and send each player their OWN accurate result directly -
  // never a single shared broadcast, which is what previously made every
  // player see "YOU LOSE" at once in non-ranked matches.
  lobby.players.forEach(p => {
    let won;
    if (winningTeam) won = p.team === winningTeam;
    else if (winningPlayer) won = p.id === winningPlayer.id;
    else won = false; // no survivors at all
    const winnerInfo = winningTeam
      ? { id: null, name: winningTeam.toUpperCase() + ' TEAM' }
      : (winningPlayer ? { id: winningPlayer.id, name: winningPlayer.name } : null);
    io.to(p.id).emit('match_over', {
      winner: winnerInfo, won,
      pointsDelta: awardPoints ? (won ? winnerDelta : loserDelta) : 0,
    });
  });
  console.log('[match_over]', lobby.key, winningTeam ? `team ${winningTeam} wins` : (winningPlayer ? `${winningPlayer.name} wins` : 'no survivors'));
  // clean up non-persistent ranked lobbies once the match ends
  setTimeout(() => { if (lobby.players.size === 0) lobbies.delete(lobby.key); }, 30000);
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
  // Group waiting players by rank tier - a match can only be made between
  // two players in the exact same tier, per the ranking rules.
  const byRank = new Map();
  matchQueue.forEach(entry => {
    if (entry.socket.disconnected) return;
    if (!byRank.has(entry.rank)) byRank.set(entry.rank, []);
    byRank.get(entry.rank).push(entry);
  });

  byRank.forEach((entries, rank) => {
    while (entries.length >= 2) {
      const a = entries.shift();
      const b = entries.shift();
      removeFromQueue(a.socket.id);
      removeFromQueue(b.socket.id);
      const key = 'quick_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
      const lobby = makeLobby(key, 'Ranked 1v1 - ' + rank, '', 2, true);
      lobbies.set(key, lobby);
      addPlayerToLobby(a.socket, lobby, a.name, {autoUniquify:true});
      addPlayerToLobby(b.socket, lobby, b.name, {autoUniquify:true});
      lobby.players.forEach(p => { p.ready = true; });
      broadcastLobby(lobby);
      startMatch(lobby);
    }
  });

  // clean out any disconnected entries that never got matched
  for (let i = matchQueue.length - 1; i >= 0; i--) {
    if (matchQueue[i].socket.disconnected) matchQueue.splice(i, 1);
  }
}

io.on('connection', (socket) => {
  console.log('[connect]', socket.id);
  socket.emit('server_info', { version: SERVER_VERSION });

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

  socket.on('quick_match', ({ playerName, points }) => {
    removeFromQueue(socket.id);
    const safePoints = Math.max(0, Math.floor(Number(points)) || 0);
    const rank = getRankName(safePoints);
    matchQueue.push({ socket, name: (playerName || 'Player').trim().slice(0, 14) || 'Player', points: safePoints, rank });
    const sameRankWaiting = matchQueue.filter(q => q.rank === rank).length;
    socket.emit('queued', { position: sameRankWaiting, rank });
    console.log('[quick_match] queued', socket.id, 'rank:', rank, 'queue size:', matchQueue.length);
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

  socket.on('teams_decision', (wantsTeams) => {
    const lobby = lobbies.get(socket.data.lobbyKey);
    if (!lobby || lobby.state !== 'waiting') return;
    if (socket.id !== lobby.hostId) return; // only the host (first player to join) answers this
    lobby.teamsEnabled = !!wantsTeams;
    if (!lobby.teamsEnabled) lobby.players.forEach(p => { p.team = null; });
    io.to(lobby.key).emit('teams_decision_result', { teamsEnabled: lobby.teamsEnabled });
    broadcastLobby(lobby);
    console.log('[teams]', lobby.key, 'host chose', lobby.teamsEnabled ? 'TEAMS ON' : 'no teams');
  });

  socket.on('set_team', (team) => {
    const lobby = lobbies.get(socket.data.lobbyKey);
    if (!lobby || !lobby.teamsEnabled) return;
    const p = lobby.players.get(socket.id);
    if (p && (team === 'red' || team === 'blue')) { p.team = team; broadcastLobby(lobby); }
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
    const attacker = lobby.players.get(socket.id);
    if (!target || !target.alive) return;
    if (lobby.teamsEnabled && attacker && attacker.team && attacker.team === target.team) return; // no friendly fire
    target.hp = Math.max(0, target.hp - (dmg || 15));
    if (target.hp <= 0) killPlayer(lobby, target);
  });

  socket.on('eat_apple', ({ appleId }) => {
    const lobby = lobbies.get(socket.data.lobbyKey);
    if (!lobby || !lobby.apples) return;
    const apple = lobby.apples.find(a => a.id === appleId);
    const p = lobby.players.get(socket.id);
    if (!apple || apple.taken || !p || !p.alive) return;
    if (p.hp >= 100) return; // can't eat an apple while already at full health
    apple.taken = true;
    p.hp = Math.min(100, p.hp + 15);
    io.to(lobby.key).emit('apple_taken', { appleId });
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
      if (lobby.hostId === socket.id) {
        lobby.hostId = Array.from(lobby.players.keys())[0];
        if (!lobby.teamsQuestionAsked && lobby.players.size >= 3 && lobby.state === 'waiting') {
          lobby.teamsQuestionAsked = true;
          io.to(lobby.hostId).emit('prompt_teams_question');
        }
      }
      broadcastLobby(lobby);
      checkMatchEnd(lobby);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Pixel Dungeon Heroes PvP server ['+SERVER_VERSION+'] running on port ' + PORT));
