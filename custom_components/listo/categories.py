"""Keyword-based aisle classification for grocery items.

Priority: learned override > multi-word phrase > single word > "other".

Matching runs on the normalized name (lowercase, accents stripped) with
whole-word boundaries, so "lait" never matches "laitier" and "sauce tomate"
hits the grocery phrase before the plain "tomate" word.
"""

from __future__ import annotations

import re
import unicodedata

# Aisle keys in the default store-walk order (user-reorderable).
CATEGORIES = [
    "produce",     # fruits & vegetables
    "bakery",      # bread & pastries
    "meat",        # meat / fish / deli
    "cheese",      # cheeses
    "dairy",       # milk, yogurts, butter, eggs
    "grocery",     # pantry staples
    "snacks",      # biscuits & snacks
    "frozen",      # frozen food
    "drinks",      # beverages
    "hygiene",     # hygiene & beauty
    "household",   # cleaning products
    "other",       # misc (fallback — always keep last)
]

# Multi-word phrases checked first — these solve the ambiguous cases
# ("sauce tomate" is groceries, not produce).
PHRASES = {
    "sauce tomate": "grocery",
    "concentre de tomate": "grocery",
    "tomates pelees": "grocery",
    "thon au naturel": "grocery",
    "boite de thon": "grocery",
    "huile d'olive": "grocery",
    "huile de tournesol": "grocery",
    "huile de colza": "grocery",
    "huile de coco": "grocery",
    "sauce soja": "grocery",
    "pate a tartiner": "grocery",
    "beurre de cacahuete": "grocery",
    "puree mousseline": "grocery",
    "chocolat en poudre": "grocery",
    "chocolat au lait": "grocery",
    "lait de coco": "grocery",
    "lait d'avoine": "drinks",
    "lait d'amande": "drinks",
    "jus d'orange": "drinks",
    "jus de pomme": "drinks",
    "jus d'ananas": "drinks",
    "eau gazeuse": "drinks",
    "pomme de terre": "produce",
    "pommes de terre": "produce",
    "haricots verts": "produce",
    "viande hachee": "meat",
    "steak hache": "meat",
    "thon frais": "meat",
    "creme fraiche": "dairy",
    "creme dessert": "dairy",
    "petit suisse": "dairy",
    "petits suisses": "dairy",
    "fromage rape": "cheese",
    "pain au chocolat": "bakery",
    "pain au lait": "bakery",
    "pain de mie": "bakery",
    "fruits secs": "snacks",
    "barre de cereales": "snacks",
    "barres de cereales": "snacks",
    "papier toilette": "hygiene",
    "serviettes hygieniques": "hygiene",
    "liquide vaisselle": "household",
    "essuie tout": "household",
    "papier cuisson": "household",
    "papier sulfurise": "household",
    "papier aluminium": "household",
    "papier alu": "household",
    "film alimentaire": "household",
    "sac poubelle": "household",
    "sacs poubelle": "household",
}

