"""Unit tests for recipe.py — JSON-LD walking and ingredient splitting
(pure functions; no network involved)."""

from listo.recipe import _split_ingredient, _walk_recipes


def test_split_ingredient_qty_and_name():
    """Leading <number><unit> becomes qty, the rest the name."""
    assert _split_ingredient("200 g de farine") == {
        "name": "farine", "qty": "200 g",
    }
    assert _split_ingredient("2 oignons") == {"name": "oignons", "qty": "2"}
    assert _split_ingredient("1 c. à soupe d'huile") == {
        "name": "huile", "qty": "1 c. à soupe",
    }


def test_split_ingredient_no_qty():
    """A line without a leading number stays whole as the name."""
    assert _split_ingredient("Sel et poivre") == {
        "name": "Sel et poivre", "qty": "",
    }


def test_walk_recipes_finds_nested_recipe():
    """A Recipe inside @graph or a list is found anywhere in the doc."""
    doc = {"@graph": [
        {"@type": "WebPage"},
        {"@type": ["Thing", "Recipe"], "name": "Tarte",
         "recipeIngredient": ["200g farine", "3 pommes"]},
    ]}
    hits = list(_walk_recipes(doc))
    assert len(hits) == 1
    assert hits[0]["name"] == "Tarte"
    assert list(_walk_recipes({"@type": "WebPage"})) == []
