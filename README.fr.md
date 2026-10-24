# Listo

<img src="custom_components/listo/www/img/icon-192.png" alt="" align="right" height="120">

[🇬🇧 English](README.md) · **🇫🇷 Français**

[![GH-downloads](https://img.shields.io/github/downloads/MaxensF/listo/total?style=flat-square)](https://github.com/MaxensF/listo/releases)
[![Open your Home Assistant instance and open this repository inside the Marketplace.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=MaxensF&repository=listo&category=integration)

Liste de courses partagée du foyer, **100 % hébergée sur Home Assistant**,
avec une app mobile **offline-first** (PWA) : consultable et cochable sans
réseau en magasin, synchronisée au retour. Interface **FR/EN**.

## Fonctionnalités

- **App mobile installable** (*Ajouter à l'écran d'accueil*) : checklist qui
  fonctionne sans réseau — les ajouts hors-ligne sont mis en file d'attente
  et envoyés plus tard.
- **Entité `todo.listo` native** : la même liste apparaît dans la carte
  *todo* de HA → ajout possible via dashboard, voix (Assist), automatisations.
- **Rayons & magasins** : articles groupés par rayon ; l'ordre des rayons
  est défini par magasin et la liste se trie toute seule dans l'ordre où
  vous marchez réellement.
- **Quantités & édition** : chaque article peut porter une quantité
  (« x2 », « 500 g ») et être renommé ou re-rangé en place.
- **Plats & menu de la semaine** : catalogue de plats avec ingrédients —
  ajouter un plat à la semaine pousse ses ingrédients dans la liste.
  Les recettes peuvent être importées depuis des pages JSON-LD, et le
  catalogue s'exporte/importe en JSON.
- **Annulation partout** : courses terminées, retrait d'un plat du menu et
  autres actions destructrices peuvent être annulées.
- **Cartes de fidélité** : stockées **sur chaque appareil** (jamais envoyées
  vers HA), affichées en EAN/UPC/Code 128/QR, scannables en photo,
  sauvegarde export/import.
- **Notification « courses terminées »** sur l'app Android quand l'autre
  personne finit la liste.
- **Mini-API JSON** (`/api/listo/api/*`), protégeable par un **code d'accès**
  optionnel configuré à l'installation.
- **Aucune config YAML**, aucun webhook, aucune automatisation à créer.

## Installation

### Option A — copie manuelle (2 min)

1. Copier le dossier `custom_components/listo/` dans
   `/config/custom_components/listo/` sur le serveur HA (via Studio Code
   Server, Samba, File Editor…).
2. **Redémarrer Home Assistant**.
3. **Paramètres → Appareils et services → + Ajouter une intégration** →
   « Listo » → laisser le *code d'accès* vide (ou en définir un) → Valider.

### Option B — Marketplace (intégré à HA 2026.11+)

**Paramètres → Marketplace → Add from link** → coller l'URL GitHub de ce
dépôt → installer → redémarrer → ajouter l'intégration comme ci-dessus.
Sur les versions plus anciennes de HA, même chose via HACS → ⋮ →
*Dépôts personnalisés*.

## Utilisation

### Côté téléphone (toute la famille)

**Option recommandée — l'APK dédié** (`android/`) : une app « Listo »
native (WebView) qui apparaît comme app séparée dans le *split tunneling*
de Tailscale — Chrome et les autres apps restent hors tunnel. Le PWA est
**bundlé dans l'APK** : l'app s'ouvre toujours, même sans aucun réseau,
et affiche la dernière liste téléchargée. Build via le workflow GitHub
Actions (artifact `listo-debug-apk`, rien à installer) ou Android Studio.
L'URL du serveur est pré-remplie depuis `res/values/strings.xml`
(`ha_base`) et modifiable dans l'app (⚙ → *Adresse Home Assistant*).

**Alternative sans build** : ouvrir `http://<ha>:8123/api/listo/app/index.html`
dans le navigateur → *Ajouter à l'écran d'accueil* (nécessite alors que le
navigateur — ou la WebAPK — soit autorisé dans le split tunneling Tailscale).

**⚠️ Ne pas ouvrir via l'app Home Assistant** : elle ferme la vue dès que la
connexion tombe. L'app le signale par un bandeau si ça arrive.

Bouton **⚙** : choisir la langue et, si un code d'accès est configuré,
le saisir une fois (mémorisé sur l'appareil).

### En magasin (zéro réseau requis)

- Cocher les articles : tout est en local.
- Ajouter un article hors-ligne : tagué « en attente », envoyé au retour
  réseau/VPN.
- « Courses terminées » : retire les articles cochés (si hors-ligne, la
  synchro se fera automatiquement au prochain lancement connecté).

### Côté Home Assistant

- `todo.listo` utilisable partout : carte todo, `todo.add_item`,
  automatisations, Assist.
- Panneau latéral « Listo » pour ouvrir l'app dans HA.

## API

| Endpoint | Méthode | Corps | Rôle |
|---|---|---|---|
| `/api/listo/app/<fichier>` | GET | — | sert le PWA (whitelist) |
| `/api/listo/api/list` | GET | — | état complet : articles, rayons, magasins, plats, menu |
| `/api/listo/api/add` | POST | `{"item":"Lait","qty":"x2"}` | ajoute un article |
| `/api/listo/api/update` | POST | `{"ref":…,"name"…,"qty"…,"category"…}` | renomme / quantité / (dé)coche un article |
| `/api/listo/api/done` | POST | `{"items":["Lait"]}` ou `{"all":true}` | retire des articles |
| `/api/listo/api/restore` | POST | — | annule le dernier « courses terminées » |
| `/api/listo/api/dishes` | POST | `{"name"…,"ingredients"…,"delete"…}` | CRUD du catalogue de plats |
| `/api/listo/api/menu` | POST | `{"name"…}` / `{"remove"…}` / `{"undo":…}` | menu de la semaine : ajout/retrait/coche |
| `/api/listo/api/categories` | POST | `{"add"…,"remove"…,"rename"…,"order"…,"store"…}` | rayons, couleurs et ordre par magasin |
| `/api/listo/api/recipe` | POST | `{"url":"…"}` | importe les ingrédients d'une page recette JSON-LD |
| `/api/listo/api/events` | GET (SSE) | — | pousse `event: list` à chaque changement → synchro temps réel entre appareils |

Si un code d'accès est configuré, toutes les routes `/api/listo/api/*`
exigent le header `X-Listo-Token: <code>` ou le paramètre `?token=<code>`
(utilisé par le flux SSE, `EventSource` ne peut pas envoyer de header).

```sh
curl -X POST -H "Content-Type: application/json" \
  -H "X-Listo-Token: moncode" \
  -d '{"item":"Lait"}' http://ha:8123/api/listo/api/add
```

## Sécurité

- Endpoints **non authentifiés par défaut** (même principe que `/local/`) :
  avec un accès VPN-only, la surface se limite au LAN/VPN et au pire
  quelqu'un modifie la liste de courses.
- Le **code d'accès optionnel** (header `X-Listo-Token`) durcit l'API si HA
  devient joignable autrement. Ce n'est pas de l'authentification HA — c'est
  un secret partagé simple, suffisant pour une liste de courses.
- Côté app : noms affichés via `textContent` (pas d'injection HTML) ;
  fichiers servis via whitelist (pas de path traversal) ; aucun token HA
  n'est exposé au client.
- Les cartes de fidélité vivent dans le `localStorage` de chaque appareil
  uniquement — jamais envoyées, synchronisées ou journalisées.

## Structure du dépôt

```
custom_components/listo/
├── manifest.json          # métadonnées HA (domain: listo)
├── __init__.py            # setup : store, vues, panneau, plateforme
├── config_flow.py         # ajout via l'UI + code d'accès optionnel
├── const.py               # domaine, clés, whitelist de fichiers, limites
├── categories.py          # rayons intégrés + classification des articles
├── data.py                # liste persistée (helpers.storage.Store)
├── recipe.py              # parsing de recettes JSON-LD
├── todo.py                # entité todo.listo
├── http.py                # vues : /api/listo/app/* + /api/listo/api/*
├── strings.json           # textes du config flow (EN source)
├── translations/en.json + fr.json
└── www/                   # le PWA bundlé
    ├── index.html         # markup
    ├── style.css          # thème mobile-first
    ├── app.js             # logique offline-first + synchro
    ├── i18n.js            # moteur de langue
    ├── i18n/fr.js + en.js # dictionnaires
    ├── sw.js              # service worker (shell hors-ligne)
    ├── manifest.webmanifest
    └── img/ + *.min.js    # icônes + libs code-barres/QR bundlées

android/                     # APK WebView dédié (split tunneling Tailscale)
├── app/src/main/java/com/listo/app/   # MainActivity, ListoJobService, PhotoProvider
├── app/src/main/res/        # icône, strings EN + values-fr (ha_base = URL du serveur)
├── app/build.gradle, build.gradle, settings.gradle
└── ../.github/workflows/build-apk.yml  # build CI de l'APK (debug)
```

## Build de l'APK Android

- **En local** : ouvrir `android/` dans Android Studio → *Build > Build
  APK(s)* → `app-debug.apk` à sideloader sur les téléphones.
- **En CI** : pousser le repo sur GitHub → l'action `Build Listo APK`
  produit l'artifact `listo-debug-apk` à chaque push touchant `android/`
  ou `custom_components/listo/www/`.
- Régler l'URL dans `res/values/strings.xml` (`ha_base`, sans le chemin)
  — ou la garder hors du dépôt via le secret GitHub `LISTO_HA_BASE`,
  que la CI injecte au moment du build. Modifiable ensuite dans l'app
  via ⚙ sans recompiler.
- Signature : la CI décode un keystore persistant depuis `KEYSTORE_BASE64`
  pour que tous les builds partagent la même signature — les APK
  s'installent **par-dessus** les précédents (réglages et cartes
  conservés).
- Une fois installée, l'app « Listo » apparaît dans le **split tunneling**
  de Tailscale → l'autoriser seule → Chrome non concerné.

## Régénérer les icônes

```sh
python3 tools/make_icons.py   # stdlib uniquement, anticrénelage 4x
```
