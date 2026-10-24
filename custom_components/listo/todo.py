"""Todo platform exposing the shared list as a native todo.listo entity.

This makes the list usable from the HA todo card, todo.* services,
Assist voice control and automations — all backed by the same store
as the mobile app.
"""

from __future__ import annotations

from homeassistant.components.todo import (
    TodoItem,
    TodoItemStatus,
    TodoListEntity,
    TodoListEntityFeature,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, SIGNAL_UPDATED
from .data import STATUS_ACTIVE, STATUS_DONE, ListoData


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Create the shared-list todo entity."""
    data: ListoData = hass.data[DOMAIN]["data"]
    async_add_entities([ListoTodoList(data, entry)])


class ListoTodoList(TodoListEntity):
    """The shared grocery list as a standard todo entity."""

    _attr_has_entity_name = True
    _attr_name = None  # entity name comes from the config entry title
    _attr_icon = "mdi:cart-outline"
    _attr_should_poll = False  # push updates via the dispatcher signal
    _attr_supported_features = (
        TodoListEntityFeature.CREATE_TODO_ITEM
        | TodoListEntityFeature.UPDATE_TODO_ITEM
        | TodoListEntityFeature.DELETE_TODO_ITEM
        | TodoListEntityFeature.SET_DESCRIPTION_ON_ITEM
    )

    def __init__(self, data: ListoData, entry: ConfigEntry) -> None:
        """Bind the entity to the shared list and the config entry."""
        self._data = data
        self._attr_unique_id = entry.entry_id
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name="Listo",
        )

    @property
    def todo_items(self) -> list[TodoItem]:
        """Current store items mapped to HA TodoItem objects."""
        return [
            TodoItem(
                uid=it["uid"],
                summary=it["summary"],
                description=it.get("description") or None,
                status=(
                    TodoItemStatus.COMPLETED
                    if it["status"] == STATUS_DONE
                    else TodoItemStatus.NEEDS_ACTION
                ),
            )
            for it in self._data.items
        ]

    async def async_added_to_hass(self) -> None:
        """Subscribe to list changes to refresh the entity state."""
        self.async_on_remove(
            async_dispatcher_connect(self.hass, SIGNAL_UPDATED, self._handle_update)
        )

    @callback
    def _handle_update(self) -> None:
        """Push the new state whenever the store changes."""
        self.async_write_ha_state()

    async def async_create_todo_item(self, item: TodoItem) -> None:
        """Handle todo.add_item (dashboard card, voice, automations)."""
        await self._data.async_add(item.summary, item.description or "")

    async def async_update_todo_item(self, item: TodoItem) -> None:
        """Handle rename, note and check/uncheck from the todo card."""
        await self._data.async_update(
            item.uid,
            summary=item.summary,
            status=(
                STATUS_DONE
                if item.status == TodoItemStatus.COMPLETED
                else STATUS_ACTIVE
            ),
            description=item.description,
        )

    async def async_delete_todo_items(self, uids: list[str]) -> None:
        """Handle item deletion from the todo card (single store write)."""
        await self._data.async_remove(uids)
