# 🪱 Worms Emulator — Pass &amp; Play

A local, turn-based **artillery game** in the spirit of *Worms* — destructible
terrain, gravity-and-wind projectiles, and last-team-standing mayhem. Everyone
plays on **one device**: pass the phone (or tablet/laptop) around and take turns.

No server, no accounts, no internet required during play — it's a single static
web page that runs entirely in the browser.

![play in the browser](https://img.shields.io/badge/play-in%20browser-46c93a) ![no dependencies](https://img.shields.io/badge/dependencies-none-3da6ff)

## Features

- **Local pass-and-play (hot-seat)** for 2–6 teams on a single device.
- Between turns, a **"pass the phone"** screen names the next player so handing the
  device over is clean and nobody peeks/acts early.
- **Touch controls** for phones and tablets, plus full keyboard + mouse on desktop.
- **Fully destructible terrain** — every explosion carves a real crater.
- **Physics**: gravity, wind, knockback, fall damage, and worms that drown if they
  fall in the water.
- **Four weapons**: 🚀 Bazooka, 💣 Grenade (bounces, timed fuse), 🔫 Shotgun
  (hitscan), and ✈️ Air Strike.
- Configurable number of teams and worms-per-team, custom team names, turn timer,
  wind indicator, health bars and a live scoreboard.

## How to play

Open the page, choose how many teams and worms each, name the teams, and hit
**Start Game**. Each turn the screen says whose go it is — hand the device over,
they tap **Start Turn**, then:

**On a phone/tablet (touch):**
- ◀ ▶ buttons to walk, **JUMP** to jump.
- Drag on the battlefield to **aim** (or use the ▲ ▼ buttons to fine-tune).
- Hold the **FIRE** button to charge power, release to shoot.
- Tap a weapon name in the top bar to switch weapons.

**On a desktop (keyboard + mouse):**

| Action | Keys |
| --- | --- |
| Move | `←` `→` or `A` / `D` |
| Jump | `Enter` |
| Aim | `↑` `↓` or move the **mouse** |
| Fire | hold **`Space`** to charge power, release to shoot |
| Weapons | `1` Bazooka · `2` Grenade · `3` Shotgun · `4` Air Strike |

Watch the **wind** arrow — it pushes bazooka rockets across the map. Last team with
a worm still standing wins.

## Run it

The simplest way: just open `index.html` in a browser. To serve it locally with a
tiny built-in server (handy on phones via your LAN), with **no dependencies to
install**:

```bash
npm start        # or: node server.js
```

Then open **http://localhost:3000** (or `http://<your-computer-ip>:3000` from a
phone on the same Wi-Fi).

Run the test suite (drives the real game simulation):

```bash
npm test
```

## Host it for free on GitHub Pages

Because it's a static site at the repository root, you can publish it with GitHub
Pages and get a permanent URL you can open on any phone:

1. Push this to your `main` branch.
2. In the repo: **Settings → Pages → Build and deployment → Deploy from a branch**,
   pick `main` and the `/ (root)` folder, save.
3. After a minute it's live at `https://<your-username>.github.io/worms-emulator/`.

Open that link on the device you'll pass around — done.

## Project layout

```
index.html           The whole game UI (setup screen, canvas, touch controls)
style.css            Styling, including the mobile/touch layout
client.js            Browser glue: setup, rendering, input, pass-the-phone flow
src/game.js          The game simulation (physics, turns, weapons) — runs in the
                     browser for local play, and under Node for the tests
shared/constants.js  Tunable constants (world size, gravity, weapons, …)
shared/terrain.js    Deterministic, destructible terrain
server.js            Optional zero-dependency static file server for `npm start`
test/smoke.test.js   End-to-end test of the simulation
```

## License

MIT
