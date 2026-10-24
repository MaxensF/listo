"""Pytest bootstrap: stub the homeassistant modules the integration imports
and load data.py / categories.py as a real package so their relative imports
work outside a HA instance.

Run: python -m pytest tests/
"""

import importlib.util
import sys
import types
from pathlib import Path

LISTO_DIR = Path(__file__).resolve().parents[1] / "custom_components" / "listo"

# --- Minimal HA stubs ---------------------------------------------------------

_ha = types.ModuleType("homeassistant")
_ha.__path__ = []

_core = types.ModuleType("homeassistant.core")


class HomeAssistant:  # pragma: no cover - stub only
    """Empty stand-in: ListoData only stores the reference for dispatch."""


_core.HomeAssistant = HomeAssistant

_helpers = types.ModuleType("homeassistant.helpers")
_helpers.__path__ = []

_dispatcher = types.ModuleType("homeassistant.helpers.dispatcher")


def async_dispatcher_send(hass, signal, *args):
    """No-op: tests assert on store payloads, not signal delivery."""


def async_dispatcher_connect(hass, signal, callback):
    """Return a dummy unsubscribe callable."""
    return lambda: None


_dispatcher.async_dispatcher_send = async_dispatcher_send
_dispatcher.async_dispatcher_connect = async_dispatcher_connect

_storage = types.ModuleType("homeassistant.helpers.storage")


class Store:
    """In-memory Store replacement recording every save payload."""

    def __init__(self, data=None):
        """data = the payload async_load() should return."""
        self._data = data
        self.saved = []  # every persisted payload, in order

    async def async_load(self):
        """Return the seed payload."""
        return self._data

    async def async_save(self, data):
        """Record the payload (one entry per mutation)."""
        self._data = data
        self.saved.append(data)


_storage.Store = Store

_aiohttp_client = types.ModuleType("homeassistant.helpers.aiohttp_client")
_aiohttp_client.async_get_clientsession = lambda hass: None

_aiohttp = types.ModuleType("aiohttp")


class _ClientTimeout:  # pragma: no cover - stub only
    """Minimal aiohttp.ClientTimeout stand-in (fetch is never run)."""

    def __init__(self, total=None):
        self.total = total


_aiohttp.ClientTimeout = _ClientTimeout
_aiohttp.ClientError = Exception

sys.modules.update(
    {
        "aiohttp": _aiohttp,
        "homeassistant": _ha,
        "homeassistant.core": _core,
        "homeassistant.helpers": _helpers,
        "homeassistant.helpers.dispatcher": _dispatcher,
        "homeassistant.helpers.storage": _storage,
        "homeassistant.helpers.aiohttp_client": _aiohttp_client,
    }
)

# --- Load the integration's pure modules as a "listo" package -----------------


def _load(modname: str) -> types.ModuleType:
    """Import custom_components/listo/<modname>.py as listo.<modname>."""
    spec = importlib.util.spec_from_file_location(
        f"listo.{modname}", LISTO_DIR / f"{modname}.py"
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules[f"listo.{modname}"] = mod
    spec.loader.exec_module(mod)
    return mod


_pkg = types.ModuleType("listo")
_pkg.__path__ = [str(LISTO_DIR)]
sys.modules["listo"] = _pkg
_load("categories")
_load("const")
_load("data")
_load("recipe")
