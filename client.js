'use strict';

/* global WormsConstants, WormsTerrain, WormsGame */

const C = WormsConstants;
const T = WormsTerrain;
const { GameRoom } = WormsGame;

// ----------------------------------------------------------------------------
// State
// ----------------------------------------------------------------------------
const State = {
  game: null,
  tickTimer: null,
  started: false,
  paused: true,

  // world (mirrors what the simulation broadcasts)
  terrain: null,
  terrainCanvas: null,
  worms: [],
  projectiles: [],
  activeWormId: null,
  wind: 0,
  windMax: C.WIND_MAX,
  weapon: 'bazooka',
  phase: 'lobby',
  timeLeft: 0,

  teamNames: [],
  wormsPerTeam: 3,

  // effects
  particles: [],
  tracers: [],

  // local input / aim
  charging: false,
  power: 0,
  localAim: null,
  walkDir: 0,

  camX: 0,
  camY: 0,
};

const $ = (id) => document.getElementById(id);

// ----------------------------------------------------------------------------
// Setup screen
// ----------------------------------------------------------------------------
const config = { teams: 2, worms: 3, names: [] };
const MAX_TEAMS = Math.min(C.MAX_PLAYERS, C.TEAM_NAMES.length);

function defaultName(i) { return C.TEAM_NAMES[i % C.TEAM_NAMES.length]; }

function renderTeamNameInputs() {
  const box = $('teamNames');
  // preserve already-typed names
  const existing = [...box.querySelectorAll('input')].map((el) => el.value);
  box.innerHTML = '';
  for (let i = 0; i < config.teams; i++) {
    const row = document.createElement('div');
    row.className = 'team-row-input';
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = C.TEAM_COLORS[i % C.TEAM_COLORS.length];
    const input = document.createElement('input');
    input.maxLength = 16;
    input.value = existing[i] || defaultName(i);
    input.placeholder = defaultName(i);
    row.appendChild(dot);
    row.appendChild(input);
    box.appendChild(row);
  }
}

document.querySelectorAll('[data-stepper]').forEach((stepper) => {
  const kind = stepper.dataset.stepper;
  stepper.querySelectorAll('[data-step]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const delta = parseInt(btn.dataset.step, 10);
      if (kind === 'teams') {
        config.teams = clamp(config.teams + delta, 2, MAX_TEAMS);
        $('teamCount').textContent = config.teams;
        renderTeamNameInputs();
      } else {
        config.worms = clamp(config.worms + delta, 1, 5);
        $('wormCount').textContent = config.worms;
      }
    });
  });
});

$('startBtn').addEventListener('click', () => {
  const inputs = [...$('teamNames').querySelectorAll('input')];
  config.names = inputs.map((el, i) => (el.value.trim() || defaultName(i)).slice(0, 16));
  startMatch();
});

renderTeamNameInputs();

// ----------------------------------------------------------------------------
// Local game runner — the simulation runs right here in the browser.
// ----------------------------------------------------------------------------
function startMatch() {
  const game = new GameRoom('LOCAL', () => {}); // swallow events during setup
  game.local = true;
  game.wormsPerTeam = config.worms;
  config.names.forEach((name, i) => game.addPlayer('p' + i, name));

  const res = game.start();
  if (!res.ok) { alert(res.error); return; }

  // Wire real event handling, then announce the start + first turn in order.
  game.broadcast = handleGameEvent;
  State.game = game;
  State.teamNames = config.names.slice();
  State.wormsPerTeam = config.worms;

  onGameStart(game.fullStateForJoin());
  onTurn(currentTurnPayload(game));

  // Drive the simulation. Paused while the pass-the-phone overlay is up.
  State.tickTimer = setInterval(() => {
    if (!State.paused && State.game) {
      try { State.game.tick(); } catch (e) { console.error(e); }
    }
  }, 1000 / C.TICK_RATE);

  $('setup').classList.add('hidden');
  $('game').classList.remove('hidden');
  document.body.classList.add('in-game');
  resizeCanvas();
  renderWeaponChips();
}

