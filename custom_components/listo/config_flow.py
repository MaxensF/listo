"""Config flow for Listo (single instance, optional access code)."""

from __future__ import annotations

import voluptuous as vol

from homeassistant.config_entries import ConfigFlow
from homeassistant.helpers.selector import (
    TextSelector,
    TextSelectorConfig,
    TextSelectorType,
)

from .const import CONF_API_TOKEN, DOMAIN


class ListoConfigFlow(ConfigFlow, domain=DOMAIN):
    """One shared list per Home Assistant instance."""

    VERSION = 1

    async def async_step_user(self, user_input=None):
        """Ask for the optional API access code, then create the entry."""
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")
        if user_input is not None:
            return self.async_create_entry(title="Listo", data=user_input)
        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Optional(CONF_API_TOKEN): TextSelector(
                        TextSelectorConfig(type=TextSelectorType.PASSWORD)
                    )
                }
            ),
        )
