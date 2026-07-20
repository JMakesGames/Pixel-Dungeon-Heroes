# Pixel Dungeon Heroes - Online PvP Server (v3)

A real, working Node.js + Socket.IO server for online PvP, plus the game
client that connects to it. This is a separate, standalone multiplayer arena
mode from the single-player campaign file — it does not share code with it.

## What changed in this version (v4)

Two friends joining the same lobby name/password still didn't start a match,
even with ranked Quick Match (which needs no lobby setup at all). Since both
paths failed together, the most likely cause is the connection itself never
succeeding - and my previous client gave up retrying after ~8 seconds, which
is shorter than the 20-60 second cold-start wake-up time on free hosting
tiers like Glitch/Render. Fixes:

- **The page now retries connecting forever** (with backoff) instead of
  giving up after a handful of attempts, and tells you plainly it's still
  trying, including a note about cold starts, instead of going silent.
- **An automatic `/health` check** now runs the moment the page loads and
  shows a second line under the connection status: if that check fails, the
  server itself isn't responding at that URL at all - a deployment problem,
  not a bug in the game logic - and no amount of client-side fixing will
  help until the server is actually reachable.
- **The lobby screen now makes the READY UP step impossible to miss** -
  bold warning text, a bigger button, and live "✓ READY" / "… NOT READY YET"
  per player. If you tested before this fix, it's also possible one of you
  simply hadn't clicked Ready yet, since joining a lobby does not start the
  match by itself - only Quick Match auto-starts.

### How to tell which problem you actually have
Open your deployed URL and look at the two status lines at the top:
1. If the **health check line turns red** ("Server HTTP check FAILED") -
   the server process itself isn't running/reachable. Check your host's
   dashboard (Glitch/Render/etc.) for a crashed build or a sleeping app, and
   look at its logs.
2. If the **health check is green** but the connection status stays yellow
   ("still trying to reach the server") for more than ~30 seconds - it's a
   websocket-specific issue with that host; this version now falls back to
   polling, which should resolve it.
3. If both go green ("Connected ✓") - the connection is fine, and the
   remaining step is making sure every player in the lobby actually clicks
   READY UP, which is now much harder to miss.


**Fixed: create/join match not working.** The root cause was that lobby
names were matched with exact, case-sensitive string comparison, so "Squad1"
and "squad1" (or a stray trailing space from typing on a phone) were treated
as two different lobbies. Lobby names are now trimmed and lowercased before
being compared, so "Squad1", "squad1 ", and "SQUAD1" all land in the same
match. On top of that, the client now shows a clear connection status banner
("Connected ✓" / "Could not reach the server: ...") and disables the
Create/Join/Quick Match buttons until the socket is actually connected — so
if something is wrong, you'll see it immediately instead of a button that
silently does nothing. If you deployed the old version, redeploy using the
files in this zip.

**New: Ranked 1v1 Quick Match.** Click "FIND MATCH" and you're placed in a
queue; the moment a second person also queues, you're both automatically
dropped into a fresh 1v1 arena with no lobby name or password needed.

**New: walls in the arena mix horizontal and vertical segments** instead of
only horizontal strips, per your last request.

## What's in this folder
- `server.js` — the game server (Express + Socket.IO)
- `package.json` — dependencies
- `public/index.html` — the game client, served automatically by the server

## Important limitation to know up front
Each client reports its own hits to the server (a "trusted peer" model).
That's fine for playing with friends, but a determined person could
technically cheat by editing the browser console. Movement, HP, monsters,
and match end are otherwise handled by the server.

## About the main game's "Play Online" button
The single-player campaign file now has a "🌐 PLAY ONLINE" button on its
main menu. Clicking it asks for the server URL you deploy from this folder
and opens it in a new tab. It is a launch point, not a deep merge — your
campaign character's saved look, helpers, weapons, etc. do not carry over
into this arena mode. Fully merging the two into one shared codebase (same
renderer, same character data, same weapons) is a substantially larger
project than this update; happy to scope that separately if you want it.

---

## Fastest path: Glitch.com (no coding tools needed, ~5 minutes)

1. Go to https://glitch.com and sign up (free, no credit card).
2. Click **New Project → glitch-hello-node** to get a blank Node project,
   then delete its default files.
3. Recreate the three files/folders from this project:
   - `server.js` — paste in this project's `server.js`
   - `package.json` — paste in this project's `package.json`
   - `public/index.html` — create the `public` folder, then this file inside
     it, and paste in this project's `public/index.html`
4. Glitch auto-installs dependencies and starts the server. Click **Preview
   → Open in New Window** to get your live URL, e.g.
   `https://your-project-name.glitch.me`.
5. Send that URL to your friends. Everyone opens it and either creates/joins
   the same lobby name, or both click "Find Match" for ranked 1v1.

Glitch's free tier sleeps after inactivity and wakes on the next visit
(takes a few seconds) — fine for casual sessions.

## More standard path: Render.com (also free, needs GitHub)
1. Push this folder to a new GitHub repository.
2. On https://render.com, click **New → Web Service**, connect that repo.
3. Build command: `npm install` — Start command: `npm start`.
4. Deploy, then share the resulting `https://your-app.onrender.com` URL.

## If you specifically want a Google URL: Google Cloud Run
1. Create a Google Cloud account/project at https://console.cloud.google.com.
2. Install the `gcloud` CLI, then from this folder run:
   ```
   gcloud run deploy pixel-dungeon-pvp --source . --platform managed --allow-unauthenticated
   ```
3. You'll get a URL like `https://pixel-dungeon-pvp-xxxxx.run.app`.

## Testing it locally first (optional, needs Node.js installed)
```
npm install
npm start
```
Then open `http://localhost:3000` in a couple of browser tabs.
