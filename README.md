# Focus Guard

A personal, unpacked Chrome extension that keeps you focused. It blocks distracting sites by
redirecting them to a motivational wallpaper, supports **timed doses** for partially-blocked
sites, enforces a **weekday/hour focus schedule**, and makes you sit through a **30-second
reflection** before disabling it mid-schedule.

Not published anywhere — load it locally, configure it, stay focused. Everything stays on your
machine (no network calls except an optional custom wallpaper image).

## Features

- **Domain groups** — one entry per site family (e.g. `reddit.com`). Block the bare domain
  (exact host only), specific subdomains, or every subdomain via `*.domain` — all in one group.
  Entries take a bare domain, a subdomain or a pasted URL — no `https://` required — and
  matching is scheme- and www-agnostic: `example.com` covers `http`/`https` on both
  `example.com` and `www.example.com`.
- **Blocking levels**
  - `total` — 100% blocked while Focus Guard is active.
  - `partial` — the gate page asks how much free time you have: **10 / 20 / 30 minutes**.
    During the final minute, a countdown appears in the corner of the site. When time is up,
    every open tab of the group is pulled back to the block page.
- **Cooldown** — after a dose ends, re-entering the site is refused for **10 minutes**
  ("you already had your dose").
- **Whitelisted paths** — glob patterns (e.g. `/r/learn*`) that are always allowed, even for
  totally blocked sites. Paste a URL (`reddit.com/r/learn`) and only its path is kept.
- **Focus schedule** — per weekday, multiple time ranges, overnight windows allowed
  (`22:00 → 06:00`). Inside the window blocking is always on; turning it off requires a
  30-second confirmation with rotating motivational quotes, and it re-enables itself at the
  next window. Outside the window the master switch is free to flip.
- **Motivational wallpapers** — five bundled SVG scenes plus a custom image URL option.
- **Countdown overlay** with an "end session now" escape hatch for when you voluntarily
  get back to work.
- **Stats tab** — hours per day, week, month and all-time per site, grouped by domain with
  expandable subdomains, visits, share of tracked time and a one-click **Block** action that
  drafts a blocking group from any time sink you discover. All counting is local, based on
  which site is the active tab of the focused window; a "Block" quick action closes the
  find → block loop.

## Install on multiple computers (same Chrome profile)

Chrome never syncs unpacked extensions themselves — each machine needs a one-time setup:

```sh
git clone https://github.com/<you>/focus-guard.git
```

then `chrome://extensions` → Developer mode → **Load unpacked** → select the folder
(and keep Developer mode enabled so the extension survives restarts).

Everything you *configure* follows you automatically: the extension ID is pinned via a
manifest `key` (`hffobnhgmbdcecdimkncpbobbkhpokge` — same on every machine), and the
configuration lives in `chrome.storage.sync`, so blocked sites, schedule, wallpaper and
stats settings propagate to every computer signed into the same Chrome profile with sync
enabled. Change your block list on your desktop; your laptop picks it up within seconds and
rebuilds its blocking rules. Stats, active doses, cooldowns and the master/override state
stay per machine.

Notes:

- Requires the profile's Chrome sync to be enabled (the `chrome.storage.sync` data type —
  it syncs even if the "Extensions" sync toggle is off).
- Synced config is capped at 8 KB per item by Chrome — that is roughly hundreds of blocked
  groups; if a save ever exceeds it, the settings page will surface the storage error.
- To script the setup on a new machine you can also launch Chrome with
  `--load-extension=/path/to/focus-guard` instead of clicking through `chrome://extensions`.
- The RSA private key matching the pinned ID is at `~/focus-guard-extension-key.pem`
  (never commit it). It is only needed if you ever package a CRX or publish to the store;
  unpacked installs use the public key in the manifest.
- Installing this version over a pre-sync install changes the extension ID, so an earlier
  manual configuration will need to be re-entered once (the same fixed ID applies from
  now on).

## Install (load unpacked)

1. Install dev tooling (only needed for tests/lint, not for running the extension):
   ```sh
   npm install
   ```
2. Open `chrome://extensions`, enable **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. The settings page opens automatically on first install. You can reopen it anytime by
   clicking the Focus Guard toolbar icon.

## Development

```sh
npm test         # run the full unit test suite (Vitest)
npm run test:watch
npm run lint     # ESLint
npm run icons    # regenerate toolbar icons from scripts/gen-icons.js
```

The extension itself has **no build step** — Chrome loads the repo directly. All `src/lib/*`
modules are pure and covered by tests: pattern matching, schedule math, the blocking decision
truth table, DNR rule generation (including a consistency test that simulates
`declarativeNetRequest` behavior against `evaluate()`), session/cooldown state transitions,
config validation/migrations, and the page controllers.

## How it works