function currentTurnPayload(game) {
  const team = game.teamOrder[game.turnPtr];
  return {
    team,
    teamName: C.TEAM_NAMES[team % C.TEAM_NAMES.length],
    activeWormId: game.activeWormId,
    wind: game.wind,
    windMax: C.WIND_MAX,
    timeLeft: game.turnTimer,
  };
}

function handleGameEvent(ev, p) {
  switch (ev) {
    case 'gameStart': onGameStart(p); break;
    case 'state': onState(p); break;
    case 'turn': onTurn(p); break;
    case 'weapon': State.weapon = p.weapon; renderWeaponChips(); break;
    case 'explosion': onExplosion(p); break;
    case 'fx': onFx(p); break;
    case 'gameOver': onGameOver(p); break;
  }
}

function sendInput(msg) {
  if (State.game) State.game.handleInput(null, msg);
}

// ----------------------------------------------------------------------------
// Event handlers (mirror of the old network handlers, now local calls)
// ----------------------------------------------------------------------------
function onGameStart(data) {
  State.started = true;
  State.terrain = T.generate(data.seed, data.worldW, data.worldH);
  buildTerrainCanvas();
  (data.craters || []).forEach((cr) => applyCrater(cr.x, cr.y, cr.r, false));
  State.worms = data.worms.map((w) => ({ ...w, rx: w.x, ry: w.y }));
  State.activeWormId = data.activeWormId;
  State.wind = data.wind;
  State.windMax = data.windMax;
  State.weapon = data.currentWeapon;
  State.phase = data.phase;
}

function onState(s) {
  const prev = new Map(State.worms.map((w) => [w.id, w]));
  State.worms = s.worms.map((w) => {
    const old = prev.get(w.id);
    w.rx = old && old.rx !== undefined ? old.rx : w.x;
    w.ry = old && old.ry !== undefined ? old.ry : w.y;
    return w;
  });
  State.projectiles = s.projectiles;
  State.activeWormId = s.activeWormId;
  State.phase = s.phase;
  State.wind = s.wind;
  State.weapon = s.weapon;
  State.timeLeft = s.timeLeft;
  renderWeaponChips();
  updateHud();
}

function onTurn(t) {
  State.activeWormId = t.activeWormId;
  State.wind = t.wind;
  State.windMax = t.windMax;
  State.timeLeft = t.timeLeft;
  State.phase = 'aiming';
  State.charging = false;
  State.power = 0;
  State.walkDir = 0;
  State.localAim = null;
  $('turnTeam').textContent = `${displayName(t.team)}'s turn`;
  $('turnTeam').style.color = C.TEAM_COLORS[t.team % C.TEAM_COLORS.length];
  updateHud();
  showPassOverlay(t.team);
}

function onExplosion(e) {
  applyCrater(e.x, e.y, e.r, true);
  spawnExplosionParticles(e.x, e.y, e.r);
}

function onFx(fx) {
  if (fx.type === 'tracer') {
    State.tracers.push({ x1: fx.x1, y1: fx.y1, x2: fx.x2, y2: fx.y2, life: 8 });
  } else if (fx.type === 'launch') {
    spawnPuff(fx.x, fx.y);
  } else if (fx.type === 'bounce') {
    spawnPuff(fx.x, fx.y, 3);
  } else if (fx.type === 'death' || fx.type === 'drown') {
    spawnExplosionParticles(fx.x, fx.y, 24);
  }
}

function onGameOver(g) {
  State.paused = true;
  const ov = $('overlay');
  ov.classList.remove('hidden');
  ov.innerHTML = '';
  const title = document.createElement('div');
  if (g.winnerTeam !== null && g.winnerTeam !== undefined) {
    title.innerHTML = `🏆 <span style="color:${C.TEAM_COLORS[g.winnerTeam % C.TEAM_COLORS.length]}">${displayName(g.winnerTeam)}</span> wins!`;
  } else {
    title.textContent = 'Draw — everyone wiped out!';
  }
  ov.appendChild(title);
  const btn = document.createElement('button');
  btn.textContent = 'Play again';
  btn.onclick = () => location.reload();
  ov.appendChild(btn);
}

