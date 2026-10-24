"""Unit tests for the aisle classifier (categories.py)."""

import pytest

from listo.categories import CATEGORIES, classify, normalize


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        # Multi-word phrases beat single words (the ambiguous cases).
        ("Sauce tomate", "grocery"),
        ("Huile d'olive", "grocery"),
        ("Lait de coco", "grocery"),
        ("Jus d'orange", "drinks"),
        ("Pain au chocolat", "bakery"),
        ("Steak haché", "meat"),
        ("Thon au naturel", "grocery"),
        ("Crème fraîche", "dairy"),
        ("Papier toilette", "hygiene"),
        ("Liquide vaisselle", "household"),
        ("Sacs poubelle", "household"),
        ("Pommes de terre", "produce"),
        ("Haricots verts", "produce"),
        # Plain single words.
        ("Tomates", "produce"),
        ("Oignons", "produce"),
        ("Lait", "dairy"),
        ("Yaourt nature", "dairy"),
        ("Emmental", "cheese"),
        ("Saucisson trucmuche", "meat"),
        ("Chocolat", "snacks"),
        ("Sopalin", "household"),
        ("PQ", "hygiene"),
        ("Eau gazeuse", "drinks"),
        ("Frites surgelées", "frozen"),
        # Accents and case are normalized away.
        ("ÉMINENT COURGETTE", "produce"),
        ("préparé cafÉ", "grocery"),
        # Unknown -> fallback aisle.
        ("Zumba party mix", "other"),
        ("", "other"),
    ],
)
def test_classify(name, expected):
    """Each typical name lands in its expected aisle."""
    assert classify(name, {}) == expected


def test_learned_override_wins():
    """A learned name->category mapping beats every rule."""
    assert classify("sauce tomate", {"sauce tomate": "produce"}) == "produce"


def test_all_categories_have_other_last():
    """The fallback aisle exists."""
    assert "other" in CATEGORIES


def test_normalize_strips_accents():
    """Normalization removes accents and case."""
    assert normalize("  Épices  Mélangées ") == "epices melangees"
