'use strict';

/* global io, WormsConstants, WormsTerrain */

const C = WormsConstants;
const T = WormsTerrain;

// ----------------------------------------------------------------------------
// Networking
// ----------------------------------------------------------------------------
const socket = io();

const State = {
  myId: null,
  myTeam: null,
  roomCode: null,
  isHost: false,
  started: false,

  // world
  terrain: null, // {grid,width,height}
  terrainCanvas: null, // offscreen rendered terrain
  worms: [],
  projectiles: [],
  activeWormId: null,
  wind: 0,
  windMax: C.WIND_MAX,
  weapon: 'bazooka',
  phase: 'lobby',
  timeLeft: 0,

  // effects
  particles: [],
  tracers: [],

  // local input / aim
  charging: false,
  power: 0,
  localAim: null, // radians, controlled locally for our worm
  walkDir: 0,
  useMouseAim: false,
  mouse: { x: 0, y: 0 },

  camX: 0,
  camY: 0,
};

// ----------------------------------------------------------------------------
// DOM helpers
// ----------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const lobbyEl = $('lobby');
const gameEl = $('game');

// ----------------------------------------------------------------------------
// Lobby
// ----------------------------------------------------------------------------
$('joinBtn').addEventListener('click', join);
$('roomInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
$('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });

function join() {
  const name = $('nameInput').value.trim() || 'Worm';
  const room = $('roomInput').value.trim().toUpperCase();
  $('lobbyError').textContent = '';
  socket.emit('join', { name, room }, (res) => {
    if (!res || !res.ok) {
      $('lobbyError').textContent = (res && res.error) || 'Could not join room';
      return;
    }
    State.myId = res.you;
    State.roomCode = res.code;
    $('roomCode').textContent = res.code;
    $('waiting').classList.remove('hidden');
    $('joinBtn').disabled = true;
    $('nameInput').disabled = true;
    $('roomInput').disabled = true;
  });
}

$('startBtn').addEventListener('click', () => {
  socket.emit('start', {}, (res) => {
    if (res && !res.ok) $('lobbyError').textContent = res.error;
  });
});

socket.on('lobby', (snap) => {
  State.isHost = snap.hostId === State.myId;
  State.roomCode = snap.code;
  const me = snap.players.find((p) => p.id === State.myId);
  if (me) State.myTeam = me.team;

  const list = $('playerList');
  list.innerHTML = '';
  snap.players.forEach((p) => {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = p.teamColor;
    li.appendChild(dot);
    const label = document.createElement('span');
    label.textContent = `${p.name} (${p.teamName})${p.id === State.myId ? ' — you' : ''}`;
    li.appendChild(label);
    if (p.isHost) {
      const b = document.createElement('span');
      b.className = 'host-badge';
      b.textContent = 'HOST';
      li.appendChild(b);
    }
    list.appendChild(li);
  });

  const enough = snap.players.length >= snap.minPlayers;
  $('startBtn').classList.toggle('hidden', !(State.isHost && enough));
  $('waitMsg').textContent = State.isHost
    ? (enough ? '' : `Need at least ${snap.minPlayers} players to start.`)
    : 'Waiting for the host to start the game…';
});

// ----------------------------------------------------------------------------
// Game start / state
// ----------------------------------------------------------------------------
socket.on('gameStart', (data) => {
  State.started = true;
  State.terrain = T.generate(data.seed, data.worldW, data.worldH);
  buildTerrainCanvas();
  (data.craters || []).forEach((cr) => applyCrater(cr.x, cr.y, cr.r, false));
  State.worms = data.worms;
  State.activeWormId = data.activeWormId;
  State.wind = data.wind;
  State.windMax = data.windMax;
  State.weapon = data.currentWeapon;
  State.phase = data.phase;
  lobbyEl.classList.add('hidden');
  gameEl.classList.remove('hidden');
  resizeCanvas();
  renderWeaponChips();
});

socket.on('state', (s) => {
  // Smoothly adopt new authoritative positions.
  const prev = new Map(State.worms.map((w) => [w.id, w]));
  State.worms = s.worms.map((w) => {
    const old = prev.get(w.id);
    if (old && old.alive) {
      // keep a render position we lerp toward the authoritative one
      w.rx = old.rx !== undefined ? old.rx : w.x;
      w.ry = old.ry !== undefined ? old.ry : w.y;
    } else {
      w.rx = w.x;
      w.ry = w.y;
    }
    return w;
  });
  State.projectiles = s.projectiles;
  State.activeWormId = s.activeWormId;
  State.phase = s.phase;
  State.wind = s.wind;
  State.weapon = s.weapon;
  State.timeLeft = s.timeLeft;

  // When it's not our turn, mirror the server's aim so we don't fight it.
  if (!isMyTurn()) State.localAim = null;
  renderWeaponChips();
  updateHud();
});

socket.on('turn', (t) => {
  State.activeWormId = t.activeWormId;
  State.wind = t.wind;
  State.windMax = t.windMax;
  State.timeLeft = t.timeLeft;
  State.phase = 'aiming';
  State.charging = false;
  State.power = 0;
  State.walkDir = 0;
  State.localAim = null; // adopt server aim, then take over locally if it's us
  $('turnTeam').textContent = `${t.teamName}'s turn`;
  $('turnTeam').style.color = C.TEAM_COLORS[t.team % C.TEAM_COLORS.length];
  updateHud();
});

socket.on('weapon', (d) => { State.weapon = d.weapon; renderWeaponChips(); });

socket.on('explosion', (e) => {
  applyCrater(e.x, e.y, e.r, true);
  spawnExplosionParticles(e.x, e.y, e.r);
});

socket.on('fx', (fx) => {
  if (fx.type === 'tracer') {
    State.tracers.push({ x1: fx.x1, y1: fx.y1, x2: fx.x2, y2: fx.y2, life: 8 });
  } else if (fx.type === 'launch') {
    spawnPuff(fx.x, fx.y);
  } else if (fx.type === 'bounce') {
    spawnPuff(fx.x, fx.y, 3);
  } else if (fx.type === 'death' || fx.type === 'drown') {
    spawnExplosionParticles(fx.x, fx.y, 24);
  }
});

socket.on('gameOver', (g) => {
  const ov = $('overlay');
  ov.classList.remove('hidden');
  ov.innerHTML = '';
  const title = document.createElement('div');
  if (g.winnerName) {
    title.innerHTML = `🏆 <span style="color:${g.winnerColor}">${g.winnerName}</span> wins!`;
  } else {
    title.textContent = 'Draw — everyone wiped out!';
  }
  ov.appendChild(title);
  const btn = document.createElement('button');
  btn.textContent = 'Back to lobby';
  btn.onclick = () => location.reload();
  ov.appendChild(btn);
});

socket.on('chat', (m) => addChat(m.name, m.text, C.TEAM_COLORS[m.team % C.TEAM_COLORS.length]));
socket.on('disconnect', () => addChat('System', 'Disconnected from server.', '#e6394b'));

// ----------------------------------------------------------------------------
// Terrain rendering (offscreen canvas kept in sync with server craters)
// ----------------------------------------------------------------------------
function buildTerrainCanvas() {
  const { grid, width, height } = State.terrain;
  const cv = document.createElement('canvas');
  cv.width = width;
  cv.height = height;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(width, height);
  const data = img.data;
  for (let x = 0; x < width; x++) {
    let foundTop = false;
    for (let y = 0; y < height; y++) {
      const i = (y * width + x) * 4;
      if (grid[y * width + x]) {
        if (!foundTop) {
          // grassy crust on the surface
          data[i] = 86; data[i + 1] = 178; data[i + 2] = 64; data[i + 3] = 255;
          foundTop = true;
        } else {
          // dirt body with a little vertical shading
          const shade = 1 - Math.min(1, (y) / height) * 0.25;
          data[i] = 120 * shade; data[i + 1] = 82 * shade; data[i + 2] = 50 * shade; data[i + 3] = 255;
        }
      } else {
        data[i + 3] = 0;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  State.terrainCanvas = cv;
}

function applyCrater(x, y, r, withRim) {
  if (!State.terrain) return;
  T.carveCircle(State.terrain, x, y, r);
  const ctx = State.terrainCanvas.getContext('2d');
  // punch a transparent hole
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  if (withRim) {
    // scorched rim for visual feedback
    ctx.save();
    ctx.globalCompositeOperation = 'source-atop';
    ctx.beginPath();
    ctx.arc(x, y, r + 3, 0, Math.PI * 2);
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(20,12,8,0.55)';
    ctx.stroke();
    ctx.restore();
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
  canvas.width = wrap.clientWidth;
  canvas.height = wrap.clientHeight;
}
window.addEventListener('resize', resizeCanvas);

function worldToScreen(wx, wy) {
  return { x: (wx - State.camX) * scale, y: (wy - State.camY) * scale };
}
function screenToWorld(sx, sy) {
  return { x: sx / scale + State.camX, y: sy / scale + State.camY };
}

function updateCamera() {
  scale = canvas.height / C.WORLD_HEIGHT;
  // follow projectile if firing, else the active worm
  let fx = C.WORLD_WIDTH / 2;
  let fy = C.WORLD_HEIGHT / 2;
  if (State.projectiles.length) {
    fx = State.projectiles[0].x;
    fy = State.projectiles[0].y;
  } else {
    const w = activeWorm();
    if (w) { fx = w.rx !== undefined ? w.rx : w.x; fy = w.ry !== undefined ? w.ry : w.y; }
  }
  const viewW = canvas.width / scale;
  State.camX = clamp(fx - viewW / 2, 0, Math.max(0, C.WORLD_WIDTH - viewW));
  State.camY = 0;
}

// ----------------------------------------------------------------------------
// Main render loop
// ----------------------------------------------------------------------------
function activeWorm() {
  return State.worms.find((w) => w.id === State.activeWormId) || null;
}
function myWorm() {
  const w = activeWorm();
  return w && w.team === State.myTeam ? w : null;
}
function isMyTurn() {
  const w = activeWorm();
  return !!w && w.alive && w.team === State.myTeam && State.phase === 'aiming';
}

function loop() {
  requestAnimationFrame(loop);
  if (!State.started) return;
  updateCamera();
  stepLocal();
  draw();
}
requestAnimationFrame(loop);

function stepLocal() {
  // lerp render positions toward authoritative
  for (const w of State.worms) {
    if (w.rx === undefined) { w.rx = w.x; w.ry = w.y; }
    w.rx += (w.x - w.rx) * 0.4;
    w.ry += (w.y - w.ry) * 0.4;
  }
  // charge power locally while held
  if (State.charging && isMyTurn()) {
    State.power = Math.min(100, State.power + 1.6);
    $('powerBar').style.width = State.power + '%';
  }
  // particles
  for (const p of State.particles) {
    p.vy += 0.25;
    p.x += p.vx; p.y += p.vy;
    p.life--;
  }
  State.particles = State.particles.filter((p) => p.life > 0);
  for (const t of State.tracers) t.life--;
  State.tracers = State.tracers.filter((t) => t.life > 0);
}

function draw() {
  // sky
  const g = ctx.createLinearGradient(0, 0, 0, canvas.height);
  g.addColorStop(0, '#1b3a5c');
  g.addColorStop(0.7, '#2d5a7a');
  g.addColorStop(1, '#3f7a8c');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // water at the bottom of the world
  const waterTop = worldToScreen(0, C.WORLD_HEIGHT).y;
  ctx.fillStyle = 'rgba(40,120,180,0.5)';
  ctx.fillRect(0, waterTop, canvas.width, canvas.height - waterTop);

  // terrain
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
  if (isMyTurn()) drawAim();
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

    // body
    ctx.fillStyle = color;
    roundRect(ctx, cx - ww / 2, top, ww, wh, 4 * scale);
    ctx.fill();

    // eyes
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

    // active-worm marker
    if (w.id === State.activeWormId) {
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.moveTo(cx, top - 14 * scale);
      ctx.lineTo(cx - 5 * scale, top - 24 * scale);
      ctx.lineTo(cx + 5 * scale, top - 24 * scale);
      ctx.closePath();
      ctx.fill();
    }

    // name + health bar
    const barW = Math.max(34, ww * 2.6);
    const barY = top - 12 * scale;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(cx - barW / 2, barY, barW, 5);
    ctx.fillStyle = color;
    ctx.fillRect(cx - barW / 2, barY, barW * (w.hp / C.WORM_MAX_HP), 5);
    ctx.fillStyle = '#fff';
    ctx.font = `${Math.max(10, 11)}px system-ui`;
    ctx.textAlign = 'center';
    ctx.fillText(`${w.name} ${w.hp}`, cx, barY - 3);

    // aim barrel for the active worm
    if (w.id === State.activeWormId) {
      const aim = (w.team === State.myTeam && State.localAim !== null) ? State.localAim : w.aim;
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
  const w = myWorm();
  if (!w) return;
  const aim = State.localAim !== null ? State.localAim : w.aim;
  const start = worldToScreen(w.rx, w.ry + C.WORM_HEIGHT / 2);

  // crosshair
  const ch = worldToScreen(w.rx + Math.cos(aim) * 60, w.ry + C.WORM_HEIGHT / 2 + Math.sin(aim) * 60);
  ctx.strokeStyle = '#ffffff66';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(ch.x, ch.y, 6, 0, 7);
  ctx.moveTo(ch.x - 10, ch.y); ctx.lineTo(ch.x + 10, ch.y);
  ctx.moveTo(ch.x, ch.y - 10); ctx.lineTo(ch.x, ch.y + 10);
  ctx.stroke();

  // predicted trajectory for arc weapons
  const wpn = C.WEAPONS[State.weapon];
  if (wpn && wpn.kind === 'projectile' && State.power > 0) {
    const speed = State.power * wpn.speedFactor;
    let px = w.rx + Math.cos(aim) * (C.WORM_WIDTH + 4);
    let py = w.ry + C.WORM_HEIGHT / 2 + Math.sin(aim) * (C.WORM_WIDTH + 4);
    let vx = Math.cos(aim) * speed;
    let vy = Math.sin(aim) * speed;
    ctx.fillStyle = '#ffffffaa';
    for (let i = 0; i < 60; i++) {
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
    chip.textContent = `${wpn.key} ${wpn.name}`;
    box.appendChild(chip);
  });
}

function updateHud() {
  $('timerVal').textContent = State.timeLeft;
  const arrow = $('windArrow');
  const mag = Math.abs(State.wind) / State.windMax;
  arrow.textContent = State.wind >= 0 ? '→' : '←';
  arrow.style.opacity = 0.3 + 0.7 * mag;
  arrow.style.color = mag > 0.6 ? '#e6394b' : '#e6edf3';
  $('windVal').textContent = `${Math.round(mag * 10)}`;
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
    const row = document.createElement('div');
    row.className = 'team-row';
    row.innerHTML = `<span class="dot" style="background:${color}"></span>` +
      `<div class="bar"><div style="width:${Math.min(100, t.hp / (C.WORMS_PER_TEAM * C.WORM_MAX_HP) * 100)}%;background:${color}"></div></div>` +
      `<span>${t.alive}🪱</span>`;
    box.appendChild(row);
  });
}

function addChat(name, text, color) {
  const log = $('chatLog');
  const div = document.createElement('div');
  div.className = 'msg';
  div.innerHTML = `<span class="who" style="color:${color || '#fff'}">${escapeHtml(name)}:</span> ${escapeHtml(text)}`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ----------------------------------------------------------------------------
// Input
// ----------------------------------------------------------------------------
let lastAimSent = 0;
function sendAim() {
  const now = performance.now();
  if (now - lastAimSent < 40) return;
  lastAimSent = now;
  if (State.localAim !== null) socket.emit('input', { type: 'aim', aim: State.localAim });
}

function setWalk(dir) {
  if (State.walkDir === dir) return;
  State.walkDir = dir;
  socket.emit('input', { type: 'walk', dir });
}

document.addEventListener('keydown', (e) => {
  if (document.activeElement === $('chatInput')) {
    if (e.key === 'Enter') {
      const text = $('chatInput').value.trim();
      if (text) socket.emit('chat', { text });
      $('chatInput').value = '';
      $('chatInput').blur();
    } else if (e.key === 'Escape') {
      $('chatInput').blur();
    }
    return;
  }

  if (e.key === 't' || e.key === 'T') { e.preventDefault(); $('chatInput').focus(); return; }

  if (!isMyTurn()) return;
  const w = myWorm();
  if (!w) return;
  if (State.localAim === null) State.localAim = w.aim;

  switch (e.key) {
    case 'ArrowLeft': case 'a': case 'A':
      setWalk(-1); State.useMouseAim = false; break;
    case 'ArrowRight': case 'd': case 'D':
      setWalk(1); State.useMouseAim = false; break;
    case 'ArrowUp': case 'w': case 'W':
      e.preventDefault();
      State.useMouseAim = false;
      adjustAim(w.facing >= 0 ? -0.05 : 0.05); break;
    case 'ArrowDown': case 's': case 'S':
      e.preventDefault();
      State.useMouseAim = false;
      adjustAim(w.facing >= 0 ? 0.05 : -0.05); break;
    case 'Enter':
      socket.emit('input', { type: 'jump' }); break;
    case ' ':
      e.preventDefault();
      if (!State.charging) { State.charging = true; State.power = 0; }
      break;
    case '1': selectWeapon('bazooka'); break;
    case '2': selectWeapon('grenade'); break;
    case '3': selectWeapon('shotgun'); break;
    case '4': selectWeapon('mine'); break;
  }
});

document.addEventListener('keyup', (e) => {
  if (document.activeElement === $('chatInput')) return;
  switch (e.key) {
    case 'ArrowLeft': case 'a': case 'A':
      if (State.walkDir === -1) setWalk(0); break;
    case 'ArrowRight': case 'd': case 'D':
      if (State.walkDir === 1) setWalk(0); break;
    case ' ':
      if (State.charging) fire();
      break;
  }
});

function adjustAim(delta) {
  if (State.localAim === null) { const w = myWorm(); State.localAim = w ? w.aim : 0; }
  State.localAim += delta;
  sendAim();
}

function selectWeapon(id) {
  if (!isMyTurn()) return;
  State.weapon = id;
  socket.emit('input', { type: 'weapon', weapon: id });
  renderWeaponChips();
}

function fire() {
  State.charging = false;
  if (!isMyTurn()) { State.power = 0; return; }
  const aim = State.localAim !== null ? State.localAim : (myWorm() ? myWorm().aim : 0);
  socket.emit('input', { type: 'fire', power: State.power, aim });
  State.power = 0;
  $('powerBar').style.width = '0%';
}

// Mouse aiming + charging
canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  State.mouse.x = e.clientX - rect.left;
  State.mouse.y = e.clientY - rect.top;
  if (!isMyTurn()) return;
  const w = myWorm();
  if (!w) return;
  const wp = screenToWorld(State.mouse.x, State.mouse.y);
  const ang = Math.atan2(wp.y - (w.ry + C.WORM_HEIGHT / 2), wp.x - w.rx);
  State.localAim = ang;
  State.useMouseAim = true;
  sendAim();
});

canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  if (!isMyTurn()) return;
  if (!State.charging) { State.charging = true; State.power = 0; }
});
canvas.addEventListener('mouseup', (e) => {
  if (e.button !== 0) return;
  if (State.charging) fire();
});

// stop the page from scrolling on space/arrows during play
window.addEventListener('keydown', (e) => {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key) &&
      document.activeElement !== $('chatInput')) {
    e.preventDefault();
  }
}, { passive: false });

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
