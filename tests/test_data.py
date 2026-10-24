"""Unit tests for ListoData (data.py) — storage, dedup, quantity merging,
dishes and week menu. The homeassistant modules are stubbed in conftest.py;
each test drives the coroutines through asyncio.run()."""

import asyncio

import pytest

from listo.data import STATUS_ACTIVE, ListoData, merge_qty
from homeassistant.helpers.storage import Store


def make(seed=None):
    """Create a ListoData bound to an in-memory store."""
    data = ListoData(None, Store(seed))
    asyncio.run(data.async_load())
    return data


def names(data):
    """Active item names, in list order."""
    return [it["summary"] for it in data.active_items()]


# ---- merge_qty ---------------------------------------------------------------


def test_merge_qty_sums_plain_numbers():
    """'4' + '5' -> '9'."""
    assert merge_qty("4", "5") == "9"


def test_merge_qty_sums_same_unit():
    """'200g' + '150g' -> '350g' and '2 cuisses' + '3 cuisses' -> '5 cuisses'."""
    assert merge_qty("200g", "150g") == "350g"
    assert merge_qty("2 cuisses", "3 cuisses") == "5 cuisses"


def test_merge_qty_appends_mixed():
    """'5' + '200g' -> '5 + 200g'."""
    assert merge_qty("5", "200g") == "5 + 200g"


def test_merge_qty_empty_sides():
    """An empty side returns the other side."""
    assert merge_qty("", "3") == "3"
    assert merge_qty("3", "") == "3"


# ---- items -------------------------------------------------------------------


def test_add_deduplicates_case_insensitive():
    """Adding the same name twice yields a single item."""
    d = make()
    asyncio.run(d.async_add("Lait"))
    asyncio.run(d.async_add("lait"))
    assert names(d) == ["Lait"]


def test_add_merges_quantities_on_existing():
    """Re-adding merges quantities instead of overwriting them."""
    d = make()
    asyncio.run(d.async_add("Oignons", "4"))
    item = asyncio.run(d.async_add("oignons", "5"))
    assert item["description"] == "9"


def test_add_merges_mixed_quantities():
    """Numeric + weighted -> '5 + 200g'."""
    d = make()
    asyncio.run(d.async_add("Oignons", "5"))
    item = asyncio.run(d.async_add("Oignons", "200g"))
    assert item["description"] == "5 + 200g"


def test_remove_batch():
    """Several items go away in one call."""
    d = make()
    asyncio.run(d.async_add("A"))
    asyncio.run(d.async_add("B"))
    asyncio.run(d.async_add("C"))
    asyncio.run(d.async_remove(["a", "C"]))
    assert names(d) == ["B"]


def test_update_rename_reclassifies():
    """Renaming an item re-runs the aisle classifier."""
    d = make()
    asyncio.run(d.async_add("Machin"))
    item = d.active_items()[0]
    asyncio.run(d.async_update(item["uid"], summary="Tomate"))
    assert item["category"] == "produce"


def test_rename_onto_existing_merges():
    """Renaming an item onto an existing name merges instead of
    leaving two identically-named entries."""
    d = make()
    asyncio.run(d.async_add("Lait", "1"))
    asyncio.run(d.async_add("Eau", "2"))
    eau = [it for it in d.active_items() if it["summary"] == "Eau"][0]
    asyncio.run(d.async_update(eau["uid"], summary="lait"))
    assert names(d) == ["Lait"]
    assert d.active_items()[0]["description"] == "3"


def test_update_category_learns_override():
    """Setting an aisle stores a learned override for that name."""
    d = make()
    asyncio.run(d.async_add("Sauce tomate"))
    item = d.active_items()[0]
    asyncio.run(d.async_update(item["uid"], category="produce"))
    assert d.cat_overrides["sauce tomate"] == "produce"
    # Next identical name gets the learned aisle directly.
    asyncio.run(d.async_remove(["Sauce tomate"]))
    item2 = asyncio.run(d.async_add("Sauce tomate"))
    assert item2["category"] == "produce"


