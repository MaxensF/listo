"""Listo — shared household grocery list, 100% hosted on Home Assistant."""

from __future__ import annotations

import logging

from homeassistant.components import frontend
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from .const import CONF_API_TOKEN, DOMAIN, STORAGE_KEY, STORAGE_VERSION
from .data import ListoData
from .http import async_register_views

_LOGGER = logging.getLogger(__name__)

PLATFORMS = ["todo"]

PANEL_URL = "/api/listo/app/index.html"


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up storage, HTTP views, the todo entity and the sidebar panel."""
    store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
    data = ListoData(hass, store)
    await data.async_load()

    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN]["data"] = data
    hass.data[DOMAIN]["token"] = entry.data.get(CONF_API_TOKEN) or None

    async_register_views(hass)
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    _register_panel(hass)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload the todo platform and remove the sidebar panel."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        try:
            frontend.async_remove_panel(hass, DOMAIN)
        except Exception:  # noqa: BLE001 - panel removal is best-effort
            pass
        hass.data.get(DOMAIN, {}).pop("data", None)
    return unload_ok


def _register_panel(hass: HomeAssistant) -> None:
    """Add the « Listo » iframe panel to the HA sidebar (best effort)."""
    try:
        frontend.async_register_built_in_panel(
            hass,
            component_name="iframe",
            sidebar_title="Listo",
            sidebar_icon="mdi:cart-outline",
            frontend_url_path=DOMAIN,
            config={"url": PANEL_URL},
            require_admin=False,
        )
    except Exception:  # noqa: BLE001 - older HA versions may differ
        _LOGGER.warning("Could not register the Listo panel")
