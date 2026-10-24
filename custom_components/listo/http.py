"""HTTP views for the Listo integration.

Two route families under /api/listo/:

- app/<file>  : serves the bundled PWA (unauthenticated, like /local/)
- api/*       : JSON API used by the app

API views are unauthenticated (same model as HA's /local/ static files):
anyone who can reach Home Assistant may call them. An optional access
code (config flow) can gate them behind the X-Listo-Token header.
"""

from __future__ import annotations

import asyncio
import hmac
import json
from pathlib import Path
from typing import Any

from aiohttp import web

from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant
from homeassistant.helpers.dispatcher import async_dispatcher_connect

from .const import API_TOKEN_HEADER, APP_FILES, DOMAIN, SIGNAL_UPDATED
from .recipe import async_fetch_recipe

WWW_DIR = Path(__file__).parent / "www"

_registered = False

# CORS is handled automatically: HomeAssistantView sets cors_allowed=True
# on every view with requires_auth=False, which registers the OPTIONS
# preflight handlers via aiohttp_cors (needed by the Android app, which
# calls the API cross-origin from a file:// WebView).


def _data(hass: HomeAssistant) -> Any:
    """Shortcut to the shared list object (None once unloaded)."""
    return hass.data.get(DOMAIN, {}).get("data")


def _authorized(request: web.Request) -> bool:
    """Check the optional access code (no code configured -> always True).

    Accepted in the X-Listo-Token header or a ?token= query parameter
    (EventSource cannot send custom headers).
    """
    token = request.app["hass"].data.get(DOMAIN, {}).get("token")
    if not token:
        return True
    given = (
        request.headers.get(API_TOKEN_HEADER)
        or request.query.get("token")
        or ""
    )
    # Bytes on both sides: compare_digest(str) raises TypeError on
    # non-ASCII input, which would turn a weird token into a 500.
    return hmac.compare_digest(
        given.encode("utf-8", "replace"), token.encode("utf-8", "replace")
    )


def _check_auth(request: web.Request) -> None:
    """Raise 403 when the optional access code is configured and wrong."""
    if not _authorized(request):
        raise web.HTTPForbidden


def async_register_views(hass: HomeAssistant) -> None:
    """Register all views once (views survive entry reloads)."""
    global _registered
    if _registered:
        return
    _registered = True
    hass.http.register_view(ListoAppView())
    hass.http.register_view(ListoListView())
    hass.http.register_view(ListoAddView())
    hass.http.register_view(ListoDoneView())
    hass.http.register_view(ListoRestoreView())
    hass.http.register_view(ListoUpdateView())
    hass.http.register_view(ListoDishesView())
    hass.http.register_view(ListoMenuView())
    hass.http.register_view(ListoCategoriesView())
    hass.http.register_view(ListoRecipeView())
    hass.http.register_view(ListoEventsView())


class ListoAppView(HomeAssistantView):
    """Serve PWA files: GET /api/listo/app/<filename> (whitelist only)."""

    url = "/api/listo/app/{filename:.+}"
    extra_urls = ["/api/listo/app"]
    name = "api:listo:app"
    requires_auth = False

    async def get(self, request: web.Request, filename: str = "index.html"):
        """Return a bundled static file or 404 (no directory listing)."""
        if filename not in APP_FILES:
            raise web.HTTPNotFound
        path = WWW_DIR / filename
        hass: HomeAssistant = request.app["hass"]
        try:
            body = await hass.async_add_executor_job(path.read_bytes)
        except OSError:
            raise web.HTTPNotFound from None
        return web.Response(body=body, content_type=APP_FILES[filename])


class ListoListView(HomeAssistantView):
    """GET /api/listo/api/list -> {"items": [{name, note}], "updated": str}."""

    url = "/api/listo/api/list"
    name = "api:listo:list"
    requires_auth = False

    async def get(self, request: web.Request):
        """Return the current shopping list as JSON."""
        _check_auth(request)
        data = _data(request.app["hass"])
        if data is None:
            raise web.HTTPNotFound
        return web.json_response(data.as_json())


