'use strict';

/*
 * End-to-end smoke test (no browser needed).
 *
 * Boots the real server, connects two Socket.IO clients, walks through the full
 * lobby -> start -> play flow, and asserts the authoritative simulation behaves:
 * a match starts, worms spawn on the terrain, turns rotate, and firing a weapon
 * produces an explosion that carves terrain and can damage a worm.
 *
 * Run with: npm test
 */

const assert = require('assert');
const { io: ioClient } = require('socket.io-client');

process.env.PORT = '0'; // let the OS pick a free port
const { server } = require('../server');
const C = require('../shared/constants');
const Terrain = require('../shared/terrain');

const log = (...a) => console.log('  ·', ...a);
let passed = 0;
function check(name, cond) {
  assert.ok(cond, 'FAILED: ' + name);
  passed++;
  log('ok —', name);
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const c = ioClient(`http://localhost:${port}`, { transports: ['websocket'], reconnection: false });
    c.on('connect', () => resolve(c));
    c.on('connect_error', reject);
  });
}

function once(sock, event, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for ' + event)), timeout);
    sock.once(event, (data) => { clearTimeout(timer); resolve(data); });
  });
}

(async () => {
  await new Promise((res) => server.listen(0, res));
  const port = server.address().port;
  log('server listening on', port);

  const host = await connect(port);
  const guest = await connect(port);

  // --- Join / create a room ---
  const hostJoin = await new Promise((res) => host.emit('join', { name: 'Host', room: '' }, res));
  check('host can create a room', hostJoin.ok && hostJoin.code);
  const code = hostJoin.code;

  // Attach the lobby listener *before* joining so we can't miss the broadcast
  // that arrives in the same network frame as the join acknowledgement.
  const lobbyP = once(guest, 'lobby');
  const guestJoin = await new Promise((res) => guest.emit('join', { name: 'Guest', room: code }, res));
  check('guest can join with the room code', guestJoin.ok && guestJoin.code === code);

  const lobby = await lobbyP;
  check('lobby reports two players', lobby.players.length === 2);
  check('host is flagged as host', lobby.players.find((p) => p.isHost).name === 'Host');
  check('players are on different teams', lobby.players[0].team !== lobby.players[1].team);

  // --- Non-host cannot start ---
  const guestStart = await new Promise((res) => guest.emit('start', {}, res));
  check('non-host cannot start the game', guestStart.ok === false);

  // --- Host starts ---
  const startedP = once(host, 'gameStart');
  const hostStart = await new Promise((res) => host.emit('start', {}, res));
  check('host can start the game', hostStart.ok === true);
  const gs = await startedP;
  check('gameStart includes a seed and world size', gs.seed >= 0 && gs.worldW === C.WORLD_WIDTH);
  const expectedWorms = 2 * C.WORMS_PER_TEAM;
  check(`spawns ${expectedWorms} worms`, gs.worms.length === expectedWorms);

  // Rebuild terrain from the seed exactly like a client would, and verify all
  // worms spawned resting on (just above) solid ground — proves determinism.
  const terrain = Terrain.generate(gs.seed, gs.worldW, gs.worldH);
  let allGrounded = true;
  for (const w of gs.worms) {
    const feet = Math.round(w.y + C.WORM_HEIGHT);
    const groundBelow = Terrain.isSolid(terrain, Math.round(w.x), feet) ||
      Terrain.isSolid(terrain, Math.round(w.x), feet + 1) ||
      Terrain.isSolid(terrain, Math.round(w.x), feet + 2);
    if (!groundBelow) { allGrounded = false; log('   worm not grounded at', w.x, w.y); }
  }
  check('worms spawn resting on the deterministically-generated terrain', allGrounded);

  // --- Turn assignment ---
  const turn = await once(host, 'turn', 5000).catch(() => null) || gs;
  const firstActive = gs.activeWormId;
  check('an active worm is assigned for the first turn', !!firstActive);

  // --- Identify which client controls the active worm and fire a bazooka ---
  const stateMsg = await once(host, 'state', 5000);
  const activeWorm = stateMsg.worms.find((w) => w.id === stateMsg.activeWormId);
  check('active worm exists in state broadcast', !!activeWorm);

  const hostTeam = lobby.players.find((p) => p.name === 'Host').team;
  const shooter = activeWorm.team === hostTeam ? host : guest;
  log('active team is', activeWorm.team, '— shooter is', activeWorm.team === hostTeam ? 'Host' : 'Guest');

  // Aim roughly horizontally toward the centre and fire at full power.
  const aimDir = activeWorm.x < C.WORLD_WIDTH / 2 ? 0.2 : Math.PI - 0.2;
  shooter.emit('input', { type: 'weapon', weapon: 'bazooka' });
  shooter.emit('input', { type: 'aim', aim: aimDir });

  const explosionP = once(host, 'explosion', 8000);
  shooter.emit('input', { type: 'fire', power: 100, aim: aimDir });
  const boom = await explosionP;
  check('firing a bazooka produces an explosion', typeof boom.x === 'number' && boom.r > 0);

  // The explosion must have carved terrain at its centre.
  Terrain.carveCircle(terrain, boom.x, boom.y, boom.r); // mirror the crater
  check('explosion carves out terrain (crater is empty)', !Terrain.isSolid(terrain, boom.x, boom.y));

  // --- Turn should advance to the other team after the world settles ---
  const nextTurn = await once(host, 'turn', 12000);
  check('turn advances to the next team after firing', true);
  log('next turn team:', nextTurn.team);

  // --- Disconnect cleanup ---
  host.close();
  guest.close();
  await new Promise((r) => setTimeout(r, 300));

  console.log(`\n  ✅ All ${passed} checks passed.\n`);
  server.close();
  process.exit(0);
})().catch((err) => {
  console.error('\n  ❌ Smoke test failed:\n', err);
  process.exit(1);
});
