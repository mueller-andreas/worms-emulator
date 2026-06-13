'use strict';

/*
 * Local pass-and-play smoke test (no browser, no network).
 *
 * Drives the in-process GameRoom exactly as the browser client does: create a
 * match, add teams, start, fire a weapon, and step the simulation. Asserts the
 * core mechanics behave — deterministic terrain, grounded spawns, configurable
 * worms-per-team, explosions that carve terrain, and turn rotation.
 *
 * Run with: npm test
 */

const assert = require('assert');
const { GameRoom } = require('../src/game');
const C = require('../shared/constants');
const Terrain = require('../shared/terrain');

const log = (...a) => console.log('  ·', ...a);
let passed = 0;
function check(name, cond) {
  assert.ok(cond, 'FAILED: ' + name);
  passed++;
  log('ok —', name);
}

// Collect every event the simulation broadcasts.
const events = [];
const game = new GameRoom('LOCAL', (e, p) => events.push({ e, p }));
game.local = true;
game.wormsPerTeam = 2;

game.addPlayer('p0', 'Alpha');
game.addPlayer('p1', 'Bravo');
check('two teams added to the match', game.players.size === 2);

const res = game.start();
check('match starts', res.ok === true);
check('honours configurable worms-per-team (2x2 = 4 worms)', game.worms.length === 4);

// Determinism: regenerate terrain from the seed like a client would, and confirm
// every worm spawned resting on solid ground.
const terrain = Terrain.generate(game.seed, C.WORLD_WIDTH, C.WORLD_HEIGHT);
let grounded = true;
for (const w of game.worms) {
  const feet = Math.round(w.y + C.WORM_HEIGHT);
  const ok = Terrain.isSolid(terrain, Math.round(w.x), feet) ||
    Terrain.isSolid(terrain, Math.round(w.x), feet + 1) ||
    Terrain.isSolid(terrain, Math.round(w.x), feet + 2);
  if (!ok) grounded = false;
}
check('worms spawn resting on the deterministically-generated terrain', grounded);

const firstTurn = events.find((ev) => ev.e === 'turn');
check('a first turn is announced', !!firstTurn);
check('an active worm is assigned', !!game.activeWormId);

// Local mode lets the single human control whichever worm is active.
const active = game.activeWorm();
const activeTeam = active.team;
const aim = active.x < C.WORLD_WIDTH / 2 ? 0.2 : Math.PI - 0.2;
game.handleInput(null, { type: 'weapon', weapon: 'bazooka' });
game.handleInput(null, { type: 'aim', aim });
check('weapon selection is accepted in local mode', game.currentWeapon === 'bazooka');

game.handleInput(null, { type: 'fire', power: 100, aim });
check('firing transitions to the firing phase', game.phase === 'firing');

// Step the simulation until the rocket explodes (or give up after ~20s of game time).
let boom = null;
for (let i = 0; i < C.TICK_RATE * 20 && !boom; i++) {
  game.tick();
  boom = events.find((ev) => ev.e === 'explosion');
}
check('firing a bazooka produces an explosion', !!boom);

// Mirror the crater and confirm terrain was destroyed at the blast centre.
Terrain.carveCircle(terrain, boom.p.x, boom.p.y, boom.p.r);
check('explosion carves out terrain (crater is empty)', !Terrain.isSolid(terrain, boom.p.x, boom.p.y));

// Keep stepping until the next turn is announced; it must move to another team.
const turnsBefore = events.filter((ev) => ev.e === 'turn').length;
let nextTurn = null;
for (let i = 0; i < C.TICK_RATE * 20 && !nextTurn; i++) {
  game.tick();
  const turns = events.filter((ev) => ev.e === 'turn');
  if (turns.length > turnsBefore) nextTurn = turns[turns.length - 1];
}
check('turn advances after the world settles', !!nextTurn);
check('turn passes to a different team', nextTurn.p.team !== activeTeam);
log('first team:', activeTeam, '→ next team:', nextTurn.p.team);

// A 3-team / 3-worm setup should produce 9 worms.
const g2 = new GameRoom('L2', () => {});
g2.local = true;
g2.wormsPerTeam = 3;
['Red', 'Blue', 'Green'].forEach((n, i) => g2.addPlayer('t' + i, n));
g2.start();
check('three teams of three spawn nine worms', g2.worms.length === 9);

console.log(`\n  ✅ All ${passed} checks passed.\n`);
process.exit(0);