class ListoAddView(HomeAssistantView):
    """POST /api/listo/api/add with body {"item": "Milk"}."""

    url = "/api/listo/api/add"
    name = "api:listo:add"
    requires_auth = False

    async def post(self, request: web.Request):
        """Add an item; returns {"ok": true} or 400/403."""
        _check_auth(request)
        data = _data(request.app["hass"])
        if data is None:
            raise web.HTTPNotFound
        try:
            body = await request.json()
            raw = body.get("item", "")
            name = raw.strip() if isinstance(raw, str) else ""
            qty = body.get("qty")
            qty = qty if isinstance(qty, str) else ""
        except Exception:  # noqa: BLE001 - malformed JSON or types
            name = ""
            qty = ""
        if not name:
            raise web.HTTPBadRequest(text="missing item")
        try:
            await data.async_add(name, qty)
        except ValueError as exc:
            raise web.HTTPBadRequest(text=str(exc)) from exc
        return web.json_response({"ok": True})


class ListoDoneView(HomeAssistantView):
    """POST /api/listo/api/done — clear purchased items.

    {"items": [...], "finish": true} removes the items and stamps
    last_done so other devices can notify "shopping done".
    {"all": true} clears the whole list (also counts as done)."""

    url = "/api/listo/api/done"
    name = "api:listo:done"
    requires_auth = False

    async def post(self, request: web.Request):
        """Remove purchased items (by name/uid), or clear the whole list."""
        _check_auth(request)
        data = _data(request.app["hass"])
        if data is None:
            raise web.HTTPNotFound
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001 - malformed JSON
            raise web.HTTPBadRequest(text="invalid json") from None

        mark = bool(body.get("finish")) or bool(body.get("all"))
        if body.get("all"):
            await data.async_remove(
                [it["uid"] for it in data.items], mark_done=mark
            )
        else:
            refs = body.get("items")
            if not isinstance(refs, list):
                raise web.HTTPBadRequest(text="items must be a list")
            await data.async_remove(
                [str(r) for r in refs], mark_done=mark
            )
        return web.json_response({"ok": True})


class ListoRestoreView(HomeAssistantView):
    """POST /api/listo/api/restore — undo the last "shopping done" run.

    Re-adds the batch removed with finish:true; a no-op when there is
    nothing stashed (e.g. after a manual item delete)."""

    url = "/api/listo/api/restore"
    name = "api:listo:restore"
    requires_auth = False

    async def post(self, request: web.Request):
        """Restore the last cleared batch; returns {"restored": n}."""
        _check_auth(request)
        data = _data(request.app["hass"])
        if data is None:
            raise web.HTTPNotFound
        count = await data.async_restore_done()
        return web.json_response({"ok": True, "restored": count})


class ListoUpdateView(HomeAssistantView):
    """POST /api/listo/api/update — rename / set the quantity of an item.

    Body: {"ref": "<uid or name>", "name": "…", "qty": "…"} — at least one
    of name/qty must be present; qty "" clears the quantity.
    """

    url = "/api/listo/api/update"
    name = "api:listo:update"
    requires_auth = False

    async def post(self, request: web.Request):
        """Update a single item by uid or name."""
        _check_auth(request)
        data = _data(request.app["hass"])
        if data is None:
            raise web.HTTPNotFound
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001 - malformed JSON
            raise web.HTTPBadRequest(text="invalid json") from None
        ref = body.get("ref")
        if not isinstance(ref, str) or not ref:
            raise web.HTTPBadRequest(text="ref required")
        name = body.get("name")
        qty = body.get("qty")
        cat = body.get("category")
        if name is None and qty is None and cat is None:
            raise web.HTTPBadRequest(text="nothing to update")
        try:
            await data.async_update(
                ref,
                summary=name if isinstance(name, str) else None,
                description=qty if isinstance(qty, str) else None,
                category=cat if isinstance(cat, str) else None,
            )
        except ValueError as exc:
            raise web.HTTPBadRequest(text=str(exc)) from exc
        return web.json_response({"ok": True})