def test_set_order_keeps_known_categories():
    """The saved order is sanitized and missing aisles appended."""
    d = make()
    asyncio.run(d.async_set_order(["grocery", "produce"]))
    assert d.category_order[:2] == ["grocery", "produce"]
    assert "other" in d.category_order


def test_category_colors_validated_and_persisted():
    """Custom aisle colors persist; invalid values are ignored."""
    d = make()
    asyncio.run(
        d.async_set_order(
            ["grocery"],
            colors={"grocery": "#ff0000", "bad": "#123456", "grocery2": "red"},
        )
    )
    assert d.category_colors["grocery"] == "#ff0000"
    assert "bad" not in d.category_colors
    assert d.category_colors["produce"] != ""  # defaults still present
    payload = d.as_json()
    assert payload["category_colors"]["grocery"] == "#ff0000"


def test_custom_category_lifecycle():
    """Create, assign and remove a user aisle; items fall back to other."""
    import pytest

    d = make()
    key = asyncio.run(d.async_add_category("Animalerie"))
    assert d.custom_categories[key] == "Animalerie"
    assert key in d.category_order
    asyncio.run(d.async_add("Croquettes"))
    it = d.active_items()[0]
    asyncio.run(d.async_update(it["uid"], category=key))
    assert it["category"] == key
    # Removing the aisle sends its items back to "other".
    asyncio.run(d.async_remove_category(key))
    assert it["category"] == "other"
    assert key not in d.category_order
    assert "croquettes" not in d.cat_overrides  # dangling override dropped
    # Unknown keys are still rejected.
    with pytest.raises(ValueError):
        asyncio.run(d.async_remove_category("not_an_aisle"))


def test_builtin_aisle_remove_hide_readd():
    """Built-in aisles can be deleted: the key is hidden (not forgotten),
    items fall back to "other", set_order cannot resurrect it by
    accident — but an explicit order including the key re-adds it."""
    d = make()
    asyncio.run(d.async_add("Pain"))          # classifies as bakery
    asyncio.run(d.async_update(
        d.active_items()[0]["uid"], category="bakery"))
    asyncio.run(d.async_remove_category("bakery"))
    assert "bakery" in d.hidden_categories
    assert "bakery" not in d.category_order
    assert all("bakery" not in o for o in d.store_orders.values())
    assert d.active_items()[0]["category"] == "other"
    # Saving an order without the key must not re-append it.
    asyncio.run(d.async_set_order(["produce", "dairy"]))
    assert "bakery" not in d.category_order
    # …but an explicit order that names the key unhides it.
    asyncio.run(d.async_set_order(["produce", "bakery"]))
    assert "bakery" not in d.hidden_categories
    assert "bakery" in d.category_order


def test_rename_aisle_label_override():
    """Renaming any aisle stores a label override; empty label clears."""
    import pytest

    d = make()
    asyncio.run(d.async_rename_category("bakery", "Boulangerie"))
    assert d.category_labels["bakery"] == "Boulangerie"
    assert d.as_json()["category_labels"]["bakery"] == "Boulangerie"
    # Rename persists across a reload.
    d2 = ListoData(None, d._store)
    asyncio.run(d2.async_load())
    assert d2.category_labels["bakery"] == "Boulangerie"
    # Empty label drops the override.
    asyncio.run(d2.async_rename_category("bakery", ""))
    assert "bakery" not in d2.category_labels
    with pytest.raises(ValueError):
        asyncio.run(d2.async_rename_category("nope", "X"))


# ---- dishes & menu -------------------------------------------------------------


def test_dish_upsert_and_menu_adds_ingredients():
    """Adding a menu dish pushes its ingredients (with qty) to the list."""
    d = make()
    asyncio.run(
        d.async_save_dish(
            "Lasagnes",
            [{"name": "Pâtes", "qty": "1 paquet"}, {"name": "Viande hachée", "qty": "500g"}],
            "livre p.12",
        )
    )
    asyncio.run(d.async_add_menu("Lasagnes"))
    assert names(d) == ["Pâtes", "Viande hachée"]
    item = d.active_items()[1]
    assert item["description"] == "500g"
    # Menu entry exists once (dedup) and carries the dish name.
    assert [m["name"] for m in d.menu] == ["Lasagnes"]


