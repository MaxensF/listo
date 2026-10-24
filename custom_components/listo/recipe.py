"""One-shot recipe import from a URL.

Fetches the page once, extracts the schema.org/Recipe JSON-LD block most
cooking sites embed, and returns name + ingredient list. Nothing is
persisted here — the app shows the parsed result in the dish form so the
user can freely edit before saving.
"""

from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import urlparse

import aiohttp

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

MAX_BYTES = 1_500_000
TIMEOUT = aiohttp.ClientTimeout(total=12)

_LD_JSON_RE = re.compile(
    r'<script[^>]*type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
    re.I | re.S,
)

# Leading "<number><unit?>" -> qty, remainder -> ingredient name.
# e.g. "200 g de farine" -> ("200 g", "farine"), "2 oignons" -> ("2", "oignons")
_QTY_PREFIX = re.compile(
    r"^\s*(\d+(?:[.,/]\d+)?(?:\s*[-–]\s*\d+(?:[.,/]\d+)?)?"
    r"(?:\s*(?:g|kg|mg|ml|cl|dl|l|oz|lb|"
    r"cuill[a-zéè]*(?:\s+[aà]\s+[a-zéè]+)?|c\.?\s?[aà]\s?[a-zéè]{1,6}\.?|"
    r"sachets?|bo[îi]tes?|paquets?|tranches?|pinc[ée]+s?|bottes?|gousses?|"
    r"verres?|tasses?|brins?|feuilles?|zestes?|morceaux|poign[ée]+s?|cups?|"
    r"tbsp|tsp|tablespoons?|teaspoons?|cloves?|slices?|cans?|packages?|"
    r"pinch(?:es)?|bunche?s?|sprigs?|leaves)\b)?)"
    r"\s*(?:de\s+|d['’]\s?|of\s+)?(.*)$",
    re.I,
)


def _split_ingredient(text: str) -> dict[str, str]:
    """Split a free-text ingredient line into {"name", "qty"} (heuristic)."""
    text = " ".join(str(text).split())[:200]
    m = _QTY_PREFIX.match(text)
    if m and m.group(2).strip():
        return {"name": m.group(2).strip(), "qty": m.group(1).strip()}
    return {"name": text, "qty": ""}


def _walk_recipes(node: Any):
    """Yield dicts whose @type contains 'Recipe' anywhere in the graph."""
    if isinstance(node, dict):
        t = node.get("@type")
        if t == "Recipe" or (isinstance(t, list) and "Recipe" in t):
            yield node
        for v in node.values():
            if isinstance(v, (dict, list)):
                yield from _walk_recipes(v)
    elif isinstance(node, list):
        for v in node:
            yield from _walk_recipes(v)


async def async_fetch_recipe(hass: HomeAssistant, url: str) -> dict[str, Any]:
    """Download a recipe page once and parse its JSON-LD Recipe data.

    Returns {"name", "ingredients": [{"name", "qty"}], "source": url}.
    Raises ValueError with a user-facing message on failure.
    """
    url = (url or "").strip()
    if urlparse(url).scheme not in ("http", "https"):
        raise ValueError("invalid url")
    session = async_get_clientsession(hass)
    try:
        async with session.get(
            url, timeout=TIMEOUT, headers={"User-Agent": "Listo/1.0"}
        ) as resp:
            if resp.status != 200:
                raise ValueError(f"http {resp.status}")
            body = await resp.content.read(MAX_BYTES + 1)
            if len(body) > MAX_BYTES:
                raise ValueError("page too large")
            html = body.decode(resp.charset or "utf-8", "replace")
    except (aiohttp.ClientError, TimeoutError) as exc:
        raise ValueError("fetch failed") from exc

    for block in _LD_JSON_RE.findall(html):
        try:
            doc = json.loads(block.strip())
        except ValueError:
            continue
        for recipe in _walk_recipes(doc):
            name = str(recipe.get("name") or "").strip()
            raw_ings = recipe.get("recipeIngredient")
            if not name or not isinstance(raw_ings, list) or not raw_ings:
                continue
            ingredients = [
                ing
                for ing in (_split_ingredient(i) for i in raw_ings)
                if ing["name"]
            ]
            if ingredients:
                return {
                    "name": name,
                    "ingredients": ingredients,
                    "source": url,
                }
    raise ValueError("no recipe found")