function displayName(team) {
  return State.teamNames[team] || C.TEAM_NAMES[team % C.TEAM_NAMES.length];
}

// ----------------------------------------------------------------------------
// Pass-the-phone overlay
// ----------------------------------------------------------------------------
function showPassOverlay(team) {
  State.paused = true;
  const ov = $('passOverlay');
  const color = C.TEAM_COLORS[team % C.TEAM_COLORS.length];
  $('passName').textContent = displayName(team);
  $('passName').style.color = color;
  const pill = $('passPill');
  pill.textContent = C.TEAM_NAMES[team % C.TEAM_NAMES.length] + ' team';
  pill.style.background = color;
  ov.classList.remove('hidden');
}

$('passStart').addEventListener('click', () => {
  $('passOverlay').classList.add('hidden');
  State.paused = false;
});

// ----------------------------------------------------------------------------
// Terrain rendering
// ----------------------------------------------------------------------------
function buildTerrainCanvas() {
  const { grid, width, height } = State.terrain;
  const cv = document.createElement('canvas');
  cv.width = width;
  cv.height = height;
  const ctx2 = cv.getContext('2d');
  const img = ctx2.createImageData(width, height);
  const data = img.data;
  for (let x = 0; x < width; x++) {
    let foundTop = false;
    for (let y = 0; y < height; y++) {
      const i = (y * width + x) * 4;
      if (grid[y * width + x]) {
        if (!foundTop) {
          data[i] = 86; data[i + 1] = 178; data[i + 2] = 64; data[i + 3] = 255;
          foundTop = true;
        } else {
          const shade = 1 - Math.min(1, y / height) * 0.25;
          data[i] = 120 * shade; data[i + 1] = 82 * shade; data[i + 2] = 50 * shade; data[i + 3] = 255;
        }
      } else {
        data[i + 3] = 0;
      }
    }
  }
  ctx2.putImageData(img, 0, 0);
  State.terrainCanvas = cv;
}

function applyCrater(x, y, r, withRim) {
  if (!State.terrain) return;
  T.carveCircle(State.terrain, x, y, r);
  const ctx2 = State.terrainCanvas.getContext('2d');
  ctx2.save();
  ctx2.globalCompositeOperation = 'destination-out';
  ctx2.beginPath();
  ctx2.arc(x, y, r, 0, Math.PI * 2);
  ctx2.fill();
  ctx2.restore();
  if (withRim) {
    ctx2.save();
    ctx2.globalCompositeOperation = 'source-atop';
    ctx2.beginPath();
    ctx2.arc(x, y, r + 3, 0, Math.PI * 2);
    ctx2.lineWidth = 5;
    ctx2.strokeStyle = 'rgba(20,12,8,0.55)';
    ctx2.stroke();
    ctx2.restore();
  }
}

// ----------------------------------------------------------------------------
// Canvas + camera
// ----------------------------------------------------------------------------
const canvas = $('view');
const ctx = canvas.getContext('2d');
let scale = 1;

function resizeCanvas() {
  const wrap = $('canvasWrap');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = wrap.clientWidth * dpr;
  canvas.height = wrap.clientHeight * dpr;
  canvas.style.width = wrap.clientWidth + 'px';
  canvas.style.height = wrap.clientHeight + 'px';
}
window.addEventListener('resize', resizeCanvas);
window.addEventListener('orientationchange', () => setTimeout(resizeCanvas, 200));

function worldToScreen(wx, wy) {
  return { x: (wx - State.camX) * scale, y: (wy - State.camY) * scale };
}
function screenToWorld(sx, sy) {
  return { x: sx / scale + State.camX, y: sy / scale + State.camY };
}

function updateCamera() {
  scale = canvas.height / C.WORLD_HEIGHT;
  let fx = C.WORLD_WIDTH / 2;
  if (State.projectiles.length) {
    fx = State.projectiles[0].x;
  } else {
    const w = activeWorm();
    if (w) fx = w.rx !== undefined ? w.rx : w.x;
  }
  const viewW = canvas.width / scale;
  State.camX = clamp(fx - viewW / 2, 0, Math.max(0, C.WORLD_WIDTH - viewW));
  State.camY = 0;
}