def test_remove_menu_keeps_items():
    """Removing a menu entry does not remove bought ingredients."""
    d = make()
    asyncio.run(d.async_save_dish("Plat", [{"name": "Riz", "qty": ""}]))
    asyncio.run(d.async_add_menu("Plat"))
    asyncio.run(d.async_remove_menu("plat"))
    assert d.menu == []
    assert names(d) == ["Riz"]


def test_menu_add_undo():
    """Undo removes the pushed items and the menu entry; consumed once."""
    d = make()
    asyncio.run(
        d.async_save_dish(
            "Crozi",
            [{"name": "Reblochon", "qty": ""}, {"name": "Lardons", "qty": "200g"}],
            "",
        )
    )
    asyncio.run(d.async_add_menu("Crozi"))
    assert names(d) == ["Reblochon", "Lardons"]
    assert asyncio.run(d.async_undo_menu_add("Crozi")) == 2
    assert names(d) == []
    assert d.menu == []
    with pytest.raises(ValueError):
        asyncio.run(d.async_undo_menu_add("Crozi"))  # consumed


def test_menu_add_undo_wrong_name_refused():
    """The undo slot is shared: undoing a name that is NOT the last add
    is refused, and the real batch stays available."""
    d = make()
    asyncio.run(d.async_save_dish("A", [{"name": "Riz", "qty": ""}]))
    asyncio.run(d.async_save_dish("B", [{"name": "Oeuf", "qty": ""}]))
    asyncio.run(d.async_add_menu("A"))
    asyncio.run(d.async_add_menu("B"))
    with pytest.raises(ValueError):
        asyncio.run(d.async_undo_menu_add("A"))  # B was added last
    assert names(d) == ["Riz", "Oeuf"]
    assert asyncio.run(d.async_undo_menu_add("b")) == 1
    assert names(d) == ["Riz"]
    assert [m["name"] for m in d.menu] == ["A"]


def test_menu_add_undo_keeps_existing_items():
    """Ingredients merged into already-present rows are NOT removed —
    only what the add created goes away."""
    d = make()
    asyncio.run(d.async_add("Lait"))
    asyncio.run(
        d.async_save_dish(
            "Flan",
            [{"name": "Lait", "qty": ""}, {"name": "Oeuf", "qty": "4"}],
            "",
        )
    )
    asyncio.run(d.async_add_menu("Flan"))
    asyncio.run(d.async_undo_menu_add("Flan"))
    assert names(d) == ["Lait"]
    assert d.menu == []


def test_menu_add_undo_readd_keeps_entry():
    """A re-add of a dish already on the menu pushes nothing new; its
    undo leaves both items and entry untouched."""
    d = make()
    asyncio.run(d.async_save_dish("Plat", [{"name": "Riz", "qty": ""}]))
    asyncio.run(d.async_add_menu("Plat"))
    asyncio.run(d.async_add_menu("Plat"))  # dedup: entry exists
    assert asyncio.run(d.async_undo_menu_add("Plat")) == 0
    assert [m["name"] for m in d.menu] == ["Plat"]
    assert names(d) == ["Riz"]


def test_menu_add_no_items_restores_entry_only():
    """push_items=False re-adds the menu entry without touching the
    list — undoing an entry removal must not re-merge quantities."""
    d = make()
    asyncio.run(d.async_save_dish("Plat", [{"name": "Riz", "qty": "500g"}]))
    asyncio.run(d.async_add("Riz"))  # user added it manually before
    asyncio.run(d.async_add_menu("Plat", push_items=False))
    assert [m["name"] for m in d.menu] == ["Plat"]
    # The existing row is untouched: no dup, no merged "1000g".
    assert names(d) == ["Riz"]
    assert d.active_items()[0]["description"] == ""


