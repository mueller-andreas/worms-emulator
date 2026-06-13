# 🪱 Worms Emulator

A multiplayer, turn-based **artillery game** in the spirit of *Worms* — destructible
terrain, gravity-and-wind projectiles, and last-team-standing mayhem. Runs entirely
in the browser; you and your friends just open a link and share a 4-letter room code.

![play in the browser, no install for players](https://img.shields.io/badge/play-in%20browser-46c93a) ![node](https://img.shields.io/badge/node-%E2%89%A518-3da6ff)

## Features

- **Real-time multiplayer** over WebSockets (Socket.IO) — 2 to 6 players per room.
- **Server-authoritative simulation** so nobody can cheat and everyone stays in sync.
- **Fully destructible terrain** — every explosion carves a real crater.
- **Physics**: gravity, wind, knockback, fall damage, and worms that drown if they
  fall in the water.
- **Four weapons**: 🚀 Bazooka, 💣 Grenade (bounces, timed fuse), 🔫 Shotgun
  (hitscan), and ✈️ Air Strike.
- Turn timer, wind indicator, health bars, team scoreboard, and in-game chat.

## How to play

| Action | Keys |
| --- | --- |
| Move | `←` `→` or `A` / `D` |
| Jump | `Enter` |
| Aim | `↑` `↓` (or move the **mouse**) |
| Fire | hold **`Space`** (or hold the mouse button) to charge power, release to shoot |
| Weapons | `1` Bazooka · `2` Grenade · `3` Shotgun · `4` Air Strike |
| Chat | `T` |

Watch the **wind** arrow — it pushes bazooka rockets across the map. Last team with a
worm still standing wins.

## Run it

You need [Node.js](https://nodejs.org) ≥ 18.

```bash
npm install
npm start
```

Then open **http://localhost:3000**. Enter a name, leave the room code blank to
**create** a room, and share the 4-letter code shown so friends can **join** the same
room. The host presses **Start Game** once at least 2 players are in.

Run the end-to-end test suite with:

```bash
npm test
```

## Playing together over the internet

The game needs a running Node server (a plain GitHub Pages static site can't host
WebSockets), so pick one of these:

1. **Quick & free — one player hosts + a tunnel.** Run `npm start`, then expose your
   port with a tunnel and share the public URL:
   ```bash
   npx localtunnel --port 3000     # or: cloudflared tunnel --url http://localhost:3000
   ```
2. **Same Wi-Fi / LAN.** Run `npm start` and share `http://<your-local-ip>:3000`.
3. **Deploy to a free host.** This repo includes a `render.yaml`, so you can deploy to
   [Render](https://render.com) in a couple of clicks (New → Blueprint → point it at
   this repo). It also works as-is on Railway, Fly.io, Glitch, or any host that runs a
   Node web service — the server respects the `PORT` environment variable.

## Project layout

```
server.js            Express + Socket.IO server; one game room per code
src/game.js          Authoritative game simulation (physics, turns, weapons)
shared/constants.js  Tunable constants shared by server and client
shared/terrain.js    Deterministic, destructible terrain (seed-based)
public/              Browser client (canvas renderer, input, networking)
test/smoke.test.js   End-to-end test of the full lobby → play flow
```

The terrain is generated identically on the server and every client from a single
seed, so the only per-frame network traffic is tiny entity snapshots plus crater
events — keeping it smooth even over modest connections.

## License

MIT
