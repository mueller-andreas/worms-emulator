/*
 * Shared game constants. Loaded by both the Node server and the browser client.
 * Keeping a single source of truth means the simulation and the renderer never
 * disagree about world size, gravity, weapon behaviour, etc.
 */
(function (global) {
  'use strict';

  const Constants = {
    // World / simulation
    WORLD_WIDTH: 1600,
    WORLD_HEIGHT: 640,
    TICK_RATE: 30, // simulation + broadcast frequency (Hz)
    GRAVITY: 0.55, // px per tick^2
    MAX_FALL_SPEED: 22,

    // Worms
    WORM_WIDTH: 10,
    WORM_HEIGHT: 16,
    WORM_MAX_HP: 100,
    WORMS_PER_TEAM: 3,
    WALK_SPEED: 2.0, // px per tick
    MAX_CLIMB: 7, // px a worm can step up/down while walking
    JUMP_VY: -8.5,
    JUMP_VX: 3.2,
    FALL_DAMAGE_THRESHOLD: 13, // landing speed above which damage is taken
    FALL_DAMAGE_FACTOR: 2.2,

    // Turn flow
    TURN_TIME: 35, // seconds a player has to act
    RETREAT_TIME: 4, // seconds of movement allowed after firing
    SETTLE_TIMEOUT: 8, // safety cap (seconds) waiting for the world to come to rest

    // Wind
    WIND_MAX: 0.06, // px per tick^2 applied to projectiles

    // Match
    MIN_PLAYERS: 2,
    MAX_PLAYERS: 6,

    // Team colours (also used to colour each team's worms)
    TEAM_COLORS: ['#e6394b', '#3da6ff', '#46c93a', '#f5c542', '#b46cff', '#ff8c42'],
    TEAM_NAMES: ['Red', 'Blue', 'Green', 'Yellow', 'Purple', 'Orange'],
  };

  // Weapon definitions. `kind` drives projectile behaviour on the server.
  Constants.WEAPONS = {
    bazooka: {
      id: 'bazooka',
      name: 'Bazooka',
      kind: 'projectile',
      explodeOnImpact: true,
      affectedByWind: true,
      gravity: 1.0,
      speedFactor: 0.20, // power(0-100) -> launch speed
      blastRadius: 38,
      maxDamage: 48,
      knockback: 7.5,
      ammo: Infinity,
      key: '1',
    },
    grenade: {
      id: 'grenade',
      name: 'Grenade',
      kind: 'projectile',
      explodeOnImpact: false,
      bounce: 0.55,
      fuse: 4, // seconds until detonation
      affectedByWind: false,
      gravity: 1.0,
      speedFactor: 0.18,
      blastRadius: 44,
      maxDamage: 52,
      knockback: 8.5,
      ammo: Infinity,
      key: '2',
    },
    shotgun: {
      id: 'shotgun',
      name: 'Shotgun',
      kind: 'hitscan',
      pellets: 2,
      range: 520,
      blastRadius: 12,
      maxDamage: 26,
      knockback: 4.0,
      ammo: Infinity,
      key: '3',
    },
    mine: {
      id: 'mine',
      name: 'Air Strike',
      kind: 'airstrike',
      bombs: 5,
      spacing: 26,
      gravity: 1.0,
      speed: 9,
      blastRadius: 34,
      maxDamage: 40,
      knockback: 6.5,
      ammo: Infinity,
      key: '4',
    },
  };

  Constants.WEAPON_ORDER = ['bazooka', 'grenade', 'shotgun', 'mine'];

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Constants;
  } else {
    global.WormsConstants = Constants;
  }
})(typeof window !== 'undefined' ? window : globalThis);