// ----------------------------------------------------------------------------
// Helpers for the active worm
// ----------------------------------------------------------------------------
function activeWorm() {
  return State.worms.find((w) => w.id === State.activeWormId) || null;
}
function canControl() {
  const w = activeWorm();
  return !!w && w.alive && State.phase === 'aiming' && !State.paused;
}

// ----------------------------------------------------------------------------
// Main loop
// ----------------------------------------------------------------------------
function loop() {
  requestAnimationFrame(loop);
  if (!State.started) return;
  updateCamera();
  stepLocal();
  draw();
}
requestAnimationFrame(loop);

function stepLocal() {
  for (const w of State.worms) {
    if (w.rx === undefined) { w.rx = w.x; w.ry = w.y; }
    w.rx += (w.x - w.rx) * 0.4;
    w.ry += (w.y - w.ry) * 0.4;
  }

  if (canControl()) {
    if (heldActs.has('aimUp')) adjustAim(activeFacing() >= 0 ? -0.035 : 0.035);
    if (heldActs.has('aimDown')) adjustAim(activeFacing() >= 0 ? 0.035 : -0.035);
    if (State.charging) {
      State.power = Math.min(100, State.power + 1.5);
      $('powerBar').style.width = State.power + '%';
    }
  }

  for (const p of State.particles) {
    p.vy += 0.25;
    p.x += p.vx; p.y += p.vy;
    p.life--;
  }
  State.particles = State.particles.filter((p) => p.life > 0);
  for (const t of State.tracers) t.life--;
  State.tracers = State.tracers.filter((t) => t.life > 0);
}

function activeFacing() {
  const w = activeWorm();
  return w ? w.facing : 1;
}

function draw() {
  const g = ctx.createLinearGradient(0, 0, 0, canvas.height);
  g.addColorStop(0, '#1b3a5c');
  g.addColorStop(0.7, '#2d5a7a');
  g.addColorStop(1, '#3f7a8c');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const waterTop = worldToScreen(0, C.WORLD_HEIGHT).y;
  ctx.fillStyle = 'rgba(40,120,180,0.5)';
  ctx.fillRect(0, waterTop, canvas.width, canvas.height - waterTop);

  if (State.terrainCanvas) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      State.terrainCanvas,
      State.camX, State.camY, canvas.width / scale, canvas.height / scale,
      0, 0, canvas.width, canvas.height
    );
  }

  drawTracers();
  drawWorms();
  drawProjectiles();
  drawParticles();
  if (canControl()) drawAim();
}

function drawWorms() {
  for (const w of State.worms) {
    if (!w.alive) continue;
    const s = worldToScreen(w.rx, w.ry);
    const ww = C.WORM_WIDTH * scale;
    const wh = C.WORM_HEIGHT * scale;
    const cx = s.x;
    const top = s.y;
    const color = C.TEAM_COLORS[w.team % C.TEAM_COLORS.length];

    ctx.fillStyle = color;
    roundRect(ctx, cx - ww / 2, top, ww, wh, 4 * scale);
    ctx.fill();

    ctx.fillStyle = '#fff';
    const ex = w.facing >= 0 ? cx + ww * 0.05 : cx - ww * 0.05;
    ctx.beginPath();
    ctx.arc(ex - 1.2 * scale, top + wh * 0.32, 1.6 * scale, 0, 7);
    ctx.arc(ex + 1.8 * scale, top + wh * 0.32, 1.6 * scale, 0, 7);
    ctx.fill();
    ctx.fillStyle = '#111';
    ctx.beginPath();
    ctx.arc(ex - 1.2 * scale + w.facing * 0.6 * scale, top + wh * 0.32, 0.8 * scale, 0, 7);
    ctx.arc(ex + 1.8 * scale + w.facing * 0.6 * scale, top + wh * 0.32, 0.8 * scale, 0, 7);
    ctx.fill();

    if (w.id === State.activeWormId) {
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.moveTo(cx, top - 14 * scale);
      ctx.lineTo(cx - 5 * scale, top - 24 * scale);
      ctx.lineTo(cx + 5 * scale, top - 24 * scale);
      ctx.closePath();
      ctx.fill();
    }

    const barW = Math.max(34, ww * 2.6);
    const barY = top - 12 * scale;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(cx - barW / 2, barY, barW, 5);
    ctx.fillStyle = color;
    ctx.fillRect(cx - barW / 2, barY, barW * (w.hp / C.WORM_MAX_HP), 5);
    ctx.fillStyle = '#fff';
    ctx.font = '11px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText(`${w.name} ${w.hp}`, cx, barY - 3);

    if (w.id === State.activeWormId) {
      const aim = (State.localAim !== null) ? State.localAim : w.aim;
      const bx = cx;
      const by = top + wh / 2;
      ctx.strokeStyle = '#ffffffcc';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(bx + Math.cos(aim) * 16, by + Math.sin(aim) * 16);
      ctx.stroke();
    }
  }
}

