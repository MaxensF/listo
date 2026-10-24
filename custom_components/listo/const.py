"""Constants for the Listo integration."""

DOMAIN = "listo"

# Integration version — keep in sync with manifest.json. Exposed to the
# app via the /list payload so Settings can show it.
VERSION = "1.4.0"

# Persistent storage (homeassistant.helpers.storage.Store)
STORAGE_VERSION = 1
STORAGE_KEY = f"{DOMAIN}_list"

# Dispatcher signal fired whenever the list changes
SIGNAL_UPDATED = f"{DOMAIN}_updated"

# Config entry keys
CONF_API_TOKEN = "api_token"

# Header carrying the optional access code on /api/listo/api/* calls
API_TOKEN_HEADER = "X-Listo-Token"

# Input limits
MAX_ITEM_LENGTH = 200
MAX_LIST_ITEMS = 500

# Static files served under /api/listo/app/ (bundled PWA).
# Keys may include subdirectories (img/, i18n/).
APP_FILES = {
    "index.html": "text/html",
    "style.css": "text/css",
    "app.js": "application/javascript",
    "i18n.js": "application/javascript",
    "i18n/fr.js": "application/javascript",
    "i18n/en.js": "application/javascript",
    "sw.js": "application/javascript",
    "jsbarcode.min.js": "application/javascript",
    "quagga.min.js": "application/javascript",
    "qrcode.min.js": "application/javascript",
    "jsqr.min.js": "application/javascript",
    "manifest.webmanifest": "application/manifest+json",
    "img/icon.svg": "image/svg+xml",
    "img/card.svg": "image/svg+xml",
    "img/camera.svg": "image/svg+xml",
    "img/settings.svg": "image/svg+xml",
    "img/refresh-accent.svg": "image/svg+xml",
    "img/check.svg": "image/svg+xml",
    "img/close.svg": "image/svg+xml",
    "img/close-muted.svg": "image/svg+xml",
    "img/edit.svg": "image/svg+xml",
    "img/link.svg": "image/svg+xml",
    "img/plus.svg": "image/svg+xml",
    "img/dish.svg": "image/svg+xml",
    "img/drag.svg": "image/svg+xml",
    "img/arrow-up.svg": "image/svg+xml",
    "img/arrow-down.svg": "image/svg+xml",
    "img/icon-192.png": "image/png",
    "img/icon-512.png": "image/png",
}