class ListoDishesView(HomeAssistantView):
    """POST /api/listo/api/dishes — dish catalog CRUD.

    Body {"name": "…", "ingredients": ["…"]}  -> create/update a dish
         {"name": "…", "delete": true}       -> remove it
    """

    url = "/api/listo/api/dishes"
    name = "api:listo:dishes"
    requires_auth = False

    async def post(self, request: web.Request):
        """Create, update or delete a catalog dish."""
        _check_auth(request)
        data = _data(request.app["hass"])
        if data is None:
            raise web.HTTPNotFound
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001 - malformed JSON
            raise web.HTTPBadRequest(text="invalid json") from None
        name = body.get("name")
        if not isinstance(name, str) or not name.strip():
            raise web.HTTPBadRequest(text="name required")
        if body.get("delete"):
            await data.async_remove_dish(name)
        else:
            ings = body.get("ingredients")
            if not isinstance(ings, list):
                raise web.HTTPBadRequest(text="ingredients must be a list")
            source = body.get("source")
            try:
                await data.async_save_dish(
                    name, ings, source if isinstance(source, str) else ""
                )
            except ValueError as exc:
                raise web.HTTPBadRequest(text=str(exc)) from exc
        return web.json_response({"ok": True})


class ListoMenuView(HomeAssistantView):
    """POST /api/listo/api/menu — week menu add/remove.

    Body {"name": "…"}               -> add dish to menu + ingredients
         {"undo": true}              -> undo the last add (items + entry)
         {"ref": "<uid|name>", "remove": true} -> remove a menu entry
         {"ref": "<uid|name>", "checked": bool} -> shared cooked flag
    """

    url = "/api/listo/api/menu"
    name = "api:listo:menu"
    requires_auth = False

    async def post(self, request: web.Request):
        """Add a dish to the week's menu or remove an entry."""
        _check_auth(request)
        data = _data(request.app["hass"])
        if data is None:
            raise web.HTTPNotFound
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001 - malformed JSON
            raise web.HTTPBadRequest(text="invalid json") from None
        ref = body.get("ref")
        if body.get("undo"):
            name = body.get("name")
            if not isinstance(name, str) or not name.strip():
                raise web.HTTPBadRequest(text="name required")
            try:
                removed = await data.async_undo_menu_add(name)
            except ValueError as exc:
                raise web.HTTPBadRequest(text=str(exc)) from exc
            return web.json_response({"ok": True, "removed": removed})
        if body.get("remove") or "checked" in body:
            if not isinstance(ref, str) or not ref:
                raise web.HTTPBadRequest(text="ref required")
            if body.get("remove"):
                await data.async_remove_menu(ref)
            else:
                await data.async_set_menu_checked(
                    ref, bool(body["checked"])
                )
        else:
            name = body.get("name")
            if not isinstance(name, str) or not name.strip():
                raise web.HTTPBadRequest(text="name required")
            try:
                await data.async_add_menu(
                    name, push_items=not body.get("no_items")
                )
            except ValueError as exc:
                raise web.HTTPBadRequest(text=str(exc)) from exc
        return web.json_response({"ok": True})