function drawProjectiles() {
  for (const p of State.projectiles) {
    const s = worldToScreen(p.x, p.y);
    ctx.fillStyle = p.weapon === 'grenade' ? '#3fae3f' : '#222';
    ctx.beginPath();
    ctx.arc(s.x, s.y, 4 * scale, 0, 7);
    ctx.fill();
    ctx.fillStyle = '#ffcf33';
    ctx.beginPath();
    ctx.arc(s.x, s.y, 1.6 * scale, 0, 7);
    ctx.fill();
  }
}

function drawParticles() {
  for (const p of State.particles) {
    const s = worldToScreen(p.x, p.y);
    ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(s.x, s.y, p.r * scale, 0, 7);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawTracers() {
  for (const t of State.tracers) {
    const a = worldToScreen(t.x1, t.y1);
    const b = worldToScreen(t.x2, t.y2);
    ctx.globalAlpha = t.life / 8;
    ctx.strokeStyle = '#fff6c0';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawAim() {
  const w = activeWorm();
  if (!w) return;
  const aim = State.localAim !== null ? State.localAim : w.aim;
  const ch = worldToScreen(w.rx + Math.cos(aim) * 60, w.ry + C.WORM_HEIGHT / 2 + Math.sin(aim) * 60);
  ctx.strokeStyle = '#ffffff66';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(ch.x, ch.y, 6, 0, 7);
  ctx.moveTo(ch.x - 10, ch.y); ctx.lineTo(ch.x + 10, ch.y);
  ctx.moveTo(ch.x, ch.y - 10); ctx.lineTo(ch.x, ch.y + 10);
  ctx.stroke();

  const wpn = C.WEAPONS[State.weapon];
  if (wpn && wpn.kind === 'projectile' && State.power > 0) {
    const speed = State.power * wpn.speedFactor;
    let px = w.rx + Math.cos(aim) * (C.WORM_WIDTH + 4);
    let py = w.ry + C.WORM_HEIGHT / 2 + Math.sin(aim) * (C.WORM_WIDTH + 4);
    let vx = Math.cos(aim) * speed;
    let vy = Math.sin(aim) * speed;
    ctx.fillStyle = '#ffffffaa';
    for (let i = 0; i < 70; i++) {
      vy += C.GRAVITY * wpn.gravity;
      if (wpn.affectedByWind) vx += State.wind;
      px += vx; py += vy;
      if (px < 0 || px > C.WORLD_WIDTH || py > C.WORLD_HEIGHT) break;
      if (i % 3 === 0) {
        const sp = worldToScreen(px, py);
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, 1.5, 0, 7);
        ctx.fill();
      }
    }
  }
}

function roundRect(c, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

// ----------------------------------------------------------------------------
// Particles
// ----------------------------------------------------------------------------
function spawnExplosionParticles(x, y, r) {
  const n = Math.min(40, Math.round(r));
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = Math.random() * r * 0.18;
    State.particles.push({
      x, y,
      vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 1,
      r: 1 + Math.random() * 3,
      life: 20 + Math.random() * 20, maxLife: 40,
      color: ['#ff8c2a', '#ffd23f', '#ff5a3c', '#7a4a2a'][Math.floor(Math.random() * 4)],
    });
  }
}
function spawnPuff(x, y, n = 8) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    State.particles.push({
      x, y, vx: Math.cos(a) * 1.5, vy: Math.sin(a) * 1.5 - 0.5,
      r: 1 + Math.random() * 2, life: 12, maxLife: 12, color: '#cccccc',
    });
  }
}

// ----------------------------------------------------------------------------
// HUD
// ----------------------------------------------------------------------------
function renderWeaponChips() {
  const box = $('weaponBox');
  box.innerHTML = '';
  C.WEAPON_ORDER.forEach((id) => {
    const wpn = C.WEAPONS[id];
    const chip = document.createElement('span');
    chip.className = 'wchip' + (id === State.weapon ? ' active' : '');
    chip.textContent = wpn.name;
    chip.addEventListener('click', () => selectWeapon(id));
    box.appendChild(chip);
  });
}

function updateHud() {
  $('timerVal').textContent = State.timeLeft;
  const arrow = $('windArrow');
  const mag = State.windMax ? Math.abs(State.wind) / State.windMax : 0;
  arrow.textContent = State.wind >= 0 ? '→' : '←';
  arrow.style.opacity = 0.3 + 0.7 * mag;
  arrow.style.color = mag > 0.6 ? '#e6394b' : '#e6edf3';
  $('windVal').textContent = ` ${Math.round(mag * 10)}`;
  if (!State.charging) $('powerBar').style.width = State.power + '%';
  renderTeamScores();
}

function renderTeamScores() {
  const box = $('teamScores');
  const teams = {};
  for (const w of State.worms) {
    if (!teams[w.team]) teams[w.team] = { hp: 0, alive: 0 };
    if (w.alive) { teams[w.team].hp += w.hp; teams[w.team].alive++; }
  }
  box.innerHTML = '';
  Object.keys(teams).forEach((tk) => {
    const t = teams[tk];
    const color = C.TEAM_COLORS[tk % C.TEAM_COLORS.length];
    const maxHp = State.wormsPerTeam * C.WORM_MAX_HP;
    const row = document.createElement('div');
    row.className = 'team-row';
    row.innerHTML = `<span class="dot" style="background:${color}"></span>` +
      `<div class="bar"><div style="width:${Math.min(100, (t.hp / maxHp) * 100)}%;background:${color}"></div></div>` +
      `<span>${t.alive}🪱</span>`;
    box.appendChild(row);
  });
}

// ----------------------------------------------------------------------------
// Input: aim / fire / weapon / walk
// ----------------------------------------------------------------------------
function adjustAim(delta) {
  if (State.localAim === null) { const w = activeWorm(); State.localAim = w ? w.aim : 0; }
  State.localAim += delta;
  sendInput({ type: 'aim', aim: State.localAim });
}

function selectWeapon(id) {
  if (!canControl()) return;
  State.weapon = id;
  sendInput({ type: 'weapon', weapon: id });
  renderWeaponChips();
}

function setWalk(dir) {
  if (State.walkDir === dir) return;
  State.walkDir = dir;
  sendInput({ type: 'walk', dir });
}

function startCharge() {
  if (!canControl()) return;
  if (!State.charging) { State.charging = true; State.power = 0; }
}

function fire() {
  if (!State.charging) return;
  State.charging = false;
  if (!canControl()) { State.power = 0; $('powerBar').style.width = '0%'; return; }
  const w = activeWorm();
  const aim = State.localAim !== null ? State.localAim : (w ? w.aim : 0);
  sendInput({ type: 'fire', power: State.power, aim });
  State.power = 0;
  $('powerBar').style.width = '0%';
}

// ----------------------------------------------------------------------------
// Keyboard (desktop)
// ----------------------------------------------------------------------------
document.addEventListener('keydown', (e) => {
  if (!canControl()) {
    // allow Enter/Space to dismiss the pass overlay
    if (!$('passOverlay').classList.contains('hidden') && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      $('passStart').click();
    }
    return;
  }
  const w = activeWorm();
  if (!w) return;
  if (State.localAim === null) State.localAim = w.aim;

  switch (e.key) {
    case 'ArrowLeft': case 'a': case 'A': setWalk(-1); break;
    case 'ArrowRight': case 'd': case 'D': setWalk(1); break;
    case 'ArrowUp': case 'w': case 'W': e.preventDefault(); adjustAim(w.facing >= 0 ? -0.05 : 0.05); break;
    case 'ArrowDown': case 's': case 'S': e.preventDefault(); adjustAim(w.facing >= 0 ? 0.05 : -0.05); break;
    case 'Enter': sendInput({ type: 'jump' }); break;
    case ' ': e.preventDefault(); startCharge(); break;
    case '1': selectWeapon('bazooka'); break;
    case '2': selectWeapon('grenade'); break;
    case '3': selectWeapon('shotgun'); break;
    case '4': selectWeapon('mine'); break;
  }
});

document.addEventListener('keyup', (e) => {
  switch (e.key) {
    case 'ArrowLeft': case 'a': case 'A': if (State.walkDir === -1) setWalk(0); break;
    case 'ArrowRight': case 'd': case 'D': if (State.walkDir === 1) setWalk(0); break;
    case ' ': if (State.charging) fire(); break;
  }
});

// Stop space/arrows from scrolling the page during play.
window.addEventListener('keydown', (e) => {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) e.preventDefault();
}, { passive: false });