# Single-word keywords (checked in name order, first match wins).
WORDS = {
    # produce
    "pomme": "produce", "banane": "produce", "orange": "produce",
    "citron": "produce", "poire": "produce", "fraise": "produce",
    "framboise": "produce", "myrtille": "produce", "raisin": "produce",
    "melon": "produce", "pasteque": "produce", "peche": "produce",
    "nectarine": "produce", "abricot": "produce", "kiwi": "produce",
    "ananas": "produce", "mangue": "produce", "avocat": "produce",
    "tomate": "produce", "salade": "produce", "laitue": "produce",
    "carotte": "produce", "courgette": "produce", "concombre": "produce",
    "poivron": "produce", "oignon": "produce", "echalote": "produce",
    "ail": "produce", "brocoli": "produce", "chou": "produce",
    "epinards": "produce", "champignon": "produce", "champignons": "produce",
    "poireau": "produce", "celeri": "produce", "radis": "produce",
    "betterave": "produce", "endive": "produce", "fenouil": "produce",
    "aubergine": "produce", "potiron": "produce", "courge": "produce",
    "basilic": "produce", "persil": "produce", "coriandre": "produce",
    "menthe": "produce", "gingembre": "produce", "patate": "produce",
    "patates": "produce", "carottes": "produce", "tomates": "produce",
    "courgettes": "produce", "pommes": "produce", "bananes": "produce",
    # bakery
    "pain": "bakery", "baguette": "bakery", "croissant": "bakery",
    "croissants": "bakery", "brioche": "bakery", "tortilla": "bakery",
    "wrap": "bakery", "pita": "bakery", "viennoiserie": "bakery",
    # meat / fish / deli
    "poulet": "meat", "boeuf": "meat", "steak": "meat", "porc": "meat",
    "agneau": "meat", "veau": "meat", "dinde": "meat", "jambon": "meat",
    "saucisse": "meat", "saucisses": "meat", "merguez": "meat",
    "lardons": "meat", "bacon": "meat", "chorizo": "meat",
    "saumon": "meat", "cabillaud": "meat", "crevettes": "meat",
    "escalope": "meat", "nuggets": "meat", "kebab": "meat",
    "canard": "meat", "magret": "meat", "ailes": "meat",
    "charcuterie": "meat", "hache": "meat", "saucisson": "meat",
    "thon": "grocery",
    # cheese
    "fromage": "cheese", "emmental": "cheese", "comte": "cheese",
    "gruyere": "cheese", "mozzarella": "cheese", "parmesan": "cheese",
    "brie": "cheese", "camembert": "cheese", "chevre": "cheese",
    "roquefort": "cheese", "reblochon": "cheese", "feta": "cheese",
    "mascarpone": "cheese", "ricotta": "cheese", "cheddar": "cheese",
    "gorgonzola": "cheese", "babybel": "cheese", "kiri": "cheese",
    "munster": "cheese", "bleu": "cheese", "raclette": "cheese",
    # dairy / creamery
    "lait": "dairy", "yaourt": "dairy", "yaourts": "dairy",
    "beurre": "dairy", "oeuf": "dairy", "oeufs": "dairy",
    "creme": "dairy", "margarine": "dairy", "danette": "dairy",
    # grocery
    "pates": "grocery", "riz": "grocery", "semoule": "grocery",
    "quinoa": "grocery", "lentilles": "grocery", "farine": "grocery",
    "sucre": "grocery", "sel": "grocery", "poivre": "grocery",
    "huile": "grocery", "vinaigre": "grocery", "moutarde": "grocery",
    "ketchup": "grocery", "mayonnaise": "grocery", "mayo": "grocery",
    "pesto": "grocery", "olives": "grocery", "cornichons": "grocery",
    "confiture": "grocery", "miel": "grocery", "nutella": "grocery",
    "cereales": "grocery", "muesli": "grocery", "cafe": "grocery",
    "the": "grocery", "cacao": "grocery", "levure": "grocery",
    "bicarbonate": "grocery", "chapelure": "grocery", "bouillon": "grocery",
    "curry": "grocery", "paprika": "grocery", "cannelle": "grocery",
    "origan": "grocery", "thym": "grocery", "laurier": "grocery",
    "puree": "grocery", "soupe": "grocery", "nouilles": "grocery",
    "compote": "grocery", "pizza": "grocery", "sauce": "grocery",
    "mais": "grocery", "conserve": "grocery",
    # snacks
    "biscuit": "snacks", "biscuits": "snacks", "cookie": "snacks",
    "cookies": "snacks", "madeleine": "snacks", "madeleines": "snacks",
    "bonbon": "snacks", "bonbons": "snacks", "chips": "snacks",
    "cacahuetes": "snacks", "noix": "snacks", "amandes": "snacks",
    "crackers": "snacks", "gaufrettes": "snacks", "gateau": "snacks",
    "gateaux": "snacks", "speculoos": "snacks", "brownie": "snacks",
    "chocolat": "snacks",
    # frozen
    "surgele": "frozen", "surgeles": "frozen", "frites": "frozen",
    "glace": "frozen", "poelee": "frozen",
    # drinks
    "eau": "drinks", "soda": "drinks", "coca": "drinks", "cola": "drinks",
    "limonade": "drinks", "biere": "drinks", "vin": "drinks",
    "sirop": "drinks", "jus": "drinks",
    # hygiene
    "shampoing": "hygiene", "savon": "hygiene", "dentifrice": "hygiene",
    "deodorant": "hygiene", "mouchoirs": "hygiene", "rasoir": "hygiene",
    "coton": "hygiene", "pq": "hygiene",
    # household
    "lessive": "household", "adoucissant": "household",
    "eponge": "household", "eponges": "household", "javel": "household",
    "nettoyant": "household", "lingettes": "household",
    "aluminium": "household", "sopalin": "household",
    "ampoule": "household", "pile": "household", "piles": "household",
}

# Default dot color per aisle (hex). Users can override them from the
# app's settings; values are stored server-side and shared by devices.
DEFAULT_COLORS = {
    "produce": "#4caf50",
    "bakery": "#d7a04a",
    "meat": "#e05252",
    "cheese": "#f2c230",
    "dairy": "#7ec3e6",
    "grocery": "#b08968",
    "snacks": "#b07ec9",
    "frozen": "#5ac8d8",
    "drinks": "#4a8fe0",
    "hygiene": "#e08bb0",
    "household": "#8d99a6",
    "other": "#777777",
}

_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


def valid_color(value: object) -> bool:
    """True when value is a '#rrggbb' hex color."""
    return isinstance(value, str) and _COLOR_RE.match(value) is not None


_WORD_RE = re.compile(r"[a-z0-9]+")


def normalize(text: str) -> str:
    """Lowercase, strip accents, collapse whitespace."""
    text = unicodedata.normalize("NFKD", text.lower())
    text = "".join(c for c in text if not unicodedata.combining(c))
    return " ".join(_WORD_RE.findall(text))


def _contains_phrase(norm_name: str, phrase: str) -> bool:
    """Whole-words substring check on an already-normalized name."""
    return (
        re.search(rf"(?<![a-z0-9]){re.escape(phrase)}(?![a-z0-9])", norm_name)
        is not None
    )


def classify(name: str, overrides: dict[str, str]) -> str:
    """Return the aisle key for an item name.

    overrides maps normalized item names -> category (learned from user
    corrections in the app).
    """
    norm = normalize(name)
    if norm in overrides:
        return overrides[norm]
    # Longest phrases first so "huile de coco" beats "huile".
    for phrase in sorted(PHRASES, key=len, reverse=True):
        if _contains_phrase(norm, phrase):
            return PHRASES[phrase]
    for token in _WORD_RE.findall(norm):
        if token in WORDS:
            return WORDS[token]
        # Plural fallback: "oignons" -> "oignon".
        if token.endswith("s") and token[:-1] in WORDS:
            return WORDS[token[:-1]]
    return "other"
