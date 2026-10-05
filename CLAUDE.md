# Game Hub (遊戲入口主控制器)

One Node process on the Windows test machine: serves the portal page (the site is called 更萊姆遊戲: config `title`, also the page's built-in default) that lists every game with live status, starts/stops/restarts the games it manages, restarts crashed or unresponsive ones, and takes a game down while `maintenance.txt` is in its folder. Sibling project of `../BnB` (水球大亂鬥), which it manages via BnB's `/healthz` (`version`, `online`, `playing`).

## Constraints
- Node.js 22.18.0 (the test machine), zero runtime dependencies: `scripts/build.mjs` bundles everything into `dist/hub.js`. Don't add npm runtime deps.
- Maintenance is switched only by the `maintenance.txt` file (any letter case) in a game's folder; the user decided against admin-page buttons for it. Its text is the portal notice. The hub waits while `/healthz` reports `playing > 0` (max 15 min).
- Games run detached with stdout/stderr written straight to `logs/<id>.log`; `hub-state.json` keeps each game's wanted state and pid so a restarted hub adopts running games (adoption requires the pid to own the game's port). Never make the hub kill games when it exits.
- `.bat` files stay plain ASCII with CRLF (`scripts/package.mjs` enforces it); Chinese goes in `deploy/README-DEPLOY.txt`. `install-autostart.bat` registers the scheduled task "Game Hub" via PowerShell `Register-ScheduledTask` as the installing admin's own account with S4U logon (no stored password, starts at boot without a logon, no time limit), then checks the task is still Running before saying Done. Not SYSTEM: on the test machine SYSTEM could not open the game folders (the task ended with result 1 and wrote no log).
- `hub.config.json` (live config, has the admin password) is gitignored and never in the package; the hub creates it from `hub.config.example.json` with a random password on first run. Keep internal machine details (IPs, other projects' names) out of committed files: the BnB repo is public, and this one may be too.
- On the test machine the hub listens on 4300 (a free port the user checked there); 8080 is already nginx's.
- The game list is the `games` array of `hub.config.json` (the user's "one JSON"): the page draws whatever `/api/status` returns, so adding a game is a config entry plus its thumbnail, never a page change. Don't hard-code games in the page.
- Thumbnails: `image` names a file in `assets/` (200 x 200), served at `/assets/<file>?v=<mtime>`. Only `assets/bnb.png` is committed (drawn by `BnB`'s own pixel-art code); other games' pictures carry internal names and stay out of git.
- The portal is black-and-white cyberpunk on purpose: greys plus one colour, the green blinking light of a running game (the user asked for it); other states are told apart by fill / outline / hazard stripes / motion, thumbnails grey until a playable game is hovered. No light theme. The cards show no running time (the user removed it) and the portal has no GitHub links.

## Commands
- `npm run dev` (reads ./hub.config.json), `npm test`, `npm run typecheck`, `npm run package` → `release/game-hub/`

## Layout
- `src/game.ts` state machine per game (running / starting / unresponsive / stopping / stopped / crashed / draining / maintenance / external / offline)
- `src/hub.ts` all games + `hub-state.json`; `src/server.ts` page + `/api/status` (public) + admin API (`x-hub-key` header, lockout after 8 wrong passwords per 10 min)
- `public/index.html` the portal (vanilla JS, rebuilds only cards whose data changed and reuses each thumbnail node)
- `assets/` thumbnails, copied into the package by `scripts/package.mjs`
