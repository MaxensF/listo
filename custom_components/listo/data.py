"""Persistent storage for the shared grocery list.

Backed by homeassistant.helpers.storage.Store so the data survives
restarts. Three collections live in the same store file:

- items  : the shopping list (name + free-text quantity)
- dishes : the recipe catalog (name + ingredient list)
- menu   : the week's selected dishes (name + shared cooked flag)

Every mutation is persisted once and notifies subscribers through the
SIGNAL_UPDATED dispatcher signal (todo entity + SSE clients).
"""

from __future__ import annotations

import re
import uuid
from collections.abc import Iterable
from datetime import datetime, timezone
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.storage import Store

from .categories import CATEGORIES, DEFAULT_COLORS, classify, normalize, valid_color
from .const import MAX_ITEM_LENGTH, MAX_LIST_ITEMS, SIGNAL_UPDATED, VERSION

STATUS_ACTIVE = "needs_action"
STATUS_DONE = "completed"

# Aisle orders are kept per store ("Lidl" and "Carrefour" differ).
# The default store always exists; its order is stored in category_order.
DEFAULT_STORE = "Default"
MAX_STORES = 20


def _clean(text: str) -> str:
    """Trim and clamp a free-text field."""
    return text.strip()[:MAX_ITEM_LENGTH]


# A plain "<number><optional unit>" quantity: "5", "200g", "3 cuisses".
# Composite values like "5 + 200g" deliberately do NOT match.
_QTY_RE = re.compile(r"^\s*(\d+(?:[.,]\d+)?)\s*([a-zA-Zéèêàçôû%]*)\s*$", re.I)


def merge_qty(old: str, new: str) -> str:
    """Merge two free-text quantities.

    Both parseable as <number><same unit> -> summed:
    "4" + "5" = "9", "200g" + "150g" = "350g", "2 cuisses" + "3 cuisses"
    = "5 cuisses". Anything else -> appended: "5" + "200g" = "5 + 200g".
    """
    old, new = old.strip(), new.strip()
    if not new:
        return old
    if not old:
        return new
    a, b = _QTY_RE.match(old), _QTY_RE.match(new)
    if a and b and (a.group(2) or "").lower() == (b.group(2) or "").lower():
        total = float(a.group(1).replace(",", ".")) + float(
            b.group(1).replace(",", ".")
        )
        num = (
            str(int(total))
            if total == int(total)
            else str(round(total, 2)).replace(".", ",")
        )
        unit = a.group(2) or ""
        # Keep the original spacing: "200g"+"150g" -> "350g" while
        # "2 cuisses"+"3 cuisses" -> "5 cuisses".
        sep = " " if re.search(r"\d\s+\S", old) else ""
        return num + (sep + unit if unit else "")
    return f"{old} + {new}"