class ListoCategoriesView(HomeAssistantView):
    """POST /api/listo/api/categories — aisles, colors and stores.

    Body {"order": [...], "colors": {...}, "store": "X"} -> order + palette
         {"add": "Label"}      -> create a custom aisle
         {"remove": "key"}     -> delete a custom aisle
         {"add_store": "X", "order": [...]} -> create a store (order copied
                                               from the default if omitted)
         {"remove_store": "X"} -> delete a store (the last one is kept)
    """

    url = "/api/listo/api/categories"
    name = "api:listo:categories"
    requires_auth = False

    async def post(self, request: web.Request):
        """Save aisle settings or create/remove a custom aisle."""
        _check_auth(request)
        data = _data(request.app["hass"])
        if data is None:
            raise web.HTTPNotFound
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001 - malformed JSON
            raise web.HTTPBadRequest(text="invalid json") from None

        if body.get("add") is not None:
            try:
                key = await data.async_add_category(str(body["add"]))
            except ValueError as exc:
                raise web.HTTPBadRequest(text=str(exc)) from exc
            return web.json_response({"ok": True, "key": key})
        if body.get("remove") is not None:
            try:
                await data.async_remove_category(str(body["remove"]))
            except ValueError as exc:
                raise web.HTTPBadRequest(text=str(exc)) from exc
            return web.json_response({"ok": True})
        if body.get("rename") is not None:
            try:
                await data.async_rename_category(
                    str(body["rename"]), str(body.get("label") or "")
                )
            except ValueError as exc:
                raise web.HTTPBadRequest(text=str(exc)) from exc
            return web.json_response({"ok": True})
        if body.get("add_store") is not None:
            order = body.get("order")
            try:
                name = await data.async_add_store(
                    str(body["add_store"]),
                    order if isinstance(order, list) else None,
                )
            except ValueError as exc:
                raise web.HTTPBadRequest(text=str(exc)) from exc
            return web.json_response({"ok": True, "name": name})
        if body.get("remove_store") is not None:
            try:
                await data.async_remove_store(str(body["remove_store"]))
            except ValueError as exc:
                raise web.HTTPBadRequest(text=str(exc)) from exc
            return web.json_response({"ok": True})

        order = body.get("order")
        if not isinstance(order, list):
            raise web.HTTPBadRequest(text="order must be a list")
        colors = body.get("colors")
        store = body.get("store")
        try:
            await data.async_set_order(
                order,
                colors if isinstance(colors, dict) else None,
                store if isinstance(store, str) else None,
            )
        except ValueError as exc:
            raise web.HTTPBadRequest(text=str(exc)) from exc
        return web.json_response({"ok": True})


class ListoRecipeView(HomeAssistantView):
    """POST /api/listo/api/recipe — one-shot recipe import from a URL.

    Body {"url": "https://…"} -> {"name", "ingredients": [{name, qty}],
    "source"}. The page is fetched once; the client decides what to save.
    """

    url = "/api/listo/api/recipe"
    name = "api:listo:recipe"
    requires_auth = False

    async def post(self, request: web.Request):
        """Fetch the recipe page and return its parsed JSON-LD data."""
        _check_auth(request)
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001 - malformed JSON
            raise web.HTTPBadRequest(text="invalid json") from None
        url = body.get("url")
        if not isinstance(url, str):
            raise web.HTTPBadRequest(text="url required")
        try:
            return web.json_response(
                await async_fetch_recipe(request.app["hass"], url)
            )
        except ValueError as exc:
            raise web.HTTPBadRequest(text=str(exc)) from exc


def _sse(payload: dict) -> bytes:
    """Encode one Server-Sent Events message."""
    return ("event: list\ndata: " + json.dumps(payload) + "\n\n").encode()


class ListoEventsView(HomeAssistantView):
    """GET /api/listo/api/events — SSE stream pushing the list on change.

    Each client gets the current list immediately, then an "event: list"
    message after every mutation. Other devices see additions in real time
    without manual refresh. A comment heartbeat keeps the connection alive.
    """

    url = "/api/listo/api/events"
    name = "api:listo:events"
    requires_auth = False

    async def get(self, request: web.Request):
        """Open the SSE stream; closes when the client disconnects."""
        _check_auth(request)
        hass: HomeAssistant = request.app["hass"]
        data = _data(hass)
        if data is None:
            raise web.HTTPNotFound

        # Bounded queue: a slow client keeps only the freshest snapshot
        # (stale intermediate states are worthless anyway — each payload
        # is the full list).
        queue: asyncio.Queue = asyncio.Queue(maxsize=1)

        def _push() -> None:
            """Enqueue the latest snapshot, dropping a stale pending one."""
            if queue.full():
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            queue.put_nowait(data.as_json())

        unsub = async_dispatcher_connect(hass, SIGNAL_UPDATED, _push)

        resp = web.StreamResponse(
            headers={
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
            }
        )
        await resp.prepare(request)
        try:
            await resp.write(_sse(data.as_json()))
            while True:
                try:
                    payload = await asyncio.wait_for(queue.get(), timeout=30)
                    await resp.write(_sse(payload))
                except asyncio.TimeoutError:
                    await resp.write(b": hb\n\n")  # keep-alive comment
        except (ConnectionError, RuntimeError):
            pass
        finally:
            unsub()
        return resp