```
manifest.json                     MV3; permissions: declarativeNetRequest, storage, alarms, tabs
src/lib/                          Pure, tested logic shared everywhere
src/background/service-worker.js  Owns state: builds DNR redirect rules, alarms, tab sweeps
src/content/                      Countdown overlay injected into pages of an active session
src/pages/settings/               Configuration UI (the extension's "web page")
src/pages/blocked/                The wallpaper page (also handles the cooldown variant)
src/pages/gate/                   "How much free time do you have?" 10/20/30 picker
assets/wallpapers/                Bundled SVG wallpapers
```

Blocking is implemented with `declarativeNetRequest` dynamic rules that redirect matching
`main_frame` requests to `blocked.html` or `gate.html`, carrying the original URL in the
fragment (`#https://...`). The service worker reconciles desired rules from
`(config, runtimeState)` on every wake, alarm, storage change or message — all state is
absolute timestamps in `chrome.storage.local`, so restarting the browser never resets a dose
or a cooldown.

Specificity rules when several groups match the same host: exact host > wildcard; a deeper
wildcard beats a broader one; at equal specificity a `total` group wins. Sessions never
override a more specific block. Whitelist allow-rules always outrank redirects.

Open tabs converge with the rules on every sync, in both directions: tabs already sitting
on blocked sites are pulled to the block/gate pages (so turning blocking on also blocks
tabs that were open before), and tabs parked on those pages are sent back to their
original URL once it is allowed again — blocking turned off, a dose running, a path
whitelisted, a group removed. Gate pages manage their own navigation while a dose starts,
so they are left alone then.

### Stats tracking

The service worker tracks **segments**: continuous periods where a given hostname is the
active tab of the focused window. Switching between tabs of the same site merges; navigating,
switching windows (including to other apps, which reports `WINDOW_ID_NONE`) or closing the
tab closes the segment. Segments are stored as per-day keys
(`focusStats:YYYY-MM-DD` → `{host: {seconds, visits}}`), split across midnight, and
checkpointed every minute so a crash loses at most ~60 seconds. Counting continues during
doses (that is real time on site — the point is finding sinks), never counts non-`http(s)`
pages (blocked pages stop the clock), and pauses nothing on idle by design — wall-clock
focused-tab time. Day keys older than the configured retention (default 12 months) are
pruned once per day. Stats can be toggled off and cleared from the Stats tab.

## First-run verification checklist

Since this is personal software, run through this once after loading:

1. **Redirect mechanism** — add a group `total` for some domain, set a schedule window that
   includes right now (or flip the master switch on), open the site. You should land on the
   wallpaper page and the site itself should never load (check: no favicon fetch flash).
   If redirects don't work, open the service worker console at
   `chrome://extensions` → Focus Guard → *service worker* and look for
   `updating dynamic rules failed` — that would mean Chrome rejected the redirect form;
   file an issue and the fallback redirect mode can be wired in `src/lib/rules-builder.js`.
2. **Gate + dose** — set the group to `partial`, visit it, pick 10 minutes, confirm the site
   loads and the countdown appears during the last minute (temporarily lower
   `WARNING_WINDOW_MS` in `src/lib/constants.js` while testing if you like).
3. **Sweep** — with the site open in several tabs, let the dose expire: every tab should be
   redirected to the block page, and revisiting for the next 10 minutes should show the
   "already had your dose" countdown.
4. **Reflection** — inside your schedule, toggle blocking off in settings: the 30-second
   modal appears, the confirm button unlocks only at zero, and blocking resumes at the next
   window start.
5. **Open-tab convergence** — with the site open in a tab *before* turning blocking on,
   flip the master switch on: the open tab should be pulled to the block page within a
   second. Flip blocking off again (outside the schedule, or via the reflection): the
   parked tab should return to the site. Starting a dose should bring back the parked
   tabs of that group as well.
6. **Stats** — browse a few sites, switch tabs, alt-tab out and back; within a minute the
   Stats tab should show time accumulating against the right hosts (expand a domain to see
   subdomains). Verify the **Block** button on a row drafts a group on the Sites tab.
7. **Tests** — `npm test` should be fully green.

## Behavior notes

- Blocking active = inside the schedule (unless confirmed-off override) **or** the master
  switch is on outside the schedule.
- After a confirmed-off during the window, blocking returns at the next window start
  (or instantly if you toggle it back on).
- Whitelisted paths bypass blocks, gates, cooldowns and the countdown overlay.
- Incognito windows are only covered if you allow the extension in incognito
  (`chrome://extensions` → Details → Allow in incognito).
- All times are local machine time; schedule boundaries are enforced with alarms at the
  exact minute.

## Privacy

All configuration and state live in `chrome.storage.local` on your machine. The extension
makes no network requests of its own; the only optional remote fetch is your custom
wallpaper image URL, loaded by the browser as a plain `<img>`.
