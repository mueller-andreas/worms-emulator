'use strict';

/*
 * Worms Emulator — multiplayer server.
 *
 * Serves the browser client and runs one authoritative GameRoom per room code.
 * Friends join the same room code and play together in real time over WebSockets.
 */

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const C = require('./shared/constants');
const { GameRoom } = require('./src/game');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Static client + shared modules.
app.use(express.static(path.join(__dirname, 'public')));
app.use('/shared', express.static(path.join(__dirname, 'shared')));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

/** @type {Map<string, {room: GameRoom, loop: NodeJS.Timeout|null, socketIds: Set<string>}>} */
const rooms = new Map();

function makeRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  } while (rooms.has(code));
  return code;
}

function getOrCreateRoom(code) {
  let entry = rooms.get(code);
  if (!entry) {
    const broadcast = (event, payload) => io.to(code).emit(event, payload);
    const room = new GameRoom(code, broadcast);
    entry = { room, loop: null, socketIds: new Set() };
    rooms.set(code, entry);
  }
  return entry;
}

function startLoop(entry) {
  if (entry.loop) return;
  entry.loop = setInterval(() => {
    try {
      entry.room.tick();
    } catch (err) {
      console.error(`[room ${entry.room.code}] tick error:`, err);
    }
  }, 1000 / C.TICK_RATE);
}

function stopLoop(entry) {
  if (entry.loop) {
    clearInterval(entry.loop);
    entry.loop = null;
  }
}

function destroyRoom(code) {
  const entry = rooms.get(code);
  if (!entry) return;
  stopLoop(entry);
  rooms.delete(code);
}

io.on('connection', (socket) => {
  let joinedCode = null;

  socket.on('join', (data = {}, ack) => {
    try {
      let code = String(data.room || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
      const name = data.name;

      if (!code) code = makeRoomCode(); // create a fresh room when none supplied
      const entry = getOrCreateRoom(code);
      const res = entry.room.addPlayer(socket.id, name);
      if (!res.ok) {
        if (typeof ack === 'function') ack({ ok: false, error: res.error });
        return;
      }

      joinedCode = code;
      socket.join(code);
      entry.socketIds.add(socket.id);

      if (typeof ack === 'function') {
        ack({ ok: true, code, playerId: socket.id, you: socket.id });
      }
      io.to(code).emit('lobby', entry.room.lobbySnapshot());
    } catch (err) {
      console.error('join error:', err);
      if (typeof ack === 'function') ack({ ok: false, error: 'Server error' });
    }
  });

  socket.on('start', (_data, ack) => {
    const entry = joinedCode && rooms.get(joinedCode);
    if (!entry) return;
    if (entry.room.hostId !== socket.id) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Only the host can start' });
      return;
    }
    const res = entry.room.start();
    if (!res.ok) {
      if (typeof ack === 'function') ack({ ok: false, error: res.error });
      return;
    }
    startLoop(entry);
    io.to(joinedCode).emit('gameStart', entry.room.fullStateForJoin());
    io.to(joinedCode).emit('turn', {
      team: entry.room.teamOrder[entry.room.turnPtr],
      teamName: C.TEAM_NAMES[entry.room.teamOrder[entry.room.turnPtr] % C.TEAM_NAMES.length],
      activeWormId: entry.room.activeWormId,
      wind: entry.room.wind,
      windMax: C.WIND_MAX,
      timeLeft: entry.room.turnTimer,
    });
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('input', (msg = {}) => {
    const entry = joinedCode && rooms.get(joinedCode);
    if (!entry) return;
    entry.room.handleInput(socket.id, msg);
  });

  socket.on('chat', (data = {}) => {
    const entry = joinedCode && rooms.get(joinedCode);
    if (!entry) return;
    const player = entry.room.players.get(socket.id);
    if (!player) return;
    const text = String(data.text || '').slice(0, 200).trim();
    if (text) io.to(joinedCode).emit('chat', { name: player.name, team: player.team, text });
  });

  socket.on('disconnect', () => {
    const entry = joinedCode && rooms.get(joinedCode);
    if (!entry) return;
    entry.socketIds.delete(socket.id);
    entry.room.removePlayer(socket.id);
    io.to(joinedCode).emit('lobby', entry.room.lobbySnapshot());

    // Clean up empty rooms.
    if (entry.socketIds.size === 0) {
      destroyRoom(joinedCode);
    }
  });
});

// Only auto-start when run directly (`node server.js`); tests import and control
// the lifecycle themselves.
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`\n  🪱  Worms Emulator running at http://localhost:${PORT}`);
    console.log(`     Share your room code with friends to play together!\n`);
  });
}

module.exports = { app, server, io, rooms };
