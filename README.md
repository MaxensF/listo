# Listo

<img src="custom_components/listo/www/img/icon-192.png" alt="" align="right" height="120">

**🇬🇧 English** · [🇫🇷 Français](README.fr.md)

[![GH-downloads](https://img.shields.io/github/downloads/MaxensF/listo/total?style=flat-square)](https://github.com/MaxensF/listo/releases)
[![Open your Home Assistant instance and open this repository inside the Marketplace.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=MaxensF&repository=listo&category=integration)

A shared household grocery list, **100 % hosted on Home Assistant**, with an
**offline-first** mobile app (PWA): readable and checkable with no network in
the store, synced back when the connection returns. **EN/FR** interface.

## Features

- **Installable mobile app** (*Add to home screen*): a checklist that works
  with zero connectivity — offline additions are queued and pushed later.
- **Native `todo.listo` entity**: the same list shows up in HA's todo card →
  items can be added from the dashboard, voice (Assist), or automations.
- **Aisles & stores**: items are grouped by aisle; aisle order is defined
  per store and the list auto-sorts to match where you actually walk.
- **Quantities & editing**: every item can carry a quantity ("x2",
  "500 g") and be renamed or re-aisled in place.
- **Dishes & weekly menu**: a catalog of dishes with ingredients — adding a
  dish to the week pushes its ingredients into the list. Recipes can be
  imported from JSON-LD pages, and the catalog can be exported/imported
  as JSON.
- **Undo everywhere**: finishing the shopping, removing a dish from the
  menu and other destructive actions can be undone.
- **Loyalty cards**: stored **per device** (never sent to HA), rendered as
  EAN/UPC/Code 128/QR codes, photo-scannable, export/import backup.
- **"Shopping done" notification** on the Android app when the other person
  finishes the list.
- **Mini JSON API** (`/api/listo/api/*`), optionally protected by an access
  code set at install time.
- **No YAML**, no webhooks, no automations to create.

## Installation

### Option A — manual copy (2 min)

1. Copy `custom_components/listo/` into `/config/custom_components/listo/`
   on the HA server (Studio Code Server, Samba, File Editor…).
2. **Restart Home Assistant**.
3. **Settings → Devices & services → + Add integration** → "Listo" → leave
   the *access code* empty (or set one) → Submit.

### Option B — Marketplace (built into HA 2026.11+)

**Settings → Marketplace → Add from link** → paste this repo's GitHub URL
→ install → restart → add the integration as above. On older HA versions,
the same thing through HACS → ⋮ → *Custom repositories*.

## Usage

### On phones (the whole household)

**Recommended — the dedicated APK** (`android/`): a native WebView app that
shows up as its own entry in Tailscale *split tunneling* — Chrome and other
apps stay off the tunnel. The PWA is **bundled inside the APK**: the app
always opens, even with no network at all, showing the last synced list.
Build via the GitHub Actions workflow (artifact `listo-debug-apk`, nothing
to install locally) or Android Studio. The server URL is pre-filled from
`res/values/strings.xml` (`ha_base`) and editable in-app
(⚙ → *Home Assistant address*).

**No-build alternative**: open `http://<ha>:8123/api/listo/app/index.html`
in the browser → *Add to home screen* (the browser/WebAPK then needs to be
allowed in Tailscale split tunneling).

**⚠️ Don't open it inside the Home Assistant app**: it closes the view as
soon as connectivity drops. The app warns with a banner if that happens.

**⚙ button**: pick the language and, if an access code is configured, enter
it once (remembered on the device).

### In the store (zero network needed)

- Check items off: everything is local.
- Add an item offline: tagged as "pending", sent when back on network/VPN.
- "Shopping done": removes checked items (when offline, sync happens
  automatically at the next connected launch).

### On the Home Assistant side

- `todo.listo` works everywhere: todo card, `todo.add_item`, automations,
  Assist.
- "Listo" sidebar panel opens the app inside HA.

## API

| Endpoint | Method | Body | Role |
|---|---|---|---|
| `/api/listo/app/<file>` | GET | — | serves the PWA (whitelist) |
| `/api/listo/api/list` | GET | — | full state: items, aisles, stores, dishes, menu |
| `/api/listo/api/add` | POST | `{"item":"Lait","qty":"x2"}` | adds an item |
| `/api/listo/api/update` | POST | `{"ref":…,"name"…,"qty"…,"category"…}` | renames / sets quantity / (un)checks an item |
| `/api/listo/api/done` | POST | `{"items":["Lait"]}` or `{"all":true}` | removes items |
| `/api/listo/api/restore` | POST | — | undoes the last "shopping done" |
| `/api/listo/api/dishes` | POST | `{"name"…,"ingredients"…,"delete"…}` | dish catalog CRUD |
| `/api/listo/api/menu` | POST | `{"name"…}` / `{"remove"…}` / `{"undo":…}` | weekly menu add/remove/check |
| `/api/listo/api/categories` | POST | `{"add"…,"remove"…,"rename"…,"order"…,"store"…}` | aisles, colors and per-store order |
| `/api/listo/api/recipe` | POST | `{"url":"…"}` | imports ingredients from a JSON-LD recipe page |
| `/api/listo/api/events` | GET (SSE) | — | pushes `event: list` on every change → realtime sync between devices |

If an access code is configured, all `/api/listo/api/*` routes require the
`X-Listo-Token: <code>` header or the `?token=<code>` query param (used by
the SSE stream — `EventSource` cannot send headers).

```sh
curl -X POST -H "Content-Type: application/json" \
  -H "X-Listo-Token: mycode" \
  -d '{"item":"Lait"}' http://ha:8123/api/listo/api/add
```

## Security

- Endpoints are **unauthenticated by default** (same model as `/local/`):
  with VPN-only access, the surface stays on the LAN/VPN and the worst case
  is someone editing your grocery list.
- The **optional access code** (`X-Listo-Token` header) hardens the API if
  HA becomes reachable another way. It is not HA authentication — just a
  simple shared secret, good enough for a grocery list.
- Client side: names rendered via `textContent` (no HTML injection);
  files served through a whitelist (no path traversal); no HA token is
  ever exposed to the client.
- Loyalty cards live in each device's `localStorage` only — they are never
  uploaded, synced, or logged.

## Repository layout

```
custom_components/listo/
├── manifest.json          # HA metadata (domain: listo)
├── brand/                 # icon.png + icon@2x.png shown in the HA UI (2026.3+)
├── __init__.py            # setup: store, views, panel, platform
├── config_flow.py         # UI-based setup + optional access code
├── const.py               # domain, keys, file whitelist, limits
├── categories.py          # built-in aisles + item classification
├── data.py                # persisted list (helpers.storage.Store)
├── recipe.py              # JSON-LD recipe parsing
├── todo.py                # todo.listo entity
├── http.py                # views: /api/listo/app/* + /api/listo/api/*
├── strings.json           # config flow strings (EN source)
├── translations/en.json + fr.json
└── www/                   # the bundled PWA
    ├── index.html         # markup
    ├── style.css          # mobile-first theme
    ├── app.js             # offline-first logic + sync
    ├── i18n.js            # language engine
    ├── i18n/fr.js + en.js # dictionaries
    ├── sw.js              # service worker (offline shell)
    ├── manifest.webmanifest
    └── img/ + *.min.js    # icons + bundled barcode/QR libraries

android/                     # dedicated WebView APK (Tailscale split tunneling)
├── app/src/main/java/com/listo/app/   # MainActivity, ListoJobService, PhotoProvider
├── app/src/main/res/        # icon, strings EN + values-fr (ha_base = server URL)
├── app/build.gradle, build.gradle, settings.gradle
└── ../.github/workflows/build-apk.yml  # CI build for the APK (debug)
```

## Building the Android APK

- **Locally**: open `android/` in Android Studio → *Build > Build APK(s)* →
  sideload `app-debug.apk` on phones.
- **In CI**: push the repo to GitHub → the `Build Listo APK` action
  produces the `listo-debug-apk` artifact on every push touching `android/`
  or `custom_components/listo/www/`.
- Set the server URL in `res/values/strings.xml` (`ha_base`, without a
  path) — or keep it out of the repo entirely by setting a
  `LISTO_HA_BASE` GitHub secret, which the CI patches in at build time.
  Editable afterwards in the app via ⚙ without rebuilding.
- Signing: CI decodes a persistent keystore from `KEYSTORE_BASE64` so all
  builds share one signature — APKs then install **over** previous ones
  (settings and cards survive).
- Once installed, the "Listo" app appears in Tailscale **split tunneling**
  → allow it alone; Chrome unaffected.

## Regenerating icons

```sh
python3 tools/make_icons.py   # stdlib only, 4x antialiasing
```
