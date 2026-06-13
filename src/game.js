'use strict';

/*
 * Authoritative game simulation for a single room.
 *
 * The server owns the truth: terrain, worm positions, projectiles, whose turn it
 * is, and the clock. Clients only send intentions (walk, aim, jump, fire) and
 * render the snapshots the server broadcasts. This prevents cheating and keeps
 * everyone perfectly in sync.
 */

const C = require('../shared/constants');
const Terrain = require('../shared/terrain');

let SEQ = 0;
const nextId = () => ++SEQ;

class GameRoom {
  /**
   * @param {string} code room code
   * @param {(event:string, payload:any)=>void} broadcast sends to everyone in the room
   */
  constructor(code, broadcast) {
    this.code = code;
    this.broadcast = broadcast;

    /** @type {Map<string, {id:string,name:string,team:number,connected:boolean}>} */
    this.players = new Map();
    this.hostId = null;

    this.phase = 'lobby'; // lobby | aiming | firing | settling | gameover
    this.terrain = null;
    this.seed = 0;
    this.worms = [];
    this.projectiles = [];
    this.craters = []; // recorded so late-joining renderers could catch up

    this.teamOrder = [];
    this.turnPtr = -1;
    this.activeWormId = null;
    this.wind = 0;
    this.currentWeapon = 'bazooka';

    this.turnTimer = 0; // seconds remaining in the active turn
    this.settleTimer = 0;
    this.retreatActive = false;
    this.hasFired = false;

    this.loop = null;
    this.dirty = false; // whether something moved this tick (worth broadcasting)
  }

  // ---- Lobby management -------------------------------------------------

  addPlayer(id, name) {
    if (this.players.size >= C.MAX_PLAYERS) return { ok: false, error: 'Room is full' };
    if (this.phase !== 'lobby') return { ok: false, error: 'Game already in progress' };
    const team = this.players.size;
    this.players.set(id, { id, name: sanitizeName(name), team, connected: true });
    if (!this.hostId) this.hostId = id;
    return { ok: true };
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    if (this.phase === 'lobby') {
      this.players.delete(id);
      // Re-pack team indices so they stay 0..n-1.
      let i = 0;
      for (const pl of this.players.values()) pl.team = i++;
    } else {
      // Mid-game: mark disconnected but keep their worms in play.
      p.connected = false;
    }
    if (this.hostId === id) {
      const first = this.players.values().next().value;
      this.hostId = first ? first.id : null;
    }
  }