def test_menu_check_is_shared_and_persisted():
    """Menu check flags live on the server-side entry (shared by devices)."""
    d = make()
    asyncio.run(d.async_add_menu("Plat"))
    assert d.menu[0]["checked"] is False
    asyncio.run(d.async_set_menu_checked("plat", True))
    assert d.menu[0]["checked"] is True
    # Toggle back by uid, unknown refs are ignored silently.
    asyncio.run(d.async_set_menu_checked(d.menu[0]["uid"], False))
    assert d.menu[0]["checked"] is False
    asyncio.run(d.async_set_menu_checked("inconnu", True))
    # Round-trip: the flag survives a store reload.
    d2 = ListoData(None, Store(d._store._data))
    asyncio.run(d2.async_load())
    assert d2.menu[0]["checked"] is False


def test_as_json_shape():
    """The app payload exposes items, dishes, menu and the aisle order."""
    d = make()
    asyncio.run(d.async_add("Tomate", "3"))
    payload = d.as_json()
    assert payload["items"] == [{"name": "Tomate", "qty": "3", "cat": "produce"}]
    assert "category_order" in payload and "dishes" in payload


def test_stores_have_independent_orders():
    """Each store keeps its own aisle order; default store = legacy order."""
    d = make()
    asyncio.run(d.async_set_order(["frozen", "produce"]))
    asyncio.run(d.async_add_store("Lidl"))
    asyncio.run(
        d.async_set_order(["grocery", "produce"], store="lidl")
    )
    assert d.store_orders["Default"][0] == "frozen"
    assert d.store_orders["Lidl"][0] == "grocery"
    # Legacy category_order tracks the default store.
    assert d.category_order == d.store_orders["Default"]


def test_store_add_remove_guards():
    """Dupes are rejected and the last store cannot be removed."""
    d = make()
    asyncio.run(d.async_add_store("Lidl"))
    try:
        asyncio.run(d.async_add_store("lidl"))
        assert False, "duplicate store should raise"
    except ValueError:
        pass
    asyncio.run(d.async_remove_store("Lidl"))
    assert list(d.store_orders) == ["Default"]
    try:
        asyncio.run(d.async_remove_store("Default"))
        assert False, "last store should raise"
    except ValueError:
        pass


def test_store_order_migration():
    """A legacy flat category_order becomes the default store's order."""
    d = make({"category_order": ["frozen", "produce"]})
    assert d.store_orders["Default"][0] == "frozen"
    assert "produce" in d.store_orders["Default"]


def test_persistence_roundtrip():
    """Data saved to the store reloads identically."""
    d = make()
    asyncio.run(d.async_add("Lait", "2"))
    payload = d._store._data
    d2 = ListoData(None, Store(payload))
    asyncio.run(d2.async_load())
    assert names(d2) == ["Lait"]


def test_last_done_stamp():
    """mark_done stamps last_done (finish shopping); plain removes do
    not, so single-item deletes never fire the done notification."""
    d = make()
    asyncio.run(d.async_add("Lait"))
    asyncio.run(d.async_remove(["Lait"]))
    assert d.last_done is None
    asyncio.run(d.async_add("Lait"))
    asyncio.run(d.async_remove(["Lait"], mark_done=True))
    assert d.last_done is not None
    assert d.as_json()["last_done"] == d.last_done


def test_restore_done_batch():
    """A finished run stashes its items; restore re-adds them once and
    consumes the stash (second call is a no-op)."""
    d = make()
    asyncio.run(d.async_add("Lait", "2"))
    asyncio.run(d.async_add("Pain"))
    asyncio.run(d.async_remove(["Lait"], mark_done=True))
    assert names(d) == ["Pain"]
    assert asyncio.run(d.async_restore_done()) == 1
    assert names(d) == ["Pain", "Lait"]
    item = [it for it in d.items if it["summary"] == "Lait"][0]
    assert item["status"] == STATUS_ACTIVE
    assert item["description"] == "2"
    # Second call: stash consumed, nothing re-added.
    assert asyncio.run(d.async_restore_done()) == 0
    # Restore merges onto a same-named item instead of duplicating.
    asyncio.run(d.async_remove(["Lait"], mark_done=True))
    asyncio.run(d.async_add("lait"))
    assert asyncio.run(d.async_restore_done()) == 1
    assert names(d).count("lait") + names(d).count("Lait") == 1