// ----------------------------------------------------------------------------
// Touch / on-screen controls
// ----------------------------------------------------------------------------
const heldActs = new Set();

document.querySelectorAll('.ctl').forEach((btn) => {
  const act = btn.dataset.act;
  const down = (e) => {
    e.preventDefault();
    if (!canControl()) return;
    heldActs.add(act);
    if (act === 'left') { setWalk(-1); btn.classList.add('active'); }
    else if (act === 'right') { setWalk(1); btn.classList.add('active'); }
    else if (act === 'jump') { sendInput({ type: 'jump' }); }
    else if (act === 'fire') { startCharge(); btn.classList.add('charging'); }
    else if (act === 'aimUp' || act === 'aimDown') { btn.classList.add('active'); }
  };
  const up = (e) => {
    if (e) e.preventDefault();
    heldActs.delete(act);
    if (act === 'left' && State.walkDir === -1) setWalk(0);
    if (act === 'right' && State.walkDir === 1) setWalk(0);
    if (act === 'fire') { fire(); btn.classList.remove('charging'); }
    btn.classList.remove('active');
  };
  btn.addEventListener('pointerdown', down);
  btn.addEventListener('pointerup', up);
  btn.addEventListener('pointercancel', up);
  btn.addEventListener('pointerleave', (e) => { if (heldActs.has(act)) up(e); });
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
});

// Drag on the canvas (mouse or touch) to aim toward the pointer.
function canvasAim(clientX, clientY) {
  if (!canControl()) return;
  const w = activeWorm();
  if (!w) return;
  const rect = canvas.getBoundingClientRect();
  const sx = (clientX - rect.left) * (canvas.width / rect.width);
  const sy = (clientY - rect.top) * (canvas.height / rect.height);
  const wp = screenToWorld(sx, sy);
  State.localAim = Math.atan2(wp.y - (w.ry + C.WORM_HEIGHT / 2), wp.x - w.rx);
  sendInput({ type: 'aim', aim: State.localAim });
}

let aimingPointer = false;
canvas.addEventListener('pointerdown', (e) => { aimingPointer = true; canvasAim(e.clientX, e.clientY); });
canvas.addEventListener('pointermove', (e) => { if (aimingPointer || e.pointerType === 'mouse') canvasAim(e.clientX, e.clientY); });
window.addEventListener('pointerup', () => { aimingPointer = false; });

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