class ListoData:
    """Holds the shared list/dishes/menu; persists and broadcasts changes."""

    def __init__(self, hass: HomeAssistant, store: Store) -> None:
        """Attach to a HA Store; call async_load() before use."""
        self._hass = hass
        self._store = store
        self.items: list[dict[str, Any]] = []
        self.dishes: list[dict[str, Any]] = []
        self.menu: list[dict[str, Any]] = []
        self.cat_overrides: dict[str, str] = {}
        self.store_orders: dict[str, list[str]] = {
            DEFAULT_STORE: list(CATEGORIES)
        }
        self.category_order: list[str] = list(CATEGORIES)
        self.category_colors: dict[str, str] = dict(DEFAULT_COLORS)
        # User-created aisles: slug key -> display label.
        self.custom_categories: dict[str, str] = {}
        # Display-name overrides for ANY aisle (built-ins included) —
        # lets users rename e.g. "bakery" without touching its key.
        self.category_labels: dict[str, str] = {}
        # Built-in aisles the user deleted. The key stays "known" for
        # classification and can be re-added via an explicit order;
        # _fix_order just stops auto-appending it.
        self.hidden_categories: list[str] = []
        self.updated: str | None = None
        # Timestamp of the last "shopping done" run — lets other devices
        # pop a notification when someone clears the list.
        self.last_done: str | None = None
        # Items removed by that run, kept so one tap can undo it.
        self.last_removed: list[dict[str, str]] = []
        # {"name", "uids", "menu_added"} for the last menu add — lets a
        # toast undo remove exactly what that add pushed (in-memory
        # only: a restart clears it, and stale batches cannot linger).
        self.last_menu_add: dict | None = None

    @staticmethod
    def _norm_ing(ing: Any) -> dict[str, str] | None:
        """Normalize one ingredient to {"name", "qty"} (None if empty)."""
        if isinstance(ing, str):
            name, qty = _clean(ing), ""
        elif isinstance(ing, dict):
            name, qty = _clean(str(ing.get("name", ""))), _clean(
                str(ing.get("qty", ""))
            )
        else:
            return None
        return {"name": name, "qty": qty} if name else None

    async def async_load(self) -> None:
        """Load the persisted data from disk (called once at setup)."""
        data = await self._store.async_load()
        if data:
            self.items = data.get("items", [])
            self.dishes = data.get("dishes", [])
            self.menu = data.get("menu", [])
            self.cat_overrides = data.get("cat_overrides", {})
            self.custom_categories = {
                str(k): _clean(str(v))
                for k, v in data.get("custom_categories", {}).items()
                if str(k) not in CATEGORIES and str(v).strip()
            }
            self.category_labels = {
                str(k): _clean(str(v))
                for k, v in data.get("category_labels", {}).items()
                if str(k) in self._all_cats() and str(v).strip()
            }
            self.hidden_categories = [
                c
                for c in data.get("hidden_categories", [])
                if c in CATEGORIES
            ]
            self.updated = data.get("updated")
            self.last_done = data.get("last_done")
            self.last_removed = data.get("last_removed") or []
            order = [
                c
                for c in data.get("category_order", [])
                if c in self._all_cats()
            ]
            if order:
                order += [
                    c
                    for c in self._all_cats()
                    if c not in order and c not in self.hidden_categories
                ]
                self.category_order = order
            # Store orders: new-style dict, or migrate the flat order
            # into the default store.
            saved_orders = data.get("store_orders")
            if isinstance(saved_orders, dict) and saved_orders:
                self.store_orders = {
                    str(name): self._fix_order(o)
                    for name, o in saved_orders.items()
                    if isinstance(o, list) and str(name).strip()
                } or {DEFAULT_STORE: self.category_order}
            elif order:
                self.store_orders = {DEFAULT_STORE: self.category_order}
            self._sync_default_order()
            self.category_colors.update(
                {
                    k: v
                    for k, v in data.get("category_colors", {}).items()
                    if k in self._all_cats() and valid_color(v)
                }
            )
        # Normalize ingredients into {name, qty} dicts.
        for dish in self.dishes:
            dish["ingredients"] = [
                n for n in
                (self._norm_ing(i) for i in dish.get("ingredients", []))
                if n
            ]
        # Menu entries may lack the shared checked flag.
        for m in self.menu:
            m.setdefault("checked", False)

    async def _async_save(self) -> None:
        """Persist everything and notify listeners (one write per call)."""
        self.updated = datetime.now(timezone.utc).isoformat()
        await self._store.async_save(
            {
                "items": self.items,
                "dishes": self.dishes,
                "menu": self.menu,
                "cat_overrides": self.cat_overrides,
                "category_order": self.category_order,
                "store_orders": self.store_orders,
                "category_colors": self.category_colors,
                "custom_categories": self.custom_categories,
                "category_labels": self.category_labels,
                "hidden_categories": self.hidden_categories,
                "updated": self.updated,
                "last_done": self.last_done,
                "last_removed": self.last_removed,
            }
        )
        async_dispatcher_send(self._hass, SIGNAL_UPDATED)

    @staticmethod
    def _find(coll: list[dict[str, Any]], key: str, value: str) -> dict | None:
        """Return the entry whose key matches value (exact for uid)."""
        for it in coll:
            if it.get(key) == value:
                return it
        return None

    @staticmethod
    def _find_named(coll: list[dict[str, Any]], name: str) -> dict | None:
        """Return the entry whose summary/name matches (case-insensitive)."""
        low = name.lower()
        for it in coll:
            field = it.get("summary") or it.get("name") or ""
            if field.lower() == low:
                return it
        return None

    def _all_cats(self) -> list[str]:
        """Built-in aisle keys followed by the user-created ones."""
        return list(CATEGORIES) + list(self.custom_categories)

    async def async_add_category(self, label: str) -> str:
        """Create a user aisle from a free-text label; returns its slug key."""
        label = _clean(label)
        if not label:
            raise ValueError("empty category label")
        base = re.sub(r"[^a-z0-9]+", "_", normalize(label)).strip("_") or "cat"
        if base in CATEGORIES:
            base = "custom_" + base
        key, i = base, 2
        while key in self._all_cats():
            key, i = f"{base}_{i}", i + 1
        self.custom_categories[key] = label
        for order in self.store_orders.values():
            order.append(key)
        self._sync_default_order()
        self.category_colors.setdefault(key, DEFAULT_COLORS["other"])
        await self._async_save()
        return key

    async def async_remove_category(self, key: str) -> None:
        """Delete an aisle — built-ins are hidden (the key stays known
        for classification and _fix_order stops re-adding it), custom
        aisles vanish entirely. Items on the aisle fall back to
        "other"; the aisle can be restored via an explicit order."""
        if key in self.custom_categories:
            del self.custom_categories[key]
        elif key in CATEGORIES:
            if key not in self.hidden_categories:
                self.hidden_categories.append(key)
        else:
            raise ValueError("unknown category")
        for order in self.store_orders.values():
            if key in order:
                order.remove(key)
        self._sync_default_order()
        self.category_colors.pop(key, None)
        self.category_labels.pop(key, None)
        self.cat_overrides = {
            n: c for n, c in self.cat_overrides.items() if c != key
        }
        for it in self.items:
            if it.get("category") == key:
                it["category"] = "other"
        await self._async_save()

    async def async_rename_category(self, key: str, label: str) -> None:
        """Set (or clear, with an empty label) a display-name override
        for any aisle — renames keep the key so classification and
        learned overrides still apply."""
        if key not in self._all_cats():
            raise ValueError("unknown category")
        label = _clean(label)
        if label:
            self.category_labels[key] = label
        else:
            self.category_labels.pop(key, None)
        await self._async_save()

    # ---- Shopping items -----------------------------------------------------

    def _upsert_item(self, name: str, quantity: str = "") -> dict[str, Any]:
        """Add or re-activate an item in memory (no save)."""
        name = _clean(name)
        if not name:
            raise ValueError("empty item name")
        existing = self._find_named(self.items, name)
        if existing:
            existing["status"] = STATUS_ACTIVE
            if quantity:
                existing["description"] = merge_qty(
                    existing.get("description", ""), _clean(quantity)
                )
            return existing
        if len(self.items) >= MAX_LIST_ITEMS:
            raise ValueError("list is full")
        item = {
            "uid": uuid.uuid4().hex,
            "summary": name,
            "description": _clean(quantity),
            "status": STATUS_ACTIVE,
            "category": classify(name, self.cat_overrides),
        }
        self.items.append(item)
        return item

    async def async_add(self, name: str, description: str = "") -> dict[str, Any]:
        """Add an item, deduplicated by case-insensitive name.

        `description` carries the free-text quantity ("" = none).
        Raises ValueError on invalid input.
        """
        item = self._upsert_item(name, description)
        await self._async_save()
        return item

    async def async_update(
        self,
        ref: str,
        summary: str | None = None,
        status: str | None = None,
        description: str | None = None,
        category: str | None = None,
    ) -> None:
        """Rename, set quantity/aisle or (un)check an item by uid or name.

        Setting a category also records a learned override so the next
        identically-named item is classified the same way.
        """
        it = self._find(self.items, "uid", ref) or self._find_named(
            self.items, ref
        )
        if it is None:
            return
        if summary is not None:
            new = _clean(summary)
            if new and new != it["summary"]:
                clash = self._find_named(self.items, new)
                if clash is not None and clash is not it:
                    # Renaming onto an existing name: merge into that item
                    # instead of leaving two identically-named entries.
                    clash["description"] = merge_qty(
                        clash.get("description", ""), it.get("description", "")
                    )
                    clash["status"] = STATUS_ACTIVE
                    self.items.remove(it)
                else:
                    it["summary"] = new
                    it["category"] = classify(new, self.cat_overrides)
        if status in (STATUS_ACTIVE, STATUS_DONE):
            it["status"] = status
        if description is not None:
            it["description"] = _clean(description)
        if category is not None:
            if category not in self._all_cats():
                raise ValueError("unknown category")
            it["category"] = category
            self.cat_overrides[normalize(it["summary"])] = category
        await self._async_save()

    def _fix_order(self, order: Iterable[str]) -> list[str]:
        """Keep only known aisles and append any missing ones.
        An explicitly-included aisle unhides it (that is how a deleted
        built-in comes back); hidden aisles are never auto-appended."""
        order = [c for c in order if c in self._all_cats()]
        self.hidden_categories = [
            c for c in self.hidden_categories if c not in order
        ]
        return order + [
            c
            for c in self._all_cats()
            if c not in order and c not in self.hidden_categories
        ]

    def _sync_default_order(self) -> None:
        """Keep category_order = the default (or first) store's order."""
        self.category_order = self.store_orders.get(
            DEFAULT_STORE
        ) or next(iter(self.store_orders.values()), list(CATEGORIES))

    def _find_store(self, name: str) -> str | None:
        """Return the store name matching `name` (case-insensitive)."""
        low = name.lower()
        return next(
            (s for s in self.store_orders if s.lower() == low), None
        )

    async def async_add_store(
        self, name: str, order: Iterable[str] | None = None
    ) -> str:
        """Create a store and return its stored name. Its aisle order is
        `order` when provided, else a copy of the default store's."""
        name = _clean(name)
        if not name:
            raise ValueError("empty store name")
        if self._find_store(name) is not None:
            raise ValueError("store already exists")
        if len(self.store_orders) >= MAX_STORES:
            raise ValueError("too many stores")
        self.store_orders[name] = (
            self._fix_order(order) if order else list(self.category_order)
        )
        self._sync_default_order()
        await self._async_save()
        return name

    async def async_remove_store(self, name: str) -> None:
        """Delete a store (the last one is kept — a list needs an order)."""
        found = self._find_store(name)
        if found is None:
            return
        if len(self.store_orders) <= 1:
            raise ValueError("cannot remove the last store")
        del self.store_orders[found]
        self._sync_default_order()
        await self._async_save()

    async def async_set_order(
        self,
        order: Iterable[str],
        colors: dict | None = None,
        store: str | None = None,
    ) -> None:
        """Set the aisle order of one store (unknown keys are appended).
        `store` names which store the order belongs to (default store if
        omitted); `colors` optionally overrides aisle dot colors."""
        if not any(c in self._all_cats() for c in order):
            raise ValueError("empty order")
        order = self._fix_order(order)
        name = self._find_store(store) if store else None
        if store and name is None:
            raise ValueError("unknown store")
        self.store_orders[name or DEFAULT_STORE] = order
        self._sync_default_order()
        if colors:
            for cat, col in colors.items():
                if cat in self._all_cats() and valid_color(col):
                    self.category_colors[cat] = col
        await self._async_save()

    async def async_remove(
        self, refs: Iterable[str], mark_done: bool = False
    ) -> None:
        """Remove items by uid or name, persisted in a single write.
        `mark_done` records the removal as a finished shopping run —
        it also stashes the batch so async_restore_done can undo it."""
        refs_low = {r.lower() for r in refs}
        uids = set(refs)
        if mark_done:
            self.last_removed = [
                {
                    "summary": it["summary"],
                    "description": it.get("description") or "",
                }
                for it in self.items
                if it["uid"] in uids or it["summary"].lower() in refs_low
            ]
        self.items = [
            it
            for it in self.items
            if it["uid"] not in uids and it["summary"].lower() not in refs_low
        ]
        if mark_done:
            self.last_done = datetime.now(timezone.utc).isoformat()
        await self._async_save()

    async def async_restore_done(self) -> int:
        """Re-add the items cleared by the last "shopping done" run.

        Names already present are merged (not duplicated) via _upsert_item;
        the stash is consumed so a second call is a no-op."""
        count = 0
        for it in self.last_removed:
            try:
                self._upsert_item(it["summary"], it.get("description") or "")
                count += 1
            except ValueError:
                pass  # list full — skip what cannot come back
        self.last_removed = []
        await self._async_save()
        return count

    def active_items(self) -> list[dict[str, Any]]:
        """Items still to buy (the list shown in the app)."""
        return [it for it in self.items if it["status"] == STATUS_ACTIVE]

    # ---- Dish catalog ---------------------------------------------------------

    async def async_save_dish(
        self,
        name: str,
        ingredients: Iterable[str],
        source: str = "",
    ) -> dict[str, Any]:
        """Create or update a catalog dish (matched by name).

        ingredients is a list of {"name", "qty"} dicts (plain strings are
        accepted and normalized); empties are dropped, names deduplicated.
        """
        name = _clean(name)
        if not name:
            raise ValueError("empty dish name")
        ings: list[dict[str, str]] = []
        seen: set[str] = set()
        for raw in ingredients:
            ing = self._norm_ing(raw)
            if ing and ing["name"].lower() not in seen:
                seen.add(ing["name"].lower())
                ings.append(ing)
        dish = self._find_named(self.dishes, name)
        if dish is None:
            dish = {"uid": uuid.uuid4().hex, "name": name, "ingredients": []}
            self.dishes.append(dish)
        else:
            dish["name"] = name
        dish["ingredients"] = ings
        dish["source"] = _clean(source)
        await self._async_save()
        return dish

    async def async_remove_dish(self, ref: str) -> None:
        """Remove a dish from the catalog (does not touch the menu)."""
        ref_low = ref.lower()
        self.dishes = [
            d
            for d in self.dishes
            if d["uid"] != ref and d["name"].lower() != ref_low
        ]
        await self._async_save()

    # ---- Week menu -------------------------------------------------------------

    async def async_add_menu(self, name: str, push_items: bool = True) -> None:
        """Add a dish to the week's menu and push its ingredients to the list.

        Free-text names are allowed (no ingredients then). Ingredients are
        deduplicated against the current list. push_items=False restores a
        menu entry without touching the list (undoing an entry removal
        must not re-merge its quantities). Single store write.
        """
        name = _clean(name)
        if not name:
            raise ValueError("empty dish name")
        menu_added = self._find_named(self.menu, name) is None
        if menu_added:
            self.menu.append(
                {"uid": uuid.uuid4().hex, "name": name, "checked": False}
            )
        # Track which items this call actually created or re-activated
        # (merging into an existing active row is not a "push"), so the
        # undo path can remove exactly that batch and nothing else.
        pushed: list[str] = []
        dish = self._find_named(self.dishes, name)
        if dish and push_items:
            for ing in dish["ingredients"]:
                existing = self._find_named(self.items, ing["name"])
                fresh = (
                    existing is None
                    or existing["status"] != STATUS_ACTIVE
                )
                try:
                    item = self._upsert_item(
                        ing["name"], ing.get("qty", "")
                    )
                except ValueError:
                    pass  # list full: skip the rest gracefully
                else:
                    if fresh:
                        pushed.append(item["uid"])
        self.last_menu_add = {
            "name": name,
            "uids": pushed,
            "menu_added": menu_added,
        }
        await self._async_save()

    async def async_undo_menu_add(self, name: str) -> int:
        """Undo the last menu add: drop the items it pushed (only those
        still active — an item the user already finished stays) and the
        menu entry when this call added it. The caller must name the
        dish it means to undo: the slot is single and shared, so a
        newer add by another device must not be undone by accident.
        Returns items removed."""
        entry = self.last_menu_add
        if entry is None or entry.get("name", "").lower() != name.strip().lower():
            raise ValueError("nothing to undo")
        self.last_menu_add = None
        uids = set(entry.get("uids", []))
        before = len(self.items)
        self.items = [
            it
            for it in self.items
            if it["uid"] not in uids or it["status"] != STATUS_ACTIVE
        ]
        removed = before - len(self.items)
        if entry.get("menu_added"):
            low = entry.get("name", "").lower()
            self.menu = [
                m for m in self.menu if m["name"].lower() != low
            ]
        await self._async_save()
        return removed

    async def async_remove_menu(self, ref: str) -> None:
        """Remove an entry from the week's menu by uid or name."""
        ref_low = ref.lower()
        self.menu = [
            m
            for m in self.menu
            if m["uid"] != ref and m["name"].lower() != ref_low
        ]
        await self._async_save()

    async def async_set_menu_checked(self, ref: str, checked: bool) -> None:
        """Mark a menu entry as cooked/uncooked (by uid or name).

        Unlike item checks (local to each phone, for the shopper), the
        week-menu check state is shared — everyone sees which meals were
        already made.
        """
        ref_low = ref.lower()
        for m in self.menu:
            if m["uid"] == ref or m["name"].lower() == ref_low:
                m["checked"] = bool(checked)
                await self._async_save()
                return

    # ---- Payload -----------------------------------------------------------------

    def as_json(self) -> dict[str, Any]:
        """Payload returned to the mobile app."""
        return {
            "items": [
                {
                    "name": it["summary"],
                    "qty": it.get("description") or "",
                    "cat": it.get("category") or "other",
                }
                for it in self.active_items()
            ],
            "dishes": self.dishes,
            "menu": self.menu,
            "category_order": self.category_order,
            "store_orders": self.store_orders,
            "category_colors": self.category_colors,
            "custom_categories": self.custom_categories,
            "category_labels": self.category_labels,
            "version": VERSION,
            "updated": self.updated,
            "last_done": self.last_done,
        }