  get playerList() {
    return [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      team: p.team,
      teamColor: C.TEAM_COLORS[p.team % C.TEAM_COLORS.length],
      teamName: C.TEAM_NAMES[p.team % C.TEAM_NAMES.length],
      connected: p.connected,
      isHost: p.id === this.hostId,
    }));
  }

  lobbySnapshot() {
    return {
      code: this.code,
      hostId: this.hostId,
      phase: this.phase,
      players: this.playerList,
      minPlayers: C.MIN_PLAYERS,
      maxPlayers: C.MAX_PLAYERS,
    };
  }

  // ---- Match setup ------------------------------------------------------

  start(seed) {
    if (this.players.size < C.MIN_PLAYERS) return { ok: false, error: 'Need at least 2 players' };
    this.seed = (seed >>> 0) || ((Math.random() * 0xffffffff) >>> 0);
    this.terrain = Terrain.generate(this.seed, C.WORLD_WIDTH, C.WORLD_HEIGHT);
    this.worms = [];
    this.projectiles = [];
    this.craters = [];

    const teams = [...this.players.values()].map((p) => p.team);
    this.teamOrder = teams.slice();

    // Spawn worms spread across the map, dropped onto the surface.
    const totalWorms = teams.length * C.WORMS_PER_TEAM;
    const slots = this._spawnColumns(totalWorms);
    let slot = 0;
    for (let w = 0; w < C.WORMS_PER_TEAM; w++) {
      for (const team of teams) {
        const x = slots[slot++];
        const y = this._surfaceY(x) - C.WORM_HEIGHT;
        const owner = [...this.players.values()].find((p) => p.team === team);
        this.worms.push({
          id: nextId(),
          team,
          ownerName: owner ? owner.name : C.TEAM_NAMES[team % C.TEAM_NAMES.length],
          x,
          y,
          vx: 0,
          vy: 0,
          hp: C.WORM_MAX_HP,
          alive: true,
          onGround: false,
          facing: x < C.WORLD_WIDTH / 2 ? 1 : -1,
          aim: x < C.WORLD_WIDTH / 2 ? -0.6 : -Math.PI + 0.6, // radians
        });
      }
    }

    this.phase = 'aiming';
    this.turnPtr = -1;
    this._beginNextTurn();
    return { ok: true };
  }

  _spawnColumns(n) {
    // Evenly spaced columns with a little jitter, kept away from the edges.
    const margin = 90;
    const usable = C.WORLD_WIDTH - margin * 2;
    const rand = Terrain.mulberry32(this.seed ^ 0x9e3779b9);
    const cols = [];
    for (let i = 0; i < n; i++) {
      const base = margin + (usable * (i + 0.5)) / n;
      cols.push(Math.round(base + (rand() * 2 - 1) * (usable / n) * 0.3));
    }
    // Shuffle so teammates aren't all clustered together.
    for (let i = cols.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [cols[i], cols[j]] = [cols[j], cols[i]];
    }
    return cols;
  }

  _surfaceY(x) {
    const t = this.terrain;
    for (let y = 0; y < t.height; y++) {
      if (Terrain.isSolid(t, x, y)) return y;
    }
    return t.height; // empty column -> bottom
  }

  // ---- Turn flow --------------------------------------------------------

  _aliveTeams() {
    const set = new Set();
    for (const w of this.worms) if (w.alive) set.add(w.team);
    return [...set];
  }

  _beginNextTurn() {
    const aliveTeams = this._aliveTeams();
    if (aliveTeams.length <= 1) {
      this.phase = 'gameover';
      const winner = aliveTeams[0];
      this.broadcast('gameOver', {
        winnerTeam: winner === undefined ? null : winner,
        winnerName: winner === undefined ? null : C.TEAM_NAMES[winner % C.TEAM_NAMES.length],
        winnerColor: winner === undefined ? null : C.TEAM_COLORS[winner % C.TEAM_COLORS.length],
      });
      return;
    }

    // Advance to the next team that still has worms.
    let guard = 0;
    do {
      this.turnPtr = (this.turnPtr + 1) % this.teamOrder.length;
      guard++;
    } while (!aliveTeams.includes(this.teamOrder[this.turnPtr]) && guard < this.teamOrder.length * 2);

    const team = this.teamOrder[this.turnPtr];

    // Pick the next living worm for this team (round-robin within the team).
    const teamWorms = this.worms.filter((w) => w.team === team && w.alive);
    if (!this._teamRotation) this._teamRotation = {};
    const rot = (this._teamRotation[team] = (this._teamRotation[team] || 0));
    const chosen = teamWorms[rot % teamWorms.length];
    this._teamRotation[team] = rot + 1;

    this.activeWormId = chosen.id;
    this.wind = +(Math.random() * 2 - 1).toFixed(3) * C.WIND_MAX;
    this.turnTimer = C.TURN_TIME;
    this.retreatActive = false;
    this.hasFired = false;
    this.phase = 'aiming';

    this.broadcast('turn', {
      team,
      teamName: C.TEAM_NAMES[team % C.TEAM_NAMES.length],
      activeWormId: this.activeWormId,
      wind: this.wind,
      windMax: C.WIND_MAX,
      timeLeft: this.turnTimer,
    });
  }

  _endTurn() {
    if (this.phase === 'gameover') return;
    this.phase = 'aiming'; // transient; _beginNextTurn sets it again
    this._beginNextTurn();
  }

  activeWorm() {
    return this.worms.find((w) => w.id === this.activeWormId && w.alive) || null;
  }

  // Which player controls the worm currently in play?
  activePlayerId() {
    const w = this.activeWorm();
    if (!w) return null;
    for (const p of this.players.values()) if (p.team === w.team) return p.id;
    return null;
  }

  // ---- Player input -----------------------------------------------------

  handleInput(playerId, msg) {
    if (this.phase !== 'aiming') return;
    const worm = this.activeWorm();
    if (!worm) return;
    const player = this.players.get(playerId);
    if (!player || player.team !== worm.team) return; // not your turn

    switch (msg.type) {
      case 'walk':
        worm.walkDir = msg.dir === -1 ? -1 : msg.dir === 1 ? 1 : 0;
        if (worm.walkDir !== 0) worm.facing = worm.walkDir;
        break;
      case 'aim':
        if (typeof msg.aim === 'number' && isFinite(msg.aim)) {
          worm.aim = clampAngle(msg.aim);
          // keep facing consistent with aim direction
          worm.facing = Math.cos(worm.aim) >= 0 ? 1 : -1;
        }
        break;
      case 'jump':
        if (worm.onGround) {
          worm.vy = C.JUMP_VY;
          worm.vx = C.JUMP_VX * worm.facing;
          worm.onGround = false;
          this.dirty = true;
        }
        break;
      case 'weapon':
        if (C.WEAPONS[msg.weapon]) {
          this.currentWeapon = msg.weapon;
          this.broadcast('weapon', { weapon: this.currentWeapon });
        }
        break;
      case 'fire':
        this._fire(worm, msg);
        break;
    }
  }

  _fire(worm, msg) {
    if (this.hasFired) return;
    const weapon = C.WEAPONS[this.currentWeapon];
    if (!weapon) return;
    const power = Math.max(0, Math.min(100, Number(msg.power) || 0));
    const aim = typeof msg.aim === 'number' && isFinite(msg.aim) ? clampAngle(msg.aim) : worm.aim;
    worm.aim = aim;
    worm.walkDir = 0;
    this.hasFired = true;

    const muzzleX = worm.x + Math.cos(aim) * (C.WORM_WIDTH + 4);
    const muzzleY = worm.y + C.WORM_HEIGHT / 2 + Math.sin(aim) * (C.WORM_WIDTH + 4);

    if (weapon.kind === 'projectile') {
      const speed = power * weapon.speedFactor;
      this.projectiles.push({
        id: nextId(),
        weapon: weapon.id,
        x: muzzleX,
        y: muzzleY,
        vx: Math.cos(aim) * speed,
        vy: Math.sin(aim) * speed,
        ownerTeam: worm.team,
        fuse: weapon.fuse ? weapon.fuse * C.TICK_RATE : null,
      });
      this.broadcast('fx', { type: 'launch', x: muzzleX, y: muzzleY, weapon: weapon.id });
      this.phase = 'firing';
    } else if (weapon.kind === 'hitscan') {
      this._fireHitscan(worm, aim, weapon);
      this._afterShot();
    } else if (weapon.kind === 'airstrike') {
      this._fireAirstrike(muzzleX, weapon);
      this.phase = 'firing';
    }
  }

  _fireHitscan(worm, aim, weapon) {
    for (let p = 0; p < weapon.pellets; p++) {
      const spread = (p - (weapon.pellets - 1) / 2) * 0.045;
      const a = aim + spread;
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      let hx = worm.x;
      let hy = worm.y + C.WORM_HEIGHT / 2;
      let hit = null;
      for (let d = C.WORM_WIDTH + 2; d < weapon.range; d += 2) {
        const px = worm.x + dx * d;
        const py = worm.y + C.WORM_HEIGHT / 2 + dy * d;
        // worm hit?
        const target = this._wormAt(px, py, worm.id);
        if (target) {
          hit = { x: px, y: py };
          break;
        }
        if (Terrain.isSolid(this.terrain, px, py)) {
          hit = { x: px, y: py };
          break;
        }
        if (px < 0 || px > C.WORLD_WIDTH || py > C.WORLD_HEIGHT) break;
        hx = px;
        hy = py;
      }
      const end = hit || { x: hx, y: hy };
      this.broadcast('fx', { type: 'tracer', x1: worm.x, y1: worm.y + C.WORM_HEIGHT / 2, x2: end.x, y2: end.y });
      if (hit) this._explode(hit.x, hit.y, weapon, worm.team);
    }
  }

  _fireAirstrike(x, weapon) {
    this.airstrike = { x, count: weapon.bombs, weapon, dropped: 0, timer: 0 };
    this.phase = 'firing';
  }

  _wormAt(x, y, exceptId) {
    for (const w of this.worms) {
      if (!w.alive || w.id === exceptId) continue;
      if (
        x >= w.x - C.WORM_WIDTH / 2 &&
        x <= w.x + C.WORM_WIDTH / 2 &&
        y >= w.y &&
        y <= w.y + C.WORM_HEIGHT
      ) {
        return w;
      }
    }
    return null;
  }

  // ---- Simulation -------------------------------------------------------

  tick() {
    if (this.phase === 'lobby' || this.phase === 'gameover') return;
    const dt = 1 / C.TICK_RATE;
    this.dirty = false;

    if (this.phase === 'aiming') {
      this.turnTimer -= dt;
      if (this.turnTimer <= 0) {
        // out of time -> skip the turn
        this._settleAndEnd();
      }
    }

    if (this.phase === 'firing') {
      this._stepAirstrike();
      this._stepProjectiles();
    }

    this._stepWorms();

    if (this.phase === 'firing') {
      if (this._worldAtRest()) {
        this.phase = 'settling';
        this.settleTimer = 0;
      }
    } else if (this.phase === 'settling') {
      this.settleTimer += dt;
      if (this._worldAtRest() || this.settleTimer > C.SETTLE_TIMEOUT) {
        // remove worms that drowned/died, then next turn
        this._reapDead();
        this._endTurn();
      }
    }

    // Broadcast a snapshot whenever the world is animating, plus a light
    // heartbeat while aiming so newcomers / aim changes stay fresh.
    this._broadcastState();
  }

  _stepProjectiles() {
    const survivors = [];
    for (const pr of this.projectiles) {
      const weapon = C.WEAPONS[pr.weapon];
      pr.vy += C.GRAVITY * (weapon.gravity || 1);
      if (weapon.affectedByWind) pr.vx += this.wind;

      // Sub-step to avoid tunnelling through thin terrain at high speed.
      const steps = Math.max(1, Math.ceil(Math.hypot(pr.vx, pr.vy) / 4));
      let exploded = false;
      for (let s = 0; s < steps && !exploded; s++) {
        pr.x += pr.vx / steps;
        pr.y += pr.vy / steps;

        if (pr.x < -50 || pr.x > C.WORLD_WIDTH + 50 || pr.y > C.WORLD_HEIGHT + 60) {
          exploded = 'gone';
          break;
        }

        const target = this._wormAt(pr.x, pr.y, null);
        const solid = Terrain.isSolid(this.terrain, pr.x, pr.y);

        if (weapon.explodeOnImpact && (solid || target)) {
          this._explode(pr.x, pr.y, weapon, pr.ownerTeam);
          exploded = true;
        } else if (!weapon.explodeOnImpact && solid) {
          // grenade bounce
          this._bounce(pr, weapon);
        } else if (target && !weapon.explodeOnImpact) {
          // grenade hitting a worm: detonate
          this._explode(pr.x, pr.y, weapon, pr.ownerTeam);
          exploded = true;
        }
      }

      if (exploded === 'gone') continue;
      if (exploded) continue;

      if (pr.fuse !== null) {
        pr.fuse--;
        if (pr.fuse <= 0) {
          this._explode(pr.x, pr.y, weapon, pr.ownerTeam);
          continue;
        }
      }
      survivors.push(pr);
    }
    this.projectiles = survivors;
    if (this.projectiles.length) this.dirty = true;
  }

  _bounce(pr, weapon) {
    // Estimate surface normal by sampling solidity around the impact point.
    let nx = 0;
    let ny = 0;
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 6) {
      const sx = pr.x + Math.cos(a) * 4;
      const sy = pr.y + Math.sin(a) * 4;
      if (Terrain.isSolid(this.terrain, sx, sy)) {
        nx -= Math.cos(a);
        ny -= Math.sin(a);
      }
    }
    const len = Math.hypot(nx, ny) || 1;
    nx /= len;
    ny /= len;
    // reflect velocity around the normal, then damp
    const dot = pr.vx * nx + pr.vy * ny;
    pr.vx = (pr.vx - 2 * dot * nx) * weapon.bounce;
    pr.vy = (pr.vy - 2 * dot * ny) * weapon.bounce;
    // nudge out of the surface so it doesn't stick
    pr.x += nx * 2;
    pr.y += ny * 2;
    this.broadcast('fx', { type: 'bounce', x: pr.x, y: pr.y });
  }

  _stepAirstrike() {
    const a = this.airstrike;
    if (!a) return;
    a.timer++;
    if (a.dropped < a.count && a.timer % 3 === 0) {
      const offset = (a.dropped - (a.count - 1) / 2) * a.weapon.spacing;
      this.projectiles.push({
        id: nextId(),
        weapon: 'mine',
        x: a.x + offset,
        y: -20,
        vx: 0,
        vy: a.weapon.speed,
        ownerTeam: -1, // airstrike damages everyone
        fuse: null,
        impact: true,
      });
      a.dropped++;
    }
    if (a.dropped >= a.count) this.airstrike = null;
  }

  _explode(x, y, weapon, ownerTeam) {
    const radius = weapon.blastRadius;
    Terrain.carveCircle(this.terrain, x, y, radius);
    const crater = { x: Math.round(x), y: Math.round(y), r: radius };
    this.craters.push(crater);

    for (const w of this.worms) {
      if (!w.alive) continue;
      const cx = w.x;
      const cy = w.y + C.WORM_HEIGHT / 2;
      const dist = Math.hypot(cx - x, cy - y);
      if (dist <= radius + C.WORM_WIDTH) {
        const falloff = Math.max(0, 1 - dist / (radius + C.WORM_WIDTH));
        const dmg = Math.round(weapon.maxDamage * falloff);
        if (dmg > 0) this._damageWorm(w, dmg);
        // knockback impulse away from blast
        const ang = Math.atan2(cy - y, cx - x);
        const force = weapon.knockback * falloff;
        w.vx += Math.cos(ang) * force;
        w.vy += Math.sin(ang) * force - force * 0.3;
        w.onGround = false;
      }
    }

    this.broadcast('explosion', { x: crater.x, y: crater.y, r: radius });
    this.dirty = true;
  }

  _damageWorm(w, dmg) {
    w.hp -= dmg;
    if (w.hp <= 0) {
      w.hp = 0;
      w.alive = false;
      this.broadcast('fx', { type: 'death', x: w.x, y: w.y, team: w.team });
    }
  }

  _stepWorms() {
    for (const w of this.worms) {
      if (!w.alive) continue;
      const isActive = w.id === this.activeWormId;
      const canWalk = isActive && this.phase === 'aiming' && w.onGround;

      // Horizontal walking (only the active worm, on the ground).
      if (canWalk && w.walkDir) {
        this._walk(w, w.walkDir);
      }

      // Gravity / airborne motion for everyone.
      this._applyPhysics(w);
    }
  }

  _walk(w, dir) {
    const t = this.terrain;
    const stepsToTake = Math.max(1, Math.round(C.WALK_SPEED));
    for (let n = 0; n < stepsToTake; n++) {
      const nx = w.x + dir;
      if (nx < 2 || nx > C.WORLD_WIDTH - 2) break;

      const refFeet = Math.round(w.y + C.WORM_HEIGHT);
      // Look for a standable surface within climb range (prefer climbing up).
      let foundFeet = null;
      for (let fy = refFeet - C.MAX_CLIMB; fy <= refFeet + C.MAX_CLIMB; fy++) {
        if (Terrain.isSolid(t, nx, fy) && !Terrain.isSolid(t, nx, fy - 1)) {
          const topY = fy - C.WORM_HEIGHT;
          if (!this._wormCollides(nx, topY)) {
            foundFeet = fy;
            break;
          }
        }
      }

      if (foundFeet !== null) {
        w.x = nx;
        w.y = foundFeet - C.WORM_HEIGHT;
        w.onGround = true;
        this.dirty = true;
      } else if (!this._wormCollides(nx, w.y)) {
        // No ground within climb range but the space is clear: walk off a ledge.
        w.x = nx;
        w.onGround = false;
        w.vx = dir * 1.5;
        w.vy = 0;
        this.dirty = true;
        break;
      } else {
        // Blocked by a wall taller than we can climb.
        break;
      }
    }
  }

  _applyPhysics(w) {
    const t = this.terrain;
    // Ground check.
    const feetY = w.y + C.WORM_HEIGHT;
    const supported = Terrain.isSolid(t, w.x, feetY) || Terrain.isSolid(t, w.x, feetY + 1);

    if (w.onGround && Math.abs(w.vx) < 0.01 && Math.abs(w.vy) < 0.01) {
      if (!supported) w.onGround = false; // ground was blown away beneath
      else return; // resting, nothing to do
    }

    if (w.onGround && supported && w.vy >= 0) {
      // friction while grounded (from knockback skids)
      w.vx *= 0.7;
      if (Math.abs(w.vx) < 0.2) w.vx = 0;
      if (w.vx === 0) return;
    }

    // Airborne integration.
    w.vy += C.GRAVITY;
    if (w.vy > C.MAX_FALL_SPEED) w.vy = C.MAX_FALL_SPEED;

    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(w.vx), Math.abs(w.vy))));
    for (let s = 0; s < steps; s++) {
      // vertical
      const nextFeet = w.y + C.WORM_HEIGHT + w.vy / steps;
      if (w.vy > 0) {
        if (Terrain.isSolid(t, w.x, nextFeet)) {
          // land: settle on top of the solid pixel
          let fy = Math.floor(nextFeet);
          while (fy > 0 && Terrain.isSolid(t, w.x, fy - 1)) fy--;
          w.y = fy - C.WORM_HEIGHT;
          this._land(w);
          break;
        }
      } else if (w.vy < 0) {
        if (Terrain.isSolid(t, w.x, w.y + w.vy / steps)) {
          w.vy = 0;
        }
      }
      w.y += w.vy / steps;

      // horizontal (knockback / jump arc)
      const nx = w.x + w.vx / steps;
      if (!this._wormCollides(nx, w.y)) {
        w.x = clamp(nx, 2, C.WORLD_WIDTH - 2);
      } else {
        w.vx = -w.vx * 0.3; // bounce off walls a little
      }
    }

    // Drowned / fell off the world.
    if (w.y > C.WORLD_HEIGHT + 10) {
      w.alive = false;
      w.hp = 0;
      this.broadcast('fx', { type: 'drown', x: w.x, y: C.WORLD_HEIGHT, team: w.team });
    }
    this.dirty = true;
  }

  _land(w) {
    const speed = w.vy;
    if (speed > C.FALL_DAMAGE_THRESHOLD) {
      const dmg = Math.round((speed - C.FALL_DAMAGE_THRESHOLD) * C.FALL_DAMAGE_FACTOR);
      if (dmg > 0) this._damageWorm(w, dmg);
    }
    w.vy = 0;
    w.onGround = true;
  }

  // True if a worm placed at (x, topY) overlaps solid terrain (its body box).
  _wormCollides(x, topY) {
    const t = this.terrain;
    const hw = C.WORM_WIDTH / 2;
    for (let oy = 2; oy < C.WORM_HEIGHT - 1; oy += 4) {
      if (Terrain.isSolid(t, x - hw + 1, topY + oy)) return true;
      if (Terrain.isSolid(t, x + hw - 1, topY + oy)) return true;
      if (Terrain.isSolid(t, x, topY + oy)) return true;
    }
    return false;
  }

  _worldAtRest() {
    if (this.projectiles.length > 0) return false;
    if (this.airstrike) return false;
    for (const w of this.worms) {
      if (!w.alive) continue;
      if (!w.onGround) return false;
      if (Math.abs(w.vx) > 0.3 || Math.abs(w.vy) > 0.3) return false;
    }
    return true;
  }

  _settleAndEnd() {
    this.phase = 'settling';
    this.settleTimer = 0;
  }

  _afterShot() {
    // For instant weapons: brief settle then end the turn.
    this.phase = 'settling';
    this.settleTimer = 0;
  }

  _reapDead() {
    // Nothing to splice (we keep dead worms for scoreboard), just a hook.
  }

  // ---- Snapshots --------------------------------------------------------

  fullStateForJoin() {
    return {
      seed: this.seed,
      worldW: C.WORLD_WIDTH,
      worldH: C.WORLD_HEIGHT,
      craters: this.craters,
      worms: this.worms.map(serializeWorm),
      activeWormId: this.activeWormId,
      wind: this.wind,
      windMax: C.WIND_MAX,
      currentWeapon: this.currentWeapon,
      phase: this.phase,
      timeLeft: Math.max(0, Math.ceil(this.turnTimer)),
    };
  }

  _broadcastState() {
    this.broadcast('state', {
      worms: this.worms.map(serializeWorm),
      projectiles: this.projectiles.map((p) => ({ id: p.id, x: Math.round(p.x), y: Math.round(p.y), weapon: p.weapon })),
      activeWormId: this.activeWormId,
      phase: this.phase,
      wind: this.wind,
      weapon: this.currentWeapon,
      timeLeft: Math.max(0, Math.ceil(this.turnTimer)),
    });
  }
}

// ---- helpers ------------------------------------------------------------

function serializeWorm(w) {
  return {
    id: w.id,
    team: w.team,
    name: w.ownerName,
    x: Math.round(w.x * 10) / 10,
    y: Math.round(w.y * 10) / 10,
    hp: w.hp,
    alive: w.alive,
    facing: w.facing,
    aim: Math.round(w.aim * 1000) / 1000,
  };
}

function sanitizeName(name) {
  return String(name || 'Worm').replace(/[^\w \-]/g, '').trim().slice(0, 16) || 'Worm';
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function clampAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

module.exports = { GameRoom };
