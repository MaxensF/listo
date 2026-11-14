// app.js — Listo mobile app logic.
//
// Offline-first: the whole state lives in localStorage; the server is only
// contacted to sync (fetch list, push pending mutations). No network or VPN
// is needed while shopping.
// i18n helpers (t/tf/listoLang) come from i18n.js.

(function () {
  "use strict";

  var LS_KEY = "listo-state-v1";
  var TOKEN_KEY = "listo-token";
  var BASE_KEY = "listo-ha-base";

  // HA server base URL. When the page is served by HA itself (browser/PWA)
  // it is simply the page origin; inside the Android wrapper (file://) it
  // must be entered once in Settings (or seeded by the native layer).
  function apiBase() {
    if (location.protocol.indexOf("http") === 0) return location.origin;
    try { return localStorage.getItem(BASE_KEY) || ""; } catch (e) { return ""; }
  }
  // Store the HA base URL (trailing slashes stripped).
  function setApiBase(v) {
    v = (v || "").trim().replace(/\/+$/, "");
    try { localStorage.setItem(BASE_KEY, v); } catch (e) {}
  }
  // Build a full API URL from a path (e.g. "/list").
  function api(path) { return apiBase() + "/api/listo/api" + path; }

  // ---- Persisted state ----------------------------------------------------
  // items       : shopping items from the server [{name, qty}]
  // dishes      : recipe catalog [{uid, name, ingredients[]}]
  // menu        : this week's dishes [{uid, name, checked}]
  // checks      : item name -> check timestamp (ticked while shopping)
  //               (menu .checked is shared server-side: the "cooked" flag)
  // pendingAdds : items added locally [{name, qty}], not yet confirmed
  // pendingDone : item names to remove server-side (purchased or deleted)
  // shoppingDone: the "finish shopping" button was pressed — the next
  //               /done call stamps last_done so other devices notify
  // pendingOps  : queued mutations [{op: update|dish|undish|menu|unmenu,...}]
  // updated     : timestamp of the last successful sync
  // Factory for a fresh state object (also the key list).
  function blank() {
    return {
      items: [], dishes: [], menu: [],
      checks: {},
      pendingAdds: [], pendingDone: [], pendingOps: [],
      shoppingDone: false,
      order: DEFAULT_ORDER.slice(),
      colors: {},
      custom: {},       // user-created aisles: key -> label
      catLabels: {},    // display-name overrides for any aisle
      store: "Default",  // active store (per-device choice)
      storeOrders: {},  // store name -> aisle order (from the server)
      version: null,    // integration version reported by the server
      updated: null,
    };
  }

  // Default aisle order (server is authoritative once synced).
  var DEFAULT_ORDER = ["produce", "bakery", "meat", "cheese", "dairy",
    "grocery", "snacks", "frozen", "drinks", "hygiene", "household", "other"];

  // Default dot color per aisle; the server palette overrides once synced.
  var DEFAULT_COLORS = {
    produce: "#4caf50", bakery: "#d7a04a", meat: "#e05252",
    cheese: "#f2c230", dairy: "#7ec3e6", grocery: "#b08968",
    snacks: "#b07ec9", frozen: "#5ac8d8", drinks: "#4a8fe0",
    hygiene: "#e08bb0", household: "#8d99a6", other: "#777777"
  };

  var state = load() || blank();

  // Load + normalize the persisted state.
  function load() {
    var s = null;
    try { s = JSON.parse(localStorage.getItem(LS_KEY)); } catch (e) {}
    if (!s) return null;
    var b = blank();
    for (var k in b) if (s[k] === undefined) s[k] = b[k];
    // Tolerated stored shapes: plain names, quantity in "note",
    // plain-string dish ingredients.
    s.pendingAdds = s.pendingAdds.map(function (x) {
      return typeof x === "string" ? { name: x, qty: "" } : x;
    });
    s.items = s.items.map(function (x) {
      if (typeof x === "string") return { name: x, qty: "" };
      if (x.qty === undefined) x.qty = x.note || "";
      return x;
    });
    s.dishes.forEach(function (d) { d.ingredients = normIngs(d.ingredients); });
    return s;
  }
  // Persist the whole state to localStorage.
  function save() { localStorage.setItem(LS_KEY, JSON.stringify(state)); }

  // Normalize a dish's ingredient list to [{name, qty}]. Non-array input
  // (e.g. a stray string in imported JSON) yields an empty list rather
  // than throwing.
  function normIngs(ings) {
    return (Array.isArray(ings) ? ings : []).map(function (x) {
      return typeof x === "string" ? { name: x, qty: "" } : x;
    });
  }

  // Localized label for an aisle key: a rename override first, then a
  // user-created aisle's stored label, then the built-in translation —
  // falling back to the raw key for deleted/unknown aisles.
  function catLabel(cat) {
    var lbl = state.catLabels[cat] || state.custom[cat];
    if (lbl) return lbl;
    var tr = t("cat_" + cat);
    return tr === "cat_" + cat ? cat : tr;
  }

  // Dot color for an aisle (user palette, falling back to the defaults).
  function catColor(cat) {
    return state.colors[cat] || DEFAULT_COLORS[cat] || DEFAULT_COLORS.other;
  }

  // Display triple [ring, tint, darkCheck] for an aisle color. Colors
  // too close to the dark card background are lifted toward white so the
  // ring and its tint stay readable — the stored palette value is
  // untouched. darkCheck tells the tick to render dark (via CSS invert)
  // when the checked fill would be too light for a white glyph.
  function catRing(cat) {
    var c = catColor(cat);
    var m = /^#([0-9a-f]{6})$/i.exec(c);
    if (!m) return [c, "transparent", false];
    var n = parseInt(m[1], 16);
    var r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    var lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    if (lum < 0.4) {
      var t = 0.45;
      r = Math.round(r + (255 - r) * t);
      g = Math.round(g + (255 - g) * t);
      b = Math.round(b + (255 - b) * t);
      lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    }
    return ["rgb(" + r + "," + g + "," + b + ")",
            "rgba(" + r + "," + g + "," + b + ",.16)", lum > 0.55];
  }

  // A plain "<number><optional unit>" quantity ("5", "200g", "3 cuisses").
  var QTY_RE = /^\s*(\d+(?:[.,]\d+)?)\s*([a-zA-Zéèêàçôû%]*)\s*$/i;

  // Merge two quantities: same-unit numerics are summed ("4"+"5"="9",
  // "200g"+"150g"="350g"), anything else is appended ("5 + 200g").
  // Mirrors data.py's merge_qty so local state matches the server result.
  function mergeQty(oldQ, newQ) {
    oldQ = (oldQ || "").trim(); newQ = (newQ || "").trim();
    if (!newQ) return oldQ;
    if (!oldQ) return newQ;
    var a = oldQ.match(QTY_RE), b = newQ.match(QTY_RE);
    if (a && b && (a[2] || "").toLowerCase() === (b[2] || "").toLowerCase()) {
      var t = parseFloat(a[1].replace(",", ".")) + parseFloat(b[1].replace(",", "."));
      var num = (t === Math.round(t)) ? String(Math.round(t))
        : String(Math.round(t * 100) / 100).replace(".", ",");
      // Keep the original spacing: "200g"+"150g" -> "350g" while
      // "2 cuisses"+"3 cuisses" -> "5 cuisses".
      var sep = /\d\s+\S/.test(oldQ) ? " " : "";
      return num + ((a[2] || "") ? sep + a[2] : "");
    }
    return oldQ + " + " + newQ;
  }

  // Read the optional API access code.
  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY) || ""; } catch (e) { return ""; }
  }
  // Store the optional API access code.
  function setToken(v) {
    try { localStorage.setItem(TOKEN_KEY, v); } catch (e) {}
  }

  // ---- DOM ----------------------------------------------------------------
  var listEl = document.getElementById("list");
  var emptyEl = document.getElementById("empty");
  var menuListEl = document.getElementById("menuList");
  var dishesSecEl = document.getElementById("dishesSec");
  var doneCount = document.getElementById("doneCount");
  var netdot = document.getElementById("netdot");
  var input = document.getElementById("newItem");
  var qtyInput = document.getElementById("newQty");
  var addRow = document.getElementById("addRow");
  var toast = document.getElementById("toast");
  var settingsEl = document.getElementById("settings");
  var itemSheetEl = document.getElementById("itemSheet");
  var dishPickerEl = document.getElementById("dishPicker");
  var dishFormEl = document.getElementById("dishForm");
  var aislesSheetEl = document.getElementById("aislesSheet");

  // Brief on-screen notification. With an action label it stays 5s and
  // shows a button that runs fn (used for the delete Undo).
  var toastText = document.getElementById("toastText");
  var toastBtn = document.getElementById("toastBtn");
  function showToast(msg, action, fn) {
    toastText.textContent = msg;
    // "inline", not "" — the base CSS keeps #toastBtn at display:none.
    toastBtn.style.display = action ? "inline" : "none";
    if (action) {
      toastBtn.textContent = action;
      toastBtn.onclick = function () {
        toast.classList.remove("show");
        fn();
      };
    }
    toast.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () {
      toast.classList.remove("show");
    }, action ? 5000 : 2200);
  }

  // <img> rendering one img/*.svg glyph (standalone files, so every
  // icon can be viewed/edited without touching code).
  function iconImg(name, size) {
    var img = document.createElement("img");
    img.src = "img/" + name + ".svg";
    img.width = size || 16;
    img.height = size || 16;
    img.alt = "";
    // Icons are never HTML5-draggable — a native img drag fires
    // pointercancel, which would abort a grip drag mid-gesture.
    img.draggable = false;
    return img;
  }
  // Put/remove the check glyph inside an item/menu checkbox.
  function setCheck(box, on) {
    box.innerHTML = "";
    if (on) box.appendChild(iconImg("check", 15));
  }

  // Open an overlay. Re-opening during a close cancels the pending hide
  // so the exit timer can't shut it afterwards.
  function show(el) {
    el._closing = false;
    el.classList.remove("closing");
    el.classList.add("show");
  }
  // Close an overlay: park .closing for the exit animation, then lift
  // .show (display:none can't be transitioned out of). _closing guards
  // re-entrant hides and lets the timer no-op on a cancelled close.
  function hide(el) {
    if (!el.classList.contains("overlay")) { el.classList.remove("show"); return; }
    if (el._closing) return;
    el._closing = true;
    el.classList.add("closing");
    setTimeout(function () {
      if (!el._closing) return;
      el._closing = false;
      el.classList.remove("closing");
      el.classList.remove("show");
    }, 200);
  }

  // Called by the Android back button (MainActivity.onBackPressed): close
  // the topmost open overlay and return true so the activity stays alive;
  // on the main screen it returns false and Android exits the app.
  window.__listoBack = function () {
    var open = document.querySelectorAll(".overlay.show");
    if (open.length) { hide(open[open.length - 1]); return true; }
    return false;
  };

  // ---- i18n ----------------------------------------------------------------
  function applyStrings() {
    document.documentElement.lang = listoLang();
    emptyEl.innerHTML = t("emptyList");
    input.placeholder = t("addPlaceholder");
    qtyInput.placeholder = t("qtyPlaceholder");
    netdot.title = t("connectivity");
    document.getElementById("haWarnTitle").innerHTML = t("haWarnTitle");
    document.getElementById("haWarnBody").innerHTML = t("haWarnBody");
    document.getElementById("settingsTitle").textContent = t("settingsTitle");
    document.getElementById("langLabel").textContent = t("langLabel");
    document.getElementById("tokenLabel").textContent = t("tokenLabel");
    document.getElementById("tokenHint").textContent = t("tokenHint");
    document.getElementById("saveSettings").textContent = t("save");
    document.getElementById("haBaseLabel").textContent = t("haBaseLabel");
    document.getElementById("haBaseHint").textContent = t("haBaseHint");
    document.getElementById("dishesTitle").textContent = t("dishesTitle");
    document.getElementById("addDishBtn").textContent = t("addDish");
    document.getElementById("editTitle").textContent = t("editTitle");
    document.getElementById("editQty").placeholder = t("qtyPlaceholder");
    document.getElementById("editCatLabel").textContent = t("editCatLabel");
    // Rebuild the aisle dropdown in the store-walk order.
    var sel = document.getElementById("editCat");
    sel.innerHTML = "";
    state.order.forEach(function (c) {
      var o = document.createElement("option");
      o.value = c;
      o.textContent = catLabel(c);
      sel.appendChild(o);
    });
    document.getElementById("orderLabel").textContent = t("orderLabel");
    document.getElementById("orderHint").textContent = t("orderHint");
    document.getElementById("newCatInput").placeholder = t("newCatPlaceholder");

    storeSel.setAttribute("aria-label", t("storeLabel"));
    editStoreSel.setAttribute("aria-label", t("storeLabel"));
    document.getElementById("sourceLabel").textContent = t("sourceLabel");
    document.getElementById("sourceHint").textContent = t("sourceHint");
    document.getElementById("dishImport").textContent = t("importBtn");
    document.getElementById("clearCooked").textContent = t("clearCooked");
    document.getElementById("updateLink").textContent = t("updateLink");
    document.getElementById("backupLabel").textContent = t("backupLabel");
    document.getElementById("exportDishes").textContent = t("backupExport");
    document.getElementById("importDishes").textContent = t("backupImport");
    document.getElementById("backupHint").textContent = t("backupHint");
    document.getElementById("backupCopy").textContent = t("backupCopy");
    document.getElementById("backupApply").textContent = t("backupImport");
    document.getElementById("aislesBtn").textContent = t("aislesBtn");
    document.getElementById("aislesTitle").textContent = t("aislesTitle");
    document.getElementById("resetAisles").textContent = t("resetAisles");
    document.getElementById("editSave").textContent = t("save");
    document.getElementById("editCancel").textContent = t("cancel");
    document.getElementById("dishPickerTitle").textContent = t("dishPickerTitle");
    document.getElementById("dishSearch").placeholder = t("dishSearch");
    document.getElementById("newDishBtn").textContent = t("newDish");
    document.getElementById("dishFormTitle").textContent = t("dishFormTitle");
    document.getElementById("dishNameLabel").textContent = t("dishNameLabel");
    document.getElementById("ingredientsLabel").textContent = t("ingredientsLabel");
    document.getElementById("addIngBtn").textContent = t("addIngredient");
    document.getElementById("dishSave").textContent = t("save");
    document.getElementById("dishDelete").textContent = t("del");
    document.getElementById("dishCancel").textContent = t("cancel");
    document.getElementById("cardsBtn").title = t("cardsTitle");
    document.getElementById("cardsBtn").setAttribute("aria-label", t("cardsTitle"));
    document.getElementById("cardsTitle").textContent = t("cardsTitle");
    document.getElementById("cardsHint").textContent = t("cardsHint");
    document.getElementById("addCardBtn").textContent = t("addCard");
    document.getElementById("cardFormTitle").textContent = t("cardFormTitle");
    document.getElementById("cardNameLabel").textContent = t("cardNameLabel");
    document.getElementById("cardName").placeholder = t("cardNamePh");
    document.getElementById("cardsSearch").placeholder = t("cardsSearchPh");
    document.getElementById("cardNumLabel").textContent = t("cardNumLabel");
    document.getElementById("cardNumHint").textContent = t("cardNumHint");
    document.getElementById("cardFmtLabel").textContent = t("cardFmtLabel");
    cardFormatSel.options[0].textContent = t("fmtAuto");
    document.getElementById("cardScan").title = t("cardScan");
    document.getElementById("cardScan").setAttribute("aria-label", t("cardScan"));
    document.getElementById("cardColorLabel").textContent = t("cardColorLabel");
    document.getElementById("cardSave").textContent = t("save");
    document.getElementById("cardDelete").textContent = t("del");
    document.getElementById("cardCancel").textContent = t("cancel");
    document.getElementById("cardViewHint").textContent = t("cardViewHint");
    document.getElementById("exportCards").textContent = t("backupExport");
    document.getElementById("importCards").textContent = t("backupImport");
    render();
  }

  // ---- Rendering ------------------------------------------------------------
  // Number of shopping items currently ticked.
  function checkedCount() {
    var n = 0;
    for (var k in state.checks) if (state.checks[k]) n++;
    return n;
  }

  // Tracks whether the checked section existed in the previous render —
  // its finish button pops in only on the 0→1 transition, not on every
  // rebuild (the header is recreated each render). lastDoneCount feeds
  // the ghost header shown while the section fades out.
  var hadDone = false, lastDoneCount = 0;
  // Menu names seen in the previous render — freshly appeared entries get
  // the pop-in animation; rebuilt rows stay still.
  var prevMenu = {};

  // Show/hide with the pop animations: persistent elements can't
  // transition out of display:none, so hiding parks a .popout pass and
  // flips [hidden] once it ends. _hiding dedupes re-entrant calls and a
  // mid-flight show cancels the pending hide.
  function popToggle(el, show) {
    if (show) {
      el._hiding = false;
      el.classList.remove("popout");
      el.hidden = false;
    } else if (!el.hidden && !el._hiding) {
      el._hiding = true;
      el.classList.add("popout");
    }
  }
  document.addEventListener("animationend", function (e) {
    if (e.target._hiding) {
      e.target._hiding = false;
      e.target.classList.remove("popout");
      e.target.hidden = true;
    }
  });
  function render() {
    // The dishes section isn't a FLIP participant — measure it here so an
    // appearing/vanishing checked header slides it instead of jumping.
    var dishesY = dishesSecEl.getBoundingClientRect().top;
    listEl.innerHTML = "";
    // Sort items by aisle order (headers hidden — they took too much room).
    var catIndex = {};
    state.order.forEach(function (c, i) { catIndex[c] = i; });
    var sorted = state.items.slice().sort(function (a, b) {
      var ca = catIndex[a.cat] !== undefined ? catIndex[a.cat] : 999;
      var cb = catIndex[b.cat] !== undefined ? catIndex[b.cat] : 999;
      return ca - cb;
    });
    // Ticked items leave the aisle flow for a bottom "done" section so
    // what is left stays contiguous; they keep the order they were
    // checked in (the checks map stores timestamps).
    var names = {}, remaining = [], done = [];
    sorted.forEach(function (it) {
      names[it.name] = true;
      (state.checks[it.name] ? done : remaining).push(it);
    });
    done.sort(function (a, b) {
      return (+state.checks[a.name] || 0) - (+state.checks[b.name] || 0);
    });
    var now = Date.now();
    // Prune highlight marks older than 5s (fresh SSE arrivals flash once).
    Object.keys(freshNames).forEach(function (k) {
      if (now - freshNames[k] > 5000) delete freshNames[k];
    });
    remaining.forEach(function (it) {
      appendItem(it.name, it.qty, false, false, it.cat);
    });
    var total = sorted.length;
    state.pendingAdds.forEach(function (pa) {
      if (!names[pa.name]) {
        total++;
        names[pa.name] = true;
        appendItem(pa.name, pa.qty, false, true, null);
      }
    });
    if (done.length) {
      lastDoneCount = done.length;
      var hdr = document.createElement("li");
      hdr.className = "donehdr";
      var hl = document.createElement("span");
      hl.textContent = tf("doneSection", done.length);
      hdr.appendChild(hl);
      // "Finish shopping" sits in the checked-section header like the
      // "remove cooked meals" minibtn in the dishes header. The pop-in
      // class only goes on when the section just appeared — the header is
      // rebuilt every render, so an unconditional animation would flash
      // on each check.
      var fin = document.createElement("button");
      fin.className = "minibtn" + (hadDone ? "" : " pop");
      fin.textContent = t("finishList");
      fin.addEventListener("click", function (e) {
        e.stopPropagation();
        armConfirm(fin, finishShopping);
      });
      hdr.appendChild(fin);
      listEl.appendChild(hdr);
      done.forEach(function (it) {
        appendItem(it.name, it.qty, true, false, it.cat);
      });
    } else if (hadDone) {
      // The section just emptied: a ghost copy of its header fades out so
      // the finish button doesn't blink away. Rebuilt renders clear it
      // with innerHTML, the timeout only covers a quiet DOM.
      var ghost = document.createElement("li");
      ghost.className = "donehdr fadeout";
      var gl = document.createElement("span");
      gl.textContent = tf("doneSection", lastDoneCount);
      var gb = document.createElement("span");
      gb.className = "minibtn";
      gb.textContent = t("finishList");
      ghost.appendChild(gl);
      ghost.appendChild(gb);
      listEl.appendChild(ghost);
      setTimeout(function () {
        if (ghost.parentNode) ghost.parentNode.removeChild(ghost);
      }, 480);
    }
    hadDone = done.length > 0;
    emptyEl.hidden = total > 0;

    // Week menu section.
    menuListEl.innerHTML = "";
    state.menu.forEach(function (m) { appendMenuEntry(m, !prevMenu[m.name]); });
    prevMenu = {};
    state.menu.forEach(function (m) { prevMenu[m.name] = true; });

    var dy = dishesY - dishesSecEl.getBoundingClientRect().top;
    if (Math.abs(dy) > 1) {
      dishesSecEl.style.transition = "none";
      dishesSecEl.style.transform = "translateY(" + dy + "px)";
      void dishesSecEl.offsetHeight;
      dishesSecEl.style.transition = "transform .25s ease";
      dishesSecEl.style.transform = "";
    }

    var upd = document.getElementById("updated");
    upd.textContent = state.updated
      ? tf("synced", new Date(state.updated).toLocaleString(listoLang() === "fr" ? "fr-FR" : "en-GB",
          { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }))
      : t("neverSynced");
    updateDoneBtn();
    updateClearCooked();
    renderStoreSel();
    updateDot();
  }

  // Show "remove cooked meals" only when at least one menu entry is checked.
  var clearCookedBtn = document.getElementById("clearCooked");
  function updateClearCooked() {
    var any = state.menu.some(function (m) { return m.checked; });
    popToggle(clearCookedBtn, any);
  }

  // Re-render with a FLIP animation: rows keep their visual position
  // while the DOM rebuilds, then glide to their new slots — a checked
  // row visibly sinks to the done section instead of the list
  // teleporting under the finger.
  function renderFlip() {
    var before = {};
    Array.prototype.forEach.call(listEl.children, function (li) {
      var n = li.getAttribute && li.getAttribute("data-name");
      if (n) before[n] = li.getBoundingClientRect().top;
    });
    render();
    Array.prototype.forEach.call(listEl.children, function (li) {
      var n = li.getAttribute && li.getAttribute("data-name");
      if (!n || before[n] === undefined) return;
      var dy = before[n] - li.getBoundingClientRect().top;
      if (!dy) return;
      li.style.transition = "none";
      li.style.transform = "translateY(" + dy + "px)";
      void li.offsetHeight;  // commit the start position before animating
      li.style.transition = "transform .22s ease";
      li.style.transform = "";
    });
  }

  // Debounced re-render after a check toggle: near-simultaneous taps
  // settle into one animated re-flow. The pause is deliberately tiny —
  // the glide itself is the mis-tap guard (movement is visible).
  var sinkTimer = null;
  function scheduleSink() {
    if (sinkTimer) clearTimeout(sinkTimer);
    sinkTimer = setTimeout(function () { sinkTimer = null; renderFlip(); }, 150);
  }

  // Refresh the passive "✓ n/total" tally in the footer — visible only
  // while at least one item is checked. The full sentence goes in the
  // title for accessibility.
  function updateDoneBtn() {
    var n = checkedCount();
    var known = {};
    state.items.forEach(function (it) { known[it.name] = true; });
    var total = state.items.length;
    state.pendingAdds.forEach(function (pa) {
      if (!known[pa.name]) total++;
    });
    var words = t("itemsChecked");
    doneCount.classList.toggle("collapse", n === 0);
    if (n > 0) {
      doneCount.textContent = "";
      doneCount.appendChild(iconImg("check", 13));
      doneCount.appendChild(document.createTextNode(n + "/" + total));
      doneCount.title = tf("doneButton",
          n + "/" + total + " " + (n <= 1 ? words[0] : words[1]));
    }
  }

  // Append the quantity as an inline pill right after the item name —
  // stays on the name line so it costs no extra row height.
  function qtyNote(parent, qty) {
    if (!qty) return;
    var nEl = document.createElement("span");
    nEl.className = "qtychip";
    nEl.textContent = qty;
    parent.appendChild(nEl);
  }

  // Delete one shopping item: drop the pending add if it was never synced,
  // otherwise queue a server-side removal. No confirmation needed; an
  // Undo toast restores the row for 5s.
  function deleteItem(name, pending) {
    var snapshot = { name: name, qty: "", cat: "other", checked: false, pending: pending };
    if (pending) {
      state.pendingAdds.forEach(function (pa) { if (pa.name === name) snapshot.qty = pa.qty; });
      state.pendingAdds = state.pendingAdds.filter(function (pa) {
        return pa.name !== name;
      });
    } else {
      state.items.forEach(function (it) {
        if (it.name === name) { snapshot.qty = it.qty; snapshot.cat = it.cat || "other"; }
      });
      snapshot.checkTs = state.checks[name] || null;
      if (state.pendingDone.indexOf(name) < 0) state.pendingDone.push(name);
      delete state.checks[name];
      state.items = state.items.filter(function (it) { return it.name !== name; });
    }
    save();
    render();
    flush();
    showToast(t("deleted"), t("undo"), function () {
      // If the removal was still queued, cancel it; if it already went
      // out, re-add the item as a pending add instead.
      var i = state.pendingDone.indexOf(snapshot.name);
      if (!snapshot.pending && i >= 0) {
        state.pendingDone.splice(i, 1);
        state.items.push({ name: snapshot.name, qty: snapshot.qty, cat: snapshot.cat });
        if (snapshot.checkTs) state.checks[snapshot.name] = snapshot.checkTs;
      } else {
        state.pendingAdds.push({ name: snapshot.name, qty: snapshot.qty });
      }
      save();
      render();
    });
  }

  // Render one shopping row (check, edit, delete).
  // `cat` tints the checkbox ring + fill per aisle — the color cue
  // costs zero extra width (null -> accent default).
  function appendItem(name, qty, checked, pending, cat) {
    var li = document.createElement("li");
    li.className = "item" + (checked ? " checked" : "");
    li.setAttribute("data-name", name);  // FLIP identity for sink animations
    if (freshNames[name] && Date.now() - freshNames[name] < 5000) {
      li.classList.add("fresh");
    }
    var box = document.createElement("span");
    box.className = "box";
    if (cat) {
      var rc = catRing(cat);
      box.style.setProperty("--rc", rc[0]);
      box.style.setProperty("--rct", rc[1]);
      if (rc[2]) box.style.setProperty("--ckf", "invert(1)");
    }
    setCheck(box, checked);
    var nm = document.createElement("span");
    nm.className = "name";
    nm.textContent = name;
    qtyNote(nm, qty);
    li.appendChild(box);
    li.appendChild(nm);
    if (pending) {
      var tag = document.createElement("span");
      tag.className = "pending-tag";
      tag.textContent = t("pendingTag");
      li.appendChild(tag);
    }
    // Pencil opens the edit sheet; the rest of the row toggles the check.
    var edit = document.createElement("button");
    edit.className = "editbtn";
    edit.appendChild(iconImg("edit", 16));
    edit.addEventListener("click", function (e) {
      e.stopPropagation();
      openItemSheet(name, pending);
    });
    li.appendChild(edit);
    // Small ✕ next to the pencil: one-tap delete.
    var del = document.createElement("button");
    del.className = "editbtn";
    del.appendChild(iconImg("close-muted", 15));
    del.addEventListener("click", function (e) {
      e.stopPropagation();
      deleteItem(name, pending);
    });
    li.appendChild(del);
    li.addEventListener("click", function () {
      if (pending) return;
      if (state.checks[name]) { delete state.checks[name]; }
      else { state.checks[name] = Date.now(); }
      save();
      li.classList.toggle("checked");
      setCheck(box, !!state.checks[name]);
      updateDoneBtn();
      // The row strikes through in place first, then sinks to the done
      // section — an instant move would shift the row under the finger
      // and the next tap would land on the wrong item.
      scheduleSink();
    });
    listEl.appendChild(li);
  }

  // Find a catalog dish by name (case-insensitive); null when absent.
  function dishFor(name) {
    var low = name.toLowerCase(), found = null;
    state.dishes.forEach(function (d) {
      if (d.name.toLowerCase() === low) found = d;
    });
    return found;
  }

  function isUrl(s) { return /^https?:\/\//i.test(s || ""); }

  // Small "↗" link button appended where a dish's source is a URL.
  // In the Android WebView this click is intercepted natively and opened
  // in the system browser; elsewhere target=_blank opens a new tab.
  function srcLink(source) {
    var a = document.createElement("a");
    a.className = "srclink";
    a.href = source;
    a.target = "_blank";
    a.rel = "noopener";
    a.appendChild(iconImg("link", 18));
    a.addEventListener("click", function (e) { e.stopPropagation(); });
    return a;
  }

  // Render one week-menu row (check, re-add ingredients, remove).
  // fresh = entry absent from the previous render → pop-in animation.
  function appendMenuEntry(m, fresh) {
    var li = document.createElement("li");
    li.className = "item dish" + (m.checked ? " checked" : "") + (fresh ? " pop" : "");
    var box = document.createElement("span");
    box.className = "box";
    setCheck(box, !!m.checked);
    var nm = document.createElement("span");
    nm.className = "name";
    nm.textContent = m.name;
    var dish = dishFor(m.name);
    if (dish && dish.source && !isUrl(dish.source)) {
      var sn = document.createElement("span");
      sn.className = "note";
      sn.textContent = dish.source;
      nm.appendChild(sn);
    }
    li.appendChild(box);
    li.appendChild(nm);
    if (dish && isUrl(dish.source)) li.appendChild(srcLink(dish.source));

    // Remove from the week menu (does not touch bought ingredients).
    // Same undo contract as item deletion: a 5s toast puts the entry
    // back — re-added with no_items so its ingredients are NOT
    // re-pushed (they were never removed).
    function removeMenuEntry() {
      var snap = { name: m.name, checked: m.checked };
      var mi = state.menu.indexOf(m);
      queueOp({ op: "unmenu", ref: m.name });
      state.menu = state.menu.filter(function (x) {
        return x.name.toLowerCase() !== m.name.toLowerCase();
      });
      save();
      render();
      flush();
      showToast(t("menuRemoved"), t("undo"), function () {
        var qi = -1;
        state.pendingOps.forEach(function (op, j) {
          if (op.op === "unmenu" && op.ref === snap.name) qi = j;
        });
        if (qi >= 0) state.pendingOps.splice(qi, 1);
        else {
          queueOp({ op: "menu", name: snap.name, no_items: true });
          // The re-added entry comes back unchecked server-side —
          // restore the cooked flag too.
          if (snap.checked) {
            queueOp({ op: "menucheck", ref: snap.name, checked: true });
          }
        }
        state.menu.splice(Math.min(mi, state.menu.length), 0, {
          uid: "local-" + Date.now(), name: snap.name, checked: snap.checked,
        });
        save();
        render();
        flush();
      });
    }
    var rm = document.createElement("button");
    rm.className = "editbtn";
    rm.appendChild(iconImg("close-muted", 15));
    rm.addEventListener("click", function (e) {
      e.stopPropagation();
      removeMenuEntry();
    });
    li.appendChild(rm);

    li.addEventListener("click", function () {
      // Optimistic toggle; the flag is shared via the server (queued offline).
      m.checked = !m.checked;
      save();
      li.classList.toggle("checked");
      setCheck(box, !!m.checked);
      queueOp({ op: "menucheck", ref: m.name, checked: m.checked });
      flush();
    });
    menuListEl.appendChild(li);
  }

  // Green/red connectivity+sync indicator. "off" also when the realtime
  // stream is dead — poll-only mode should not look like a healthy sync.
  var sseAlive = false;
  function updateDot() {
    var busy = state.pendingAdds.length > 0 || state.pendingDone.length > 0 ||
               state.pendingOps.length > 0;
    netdot.className = "dot" + ((!navigator.onLine || busy || !sseAlive) ? " off" : "");
    netdot.title = t("connectivity") + (sseAlive ? "" : " — " + t("pollOnly"));
  }

  // ---- Two-tap confirm (confirm() is a no-op inside Android WebView) -------
  function disarm(btn) {
    btn.dataset.armed = "";
    btn.classList.remove("armed");
    if (btn.dataset.orig !== undefined) btn.innerHTML = btn.dataset.orig;
  }
  // First tap turns the button into "Confirm?" for 3.5s; second tap runs fn.
  function armConfirm(btn, fn) {
    if (btn.dataset.armed) {
      clearTimeout(btn._armTimer);
      disarm(btn);
      fn();
      return;
    }
    btn.dataset.armed = "1";
    btn.dataset.orig = btn.innerHTML;  // innerHTML so icon buttons restore their <img>
    btn.textContent = t("confirmTap");
    btn.classList.add("armed");
    btn._armTimer = setTimeout(function () { disarm(btn); }, 3500);
  }

  // ---- Network -------------------------------------------------------------
  var authFailed = false;

  // POST JSON to the API; throws on !ok, opens settings on 403.
  function postJSON(path, body) {
    var headers = { "Content-Type": "application/json" };
    var token = getToken();
    if (token) headers["X-Listo-Token"] = token;
    return fetch(api(path), {
      method: "POST",
      headers: headers,
      body: JSON.stringify(body || {}),
    }).then(function (r) {
      if (r.status === 403) { onAuthFailed(); throw new Error("403"); }
      if (!r.ok) throw new Error(r.status);
    });
  }

  // Notify once and open settings so the user can fix the code.
  function onAuthFailed() {
    if (authFailed) return;
    authFailed = true;
    showToast(t("unauthorized"));
    openSettings();
  }

  // ---- Pending-op queue ------------------------------------------------------
  // All mutations applied locally are also queued; flush() replays them in
  // order against the API when connectivity allows.
  function queueOp(op) {
    state.pendingOps.push(op);
    save();
  }

  function queueMenuAdd(name) {
    // Add the entry locally if not already there, then queue the mutation.
    var low = name.toLowerCase();
    var exists = state.menu.some(function (m) {
      return m.name.toLowerCase() === low;
    });
    if (!exists) {
      state.menu.push({ uid: "local-" + Date.now(), name: name, checked: false });
      save();
      render();
    }
    queueOp({ op: "menu", name: name });
    flush();
  }

  // Map one queued mutation to its API call.
  function postOp(op) {
    if (op.op === "update") return postJSON("/update", { ref: op.ref, name: op.name, qty: op.qty, category: op.cat });
    if (op.op === "order") return postJSON("/categories", { order: op.order, colors: op.colors, store: op.store });
    if (op.op === "dish") return postJSON("/dishes", { name: op.name, ingredients: op.ingredients, source: op.source || "" });
    if (op.op === "undish") return postJSON("/dishes", { name: op.name, delete: true });
    if (op.op === "menu") return postJSON("/menu", op.no_items ? { name: op.name, no_items: true } : { name: op.name });
    if (op.op === "unmenu") return postJSON("/menu", { ref: op.ref, remove: true });
    if (op.op === "menucheck") return postJSON("/menu", { ref: op.ref, checked: op.checked });
    if (op.op === "add") return postJSON("/add", { item: op.name, qty: op.qty });
    if (op.op === "newcat") return postJSON("/categories", { add: op.label });
    if (op.op === "delcat") return postJSON("/categories", { remove: op.key });
    if (op.op === "newstore") return postJSON("/categories", { add_store: op.name, order: op.order });
    if (op.op === "delstore") return postJSON("/categories", { remove_store: op.name });
    if (op.op === "renamecat") return postJSON("/categories", { rename: op.key, label: op.label });
    return Promise.resolve();
  }

  // Push pending mutations, then refresh the list.
  var flushing = false;
  function flush() {
    if (flushing || !navigator.onLine) { updateDot(); return Promise.resolve(); }
    flushing = true;
    var chain = Promise.resolve();

    state.pendingAdds.slice().forEach(function (pa) {
      chain = chain.then(function () {
        function drop() {
          var i = state.pendingAdds.indexOf(pa);
          if (i >= 0) state.pendingAdds.splice(i, 1);
          save();
        }
        return postJSON("/add", { item: pa.name, qty: pa.qty }).then(drop, function (err) {
          // Drop non-retryable client errors (4xx except 403 auth) so one
          // bad item cannot block the whole queue forever.
          if (/^4/.test(err.message) && err.message !== "403") { drop(); return; }
          throw err;
        });
      });
    });

    state.pendingOps.slice().forEach(function (op) {
      chain = chain.then(function () {
        function drop() {
          var i = state.pendingOps.indexOf(op);
          if (i >= 0) state.pendingOps.splice(i, 1);
          save();
        }
        return postOp(op).then(drop, function (err) {
          if (/^4/.test(err.message) && err.message !== "403") { drop(); return; }
          throw err;
        });
      });
    });

    chain = chain.then(function () {
      if (!state.pendingDone.length) return;
      var names = state.pendingDone.slice();
      var finish = state.shoppingDone;
      return postJSON("/done", { items: names, finish: finish }).then(function () {
        state.pendingDone = [];
        state.shoppingDone = false;
        names.forEach(function (n) { delete state.checks[n]; });
        save();
      });
    });

    return chain.then(function () {
      flushing = false;
      return fetchItems();
    }).catch(function () {
      flushing = false;
      updateDot();
    }).then(function () {
      flushing = false;
      save();
      render();
    });
  }

  // Item names that just appeared via sync (SSE/poll) and were not added
  // locally — rows flash briefly so arrivals are noticeable in-store.
  var freshNames = {};

  // Merge a list payload (from /list or the SSE stream) into local state.
  function applyServerData(data) {
    var names = {};
    var before = {};
    state.items.forEach(function (it) { before[it.name.toLowerCase()] = true; });
    state.pendingAdds.forEach(function (pa) { before[pa.name.toLowerCase()] = true; });
    state.items = (data.items || []).map(function (x) {
      if (typeof x === "string") return { name: x, qty: "" };
      if (x.qty === undefined) x.qty = x.note || "";
      return x;
    });
    state.items.forEach(function (it) {
      names[it.name] = true;
      if (!before[it.name.toLowerCase()]) freshNames[it.name] = Date.now();
    });
    Object.keys(state.checks).forEach(function (k) {
      if (!names[k]) delete state.checks[k];
    });

    state.dishes = (data.dishes || []).map(function (d) {
      d.ingredients = normIngs(d.ingredients);
      return d;
    });
    state.menu = data.menu || [];
    if (data.store_orders && typeof data.store_orders === "object") {
      state.storeOrders = data.store_orders;
    } else if (Array.isArray(data.category_order) && data.category_order.length) {
      state.storeOrders = { "Default": data.category_order };
    }
    if (data.category_colors && typeof data.category_colors === "object") {
      state.colors = data.category_colors;
    }
    if (data.custom_categories && typeof data.custom_categories === "object") {
      state.custom = data.custom_categories;
    }
    if (data.category_labels && typeof data.category_labels === "object") {
      state.catLabels = data.category_labels;
    }
    if (data.version) {
      state.version = data.version;
      checkUpdate();
    }
    // Keep locally-created entries (uid "local-*") that are still queued:
    // the server does not know them yet but they must not flicker away.
    var serverDish = {}, serverMenu = {};
    state.dishes.forEach(function (d) { serverDish[d.name.toLowerCase()] = true; });
    state.menu.forEach(function (m) { serverMenu[m.name.toLowerCase()] = true; });
    state.pendingOps.forEach(function (op) {
      if (op.op === "dish" && !serverDish[op.name.toLowerCase()]) {
        state.dishes.push({ uid: "local", name: op.name, ingredients: op.ingredients, source: op.source || "" });
        serverDish[op.name.toLowerCase()] = true;
      }
      if (op.op === "menu" && !serverMenu[op.name.toLowerCase()]) {
        state.menu.push({ uid: "local", name: op.name, checked: false });
        serverMenu[op.name.toLowerCase()] = true;
      }
      if (op.op === "undish") {
        state.dishes = state.dishes.filter(function (d) {
          return d.name.toLowerCase() !== op.name.toLowerCase();
        });
      }
      if (op.op === "unmenu") {
        state.menu = state.menu.filter(function (m) {
          return m.name.toLowerCase() !== op.ref.toLowerCase();
        });
      }
      // A queued menucheck on an entry the server doesn't know yet (e.g.
      // a locally-added dish) is re-applied on the freshly synced menu.
      if (op.op === "menucheck") {
        state.menu.forEach(function (m) {
          if (m.name.toLowerCase() === op.ref.toLowerCase()) {
            m.checked = op.checked;
          }
        });
      }
      // Same for stores added/removed while offline.
      if (op.op === "newstore") {
        state.storeOrders[op.name] = (op.order || state.order).slice();
      }
      if (op.op === "delstore") {
        storeNames().forEach(function (s) {
          if (s.toLowerCase() === op.name.toLowerCase()) {
            delete state.storeOrders[s];
          }
        });
      }
      // Queued order saves re-apply too — without this a sync landing
      // before the flush completes flashes the pre-edit order back.
      if (op.op === "order" && op.store) {
        state.storeOrders[op.store] = (op.order || []).slice();
        if (op.colors) {
          Object.keys(op.colors).forEach(function (k) {
            state.colors[k] = op.colors[k];
          });
        }
      }
      if (op.op === "newcat") {
        var nk = slugCat(op.label);
        state.custom[nk] = op.label;
        storeNames().forEach(function (s) {
          if (state.storeOrders[s].indexOf(nk) < 0) {
            state.storeOrders[s].push(nk);
          }
        });
      }
      if (op.op === "delcat") {
        delete state.custom[op.key];
        delete state.catLabels[op.key];
        delete state.colors[op.key];
        storeNames().forEach(function (s) {
          state.storeOrders[s] = state.storeOrders[s].filter(function (c) {
            return c !== op.key;
          });
        });
      }
      if (op.op === "renamecat") {
        if (op.label) state.catLabels[op.key] = op.label;
        else delete state.catLabels[op.key];
      }
    });
    // The aisles editor shows live state: refresh its rows when a sync
    // changed them — unless the user is mid-typing in a rename input or
    // mid-drag (the grip never takes focus, so a flag is the guard).
    if (aislesSheetEl.classList.contains("show") && !aisleDragging &&
        !(document.activeElement &&
          document.getElementById("catOrderList")
            .contains(document.activeElement))) {
      renderOrderList();
    }
    // Resync the active store after server data + queued-op replays.
    if (!state.storeOrders[state.store]) {
      state.store = Object.keys(state.storeOrders)[0] || "Default";
    }
    var ord = state.storeOrders[state.store];
    if (Array.isArray(ord) && ord.length) state.order = ord.slice();

    state.updated = data.updated || new Date().toISOString();
    save();
    // Feed the Android wrapper its API credentials + the latest "shopping
    // done" stamp so its background checker never re-notifies what we saw.
    if (window.ListoBridge) {
      try {
        window.ListoBridge.configure(apiBase() || "", getToken() || "");
        if (data.last_done) window.ListoBridge.markDone(data.last_done);
        // Older APKs lack setNotifText — call it last so a TypeError
        // can never skip markDone above.
        if (window.ListoBridge.setNotifText)
          window.ListoBridge.setNotifText(
            t("notifDoneTitle"), t("notifDoneText"));
      } catch (e) {}
    }
  }

  // Download the list from the integration API (fallback path; SSE is the
  // primary realtime channel when reachable).
  function fetchItems() {
    var headers = {};
    var token = getToken();
    if (token) headers["X-Listo-Token"] = token;
    return fetch(api("/list") + "?t=" + Date.now(), { cache: "no-store", headers: headers })
      .then(function (r) {
        if (r.status === 403) { onAuthFailed(); throw new Error("403"); }
        if (!r.ok) throw new Error(r.status);
        return r.json();
      })
      .then(applyServerData);
  }

  // ---- Realtime (Server-Sent Events) ----------------------------------------
  // Every connected device gets "event: list" on each server-side change,
  // so additions appear on other screens with no manual refresh.
  var eventSource = null;
  // Version of this bundled PWA build (bump with the integration).
  var APP_VERSION = "1.4.1";

  // ---- Update banner ----------------------------------------------------------
  // The server reports its own version in /list; when it is newer than the
  // bundled one (old APK / stale PWA cache), a dismissable banner points to
  // the builds page. Dismissal is remembered per version for the session.
  function checkUpdate() {
    var dismissed = null;
    try { dismissed = sessionStorage.getItem("listo-upd-dismissed"); } catch (e) {}
    if (!state.version || state.version === dismissed) return;
    var a = APP_VERSION.split(".").map(Number);
    var b = String(state.version).split(".").map(Number);
    for (var i = 0; i < 3; i++) {
      if ((b[i] || 0) > (a[i] || 0)) {
        document.getElementById("updateTitle").textContent =
          tf("updateTitle", state.version);
        document.getElementById("updateBanner").classList.add("show");
        return;
      }
      if ((b[i] || 0) < (a[i] || 0)) return;
    }
  }
  document.getElementById("updateBannerClose").addEventListener("click", function () {
    document.getElementById("updateBanner").classList.remove("show");
    try {
      sessionStorage.setItem("listo-upd-dismissed", state.version || "");
    } catch (e) {}
  });
  function subscribe() {
    if (eventSource) { eventSource.close(); eventSource = null; }
    var base = apiBase();
    if (!base || typeof EventSource === "undefined") return;
    var url = base + "/api/listo/api/events";
    var token = getToken();
    if (token) url += "?token=" + encodeURIComponent(token);
    eventSource = new EventSource(url);
    eventSource.addEventListener("list", function (e) {
      try {
        applyServerData(JSON.parse(e.data));
        render();
      } catch (err) {}
    });
    eventSource.onopen = function () { sseAlive = true; updateDot(); };
    eventSource.onerror = function () {
      sseAlive = false;
      updateDot();
      // readyState CLOSED (2) means the server refused the connection
      // (4xx/5xx) — the browser does NOT retry in that state, so the stream
      // would stay dead forever. Re-open it after a short delay ourselves.
      if (eventSource && eventSource.readyState === 2) {
        setTimeout(subscribe, 10000);
      }
    };
    // EventSource auto-reconnects on network drops; refused connections
    // are recovered by the onerror handler above.
  }

  // ---- Item edit sheet -------------------------------------------------------
  var editing = null; // {name, pending}
  function openItemSheet(name, pending) {
    editing = { name: name, pending: pending };
    var qty = "", cat = "other";
    if (pending) {
      state.pendingAdds.forEach(function (pa) { if (pa.name === name) qty = pa.qty; });
    } else {
      state.items.forEach(function (it) {
        if (it.name === name) { qty = it.qty; cat = it.cat || "other"; }
      });
    }
    document.getElementById("editName").value = name;
    document.getElementById("editQty").value = qty;
    document.getElementById("editCat").value = cat;
    show(itemSheetEl);
  }

  document.getElementById("editSave").addEventListener("click", function () {
    if (!editing) return;
    var newName = document.getElementById("editName").value.trim();
    var newQty = document.getElementById("editQty").value.trim();
    if (!newName) return;
    var old = editing.name;
    if (editing.pending) {
      state.pendingAdds.forEach(function (pa) {
        if (pa.name === old) { pa.name = newName; pa.qty = newQty; }
      });
    } else {
      var newCat = document.getElementById("editCat").value;
      state.items.forEach(function (it) {
        if (it.name === old) { it.name = newName; it.qty = newQty; it.cat = newCat; }
      });
      if (state.checks[old]) { state.checks[newName] = state.checks[old]; delete state.checks[old]; }
      queueOp({ op: "update", ref: old, name: newName, qty: newQty, cat: newCat });
    }
    editing = null;
    hide(itemSheetEl);
    save();
    render();
    flush();
  });

  document.getElementById("editCancel").addEventListener("click", function () {
    editing = null;
    hide(itemSheetEl);
  });

  // ---- Dish picker + form ----------------------------------------------------
  var editingDish = null; // name of the dish being edited, null = new dish

  // Case + accent insensitive match for the picker search
  // ("pate" must find "Pâtes").
  function fold(s) {
    return (s || "").toLowerCase()
        .normalize("NFD").replace(/[̀-ͯ]/g, "");
  }

  // Rebuild the picker's dish list (called on open and after every change).
  // The search box filters by dish name and non-URL source (e.g. cookbook
  // page notes like "P368 cookeo").
  // The picker has two modes: "menu" (opened from the week-menu section,
  // rows get a "+" to add the dish) and "edit" (opened from the header
  // pencil — same list, no way to touch the week menu).
  var pickerEditMode = false;
  function renderDishPicker() {
    var ul = document.getElementById("dishPickList");
    ul.innerHTML = "";
    var q = fold(document.getElementById("dishSearch").value).trim();
    var inMenu = {};
    state.menu.forEach(function (m) { inMenu[m.name.toLowerCase()] = true; });
    // Alphabetical, accent-insensitive so "Pâtes" sorts with "pates".
    var dishes = state.dishes.slice().sort(function (a, b) {
      return fold(a.name).localeCompare(fold(b.name));
    });
    dishes.forEach(function (d) {
      if (q && fold(d.name).indexOf(q) < 0 &&
          (!d.source || isUrl(d.source) || fold(d.source).indexOf(q) < 0)) {
        return;
      }
      var li = document.createElement("li");
      var nm = document.createElement("span");
      nm.className = "name";
      nm.textContent = d.name;
      if (d.source && !isUrl(d.source)) {
        var src = document.createElement("span");
        src.className = "note";
        src.textContent = d.source;
        nm.appendChild(src);
      }
      li.appendChild(nm);
      // Tapping the row opens the editor (harmless); only the explicit
      // "+" button adds the dish, so accidental touches cannot add a
      // meal by mistake. The picker stays open so a whole week can be
      // planned in one go; dishes already on the menu show a check.
      li.addEventListener("click", function () { openDishForm(d); });
      if (pickerEditMode) { ul.appendChild(li); return; }
      var add = document.createElement("button");
      add.className = "addpick";
      if (inMenu[d.name.toLowerCase()]) {
        li.classList.add("inmenu");
        add.disabled = true;
        add.appendChild(iconImg("check", 16));
      } else {
        add.appendChild(iconImg("plus", 16));
        add.addEventListener("click", function (e) {
          e.stopPropagation();
          queueMenuAdd(d.name);
          // Mark the row in place — a full re-render would lose the
          // picklist scroll position mid-planning.
          inMenu[d.name.toLowerCase()] = true;
          li.classList.add("inmenu");
          add.disabled = true;
          add.innerHTML = "";
          add.appendChild(iconImg("check", 16));
          showToast(t("dishAdded"), t("undo"), function () {
            // Still queued (offline): nothing reached the server, so
            // just drop the op and the local entry — no ingredients to
            // clean. Flushed already: the server rolls back the entry
            // AND the items that add pushed.
            var low = d.name.toLowerCase(), qi = -1;
            state.pendingOps.forEach(function (op, j) {
              if (op.op === "menu" && op.name.toLowerCase() === low) qi = j;
            });
            if (qi >= 0) {
              state.pendingOps.splice(qi, 1);
              state.menu = state.menu.filter(function (x) {
                return x.name.toLowerCase() !== low;
              });
              save();
              render();
            } else {
              // Name-scoped undo: if another device added a dish after
              // ours, the server refuses rather than undoing the wrong
              // add.
              postJSON("/menu", { undo: true, name: d.name })
                .then(fetchItems)
                .catch(function () { showToast(t("restoreFailed")); });
            }
            // Restore the "+" — the dish is off the menu again.
            inMenu[low] = false;
            li.classList.remove("inmenu");
            add.disabled = false;
            add.innerHTML = "";
            add.appendChild(iconImg("plus", 16));
          });
        });
      }
      li.appendChild(add);
      ul.appendChild(li);
    });
  }

  function openPicker(editMode) {
    pickerEditMode = editMode;
    document.getElementById("dishSearch").value = "";
    document.getElementById("dishPickerTitle").textContent =
      t(editMode ? "dishEditTitle" : "dishPickerTitle");
    renderDishPicker();
    show(dishPickerEl);
    document.getElementById("dishSearch").focus();
  }
  document.getElementById("addDishBtn").addEventListener("click", function () {
    openPicker(false);
  });
  document.getElementById("dishEditBtn").addEventListener("click", function () {
    openPicker(true);
  });
  document.getElementById("dishSearch").addEventListener("input", renderDishPicker);
  // Remove every already-cooked (checked) entry from the week menu.
  document.getElementById("clearCooked").addEventListener("click", function () {
    state.menu.forEach(function (m) {
      if (m.checked) queueOp({ op: "unmenu", ref: m.name });
    });
    state.menu = state.menu.filter(function (m) { return !m.checked; });
    save();
    render();
    flush();
  });
  document.getElementById("dishPickerClose").addEventListener("click", function () {
    hide(dishPickerEl);
  });
  document.getElementById("newDishBtn").addEventListener("click", function () {
    openDishForm(null);
  });

  // One ingredient row in the dish form: name + optional qty + remove.
  var ingRows = document.getElementById("ingRows");
  function addIngRow(name, qty) {
    var row = document.createElement("div");
    row.className = "ingrow";
    var n = document.createElement("input");
    n.type = "text"; n.className = "ing-name";
    n.placeholder = t("ingredientPlaceholder"); n.value = name || "";
    var q = document.createElement("input");
    q.type = "text"; q.className = "qty";
    q.placeholder = t("qtyPlaceholder"); q.value = qty || "";
    var x = document.createElement("button");
    x.className = "editbtn"; x.type = "button";
    x.appendChild(iconImg("close-muted", 15));
    x.addEventListener("click", function () { row.remove(); });
    row.appendChild(n); row.appendChild(q); row.appendChild(x);
    ingRows.appendChild(row);
  }
  document.getElementById("addIngBtn").addEventListener("click", function () {
    addIngRow("", "");
  });

  // One-shot recipe import: fetch the URL once via the server, then fill
  // the form — the user edits freely and saves through the normal path.
  document.getElementById("dishImport").addEventListener("click", function () {
    var url = document.getElementById("dishSource").value.trim();
    if (!/^https?:\/\//i.test(url)) return;
    var btn = this;
    btn.disabled = true;
    btn.textContent = t("importing");
    var token = getToken();
    fetch(api("/recipe"), {
      method: "POST",
      headers: { "Content-Type": "application/json",
                 "X-Listo-Token": token || "" },
      body: JSON.stringify({ url: url }),
    }).then(function (r) {
      if (r.status === 403) { onAuthFailed(); throw new Error("403"); }
      if (!r.ok) return r.text().then(function (x) { throw new Error(x || r.status); });
      return r.json();
    }).then(function (data) {
      var nameEl = document.getElementById("dishName");
      if (!nameEl.value.trim() && data.name) nameEl.value = data.name;
      (data.ingredients || []).forEach(function (ing) {
        addIngRow(ing.name, ing.qty);
      });
      // Drop the still-empty placeholder row if imports filled in.
      Array.prototype.forEach.call(ingRows.children, function (row) {
        var n = row.querySelector(".ing-name").value.trim();
        var q = row.querySelector(".qty").value.trim();
        if (!n && !q && ingRows.children.length > 1) row.remove();
      });
      showToast(t("importOk"));
    }).catch(function (err) {
      showToast(tf("importFail", err.message));
    }).then(function () {
      btn.disabled = false;
      btn.textContent = t("importBtn");
    });
  });

  // The recipe link moved off the picker rows into the form — shown
  // whenever the source field currently holds a URL.
  var dishSrcLink = document.getElementById("dishSrcLink");
  function syncSrcLink() {
    var v = document.getElementById("dishSource").value.trim();
    dishSrcLink.style.display = isUrl(v) ? "" : "none";
    if (isUrl(v)) dishSrcLink.href = v;
  }
  document.getElementById("dishSource").addEventListener("input", syncSrcLink);

  // Open the dish editor (d=null for a new dish).
  function openDishForm(d) {
    editingDish = d ? d.name : null;
    document.getElementById("dishName").value = d ? d.name : "";
    document.getElementById("dishSource").value = d && d.source ? d.source : "";
    document.getElementById("dishSource").placeholder = t("sourcePlaceholder");
    syncSrcLink();
    ingRows.innerHTML = "";
    (d ? d.ingredients : []).forEach(function (ing) {
      if (typeof ing === "string") addIngRow(ing, "");
      else addIngRow(ing.name, ing.qty);
    });
    if (!ingRows.children.length) addIngRow("", "");
    document.getElementById("dishDelete").style.display = d ? "" : "none";
    show(dishFormEl);
  }

  document.getElementById("dishSave").addEventListener("click", function () {
    var name = document.getElementById("dishName").value.trim();
    if (!name) return;
    var ings = [];
    Array.prototype.forEach.call(ingRows.children, function (row) {
      var n = row.querySelector(".ing-name").value.trim();
      var q = row.querySelector(".qty").value.trim();
      if (n) ings.push({ name: n, qty: q });
    });
    var source = document.getElementById("dishSource").value.trim();
    if (editingDish && editingDish.toLowerCase() !== name.toLowerCase()) {
      // Renamed: drop the old catalog entry server-side too.
      queueOp({ op: "undish", name: editingDish });
      state.dishes = state.dishes.filter(function (d) {
        return d.name.toLowerCase() !== editingDish.toLowerCase();
      });
    }
    var low = name.toLowerCase();
    var found = null;
    state.dishes.forEach(function (d) {
      if (d.name.toLowerCase() === low) found = d;
    });
    if (found) { found.ingredients = ings; found.source = source; }
    else { state.dishes.push({ uid: "local-" + Date.now(), name: name, ingredients: ings, source: source }); }
    queueOp({ op: "dish", name: name, ingredients: ings, source: source });
    hide(dishFormEl);
    renderDishPicker();
    save();
    flush();
  });

  document.getElementById("dishDelete").addEventListener("click", function () {
    if (!editingDish) return;
    var name = editingDish;
    armConfirm(this, function () {
      queueOp({ op: "undish", name: name });
      state.dishes = state.dishes.filter(function (d) {
        return d.name.toLowerCase() !== name.toLowerCase();
      });
      editingDish = null;
      hide(dishFormEl);
      renderDishPicker();
      save();
      flush();
    });
  });
  document.getElementById("dishCancel").addEventListener("click", function () {
    editingDish = null;
    hide(dishFormEl);
  });

  // ---- Aisles overlay --------------------------------------------------------
  // Row layout: [color][name][✎ rename][↑][↓][× delete]. Every action
  // queues a mutation immediately (same model as dishes/stores), and
  // queued ops replay over incoming syncs so edits cannot snap back.
  // No drag-and-drop: arrows only, so a stray touch cannot move an
  // aisle by accident on a phone.
  var aisleDragging = false;
  function queueOrderOp() {
    queueOp({ op: "order", order: editOrder().slice(),
              colors: state.colors, store: editStore });
    syncActiveOrder();
    save();
    flush();
  }

  function renderOrderList() {
    var box = document.getElementById("catOrderList");
    var ord = editOrder();
    box.innerHTML = "";
    ord.forEach(function (cat, i) {
      var row = document.createElement("div");
      row.className = "orderrow";

      // Drag handle first: hold and slide to reorder. Only the grip
      // starts a drag — a drag over a name field scrolls instead — and
      // being far left keeps it well clear of the delete button.
      var grip = document.createElement("button");
      grip.className = "minibtn grip";
      grip.type = "button";
      grip.appendChild(iconImg("drag", 16));
      (function (idx) {
        // A long-press on the grip would pop the WebView context menu —
        // it fires pointercancel and snaps the row back mid-drag.
        grip.addEventListener("contextmenu", function (e) {
          e.preventDefault();
        });
        grip.addEventListener("pointerdown", function (e) {
          e.preventDefault();
          if (aisleDragging) return;
          try { grip.setPointerCapture(e.pointerId); } catch (_) {}
          var h = row.offsetHeight + 6;
          var y0 = e.clientY, cur = idx;
          var n = box.children.length - 1;
          aisleDragging = true;
          row.classList.add("dragging");
          function move(ev) {
            // Bail out if another action re-rendered the list mid-drag —
            // every captured index/node is stale from then on.
            if (row.parentNode !== box) { finish(false); return; }
            // The dragged row tracks the finger exactly, clamped to the
            // list; DOM order never changes mid-gesture. Displaced
            // neighbours only carry a translateY offset that the CSS
            // transition animates, so they glide instead of jumping.
            var dy = Math.max(-idx * h, Math.min((n - idx) * h,
                                                 ev.clientY - y0));
            row.style.transform = "translateY(" + dy + "px)";
            cur = Math.max(0, Math.min(n, idx + Math.round(dy / h)));
            for (var j = 0; j <= n; j++) {
              var r = box.children[j];
              if (r === row) continue;
              var shift = 0;
              if (cur > idx && j > idx && j <= cur) shift = -h;
              else if (cur < idx && j >= cur && j < idx) shift = h;
              r.style.transform = shift ? "translateY(" + shift + "px)" : "";
            }
          }
          function finish(commit) {
            document.removeEventListener("pointermove", move);
            document.removeEventListener("pointerup", dropIt);
            document.removeEventListener("pointercancel", cancelIt);
            if (row.parentNode === box) {
              // Keep .dragging through the glide (z-index above
              // neighbours); the inline transition overrides the
              // class's transition:none so the row flies to its final
              // slot — or back home on cancel, neighbours included.
              row.style.transition = "transform .18s ease";
              row.style.transform =
                "translateY(" + (commit ? (cur - idx) * h : 0) + "px)";
              if (!commit) {
                for (var j = 0; j < box.children.length; j++) {
                  if (box.children[j] !== row) {
                    box.children[j].style.transform = "";
                  }
                }
              }
              if (commit && cur !== idx) {
                var cat = ord.splice(idx, 1)[0];
                ord.splice(cur, 0, cat);
                queueOrderOp();
              }
            }
            // aisleDragging stays set until the rebuild: a sync landing
            // mid-glide would otherwise tear the row mid-flight, and a
            // second grip press cannot start on stale rows.
            setTimeout(function () {
              aisleDragging = false;
              renderOrderList();
            }, 200);
          }
          function dropIt() { finish(true); }
          function cancelIt() { finish(false); }
          document.addEventListener("pointermove", move);
          document.addEventListener("pointerup", dropIt);
          document.addEventListener("pointercancel", cancelIt);
        });
      })(i);
      row.appendChild(grip);

      // Aisle dot color picker — saved via the order op, shared by all
      // devices. "change" (not "input") so dragging the color wheel does
      // not flood the queue.
      var pick = document.createElement("input");
      pick.type = "color";
      pick.className = "catcolor";
      pick.value = catColor(cat);
      pick.addEventListener("change", function () {
        state.colors[cat] = pick.value;
        queueOrderOp();
      });
      row.appendChild(pick);

      // Every aisle name is an editable box, always shown. It starts
      // read-only — a scroll touch landing on it must not pop the
      // keyboard; a real tap unlocks editing. Enter or leaving commits,
      // Escape reverts, empty snaps back. Re-render only on an actual
      // change so tabbing between inputs keeps focus.
      var inp = document.createElement("input");
      inp.type = "text";
      inp.className = "renamebox";
      inp.value = catLabel(cat);
      inp.readOnly = true;
      (function (c) {
        var unlocking = false;
        inp.addEventListener("click", function () {
          if (inp.readOnly) {
            // The tap already focused the field (readonly focus opens
            // no keyboard). Blur+refocus once editable so the keyboard
            // actually opens on the first tap.
            unlocking = true;
            inp.readOnly = false;
            inp.blur();
            inp.focus();
            unlocking = false;
          }
        });
        inp.addEventListener("keydown", function (e) {
          if (e.key === "Enter") inp.blur();
          else if (e.key === "Escape") { inp.value = catLabel(c); inp.blur(); }
        });
        inp.addEventListener("blur", function () {
          if (unlocking) return;  // blur inside the unlock refocus
          inp.readOnly = true;
          var v = inp.value.trim();
          if (!v) inp.value = catLabel(c);
          else if (v !== catLabel(c)) {
            state.catLabels[c] = v;
            queueOp({ op: "renamecat", key: c, label: v });
            save();
            flush();
            renderOrderList();
          }
        });
      })(cat);
      row.appendChild(inp);

      // Any aisle can be deleted — the defaults are a convenience for
      // first installs, not a lock. armConfirm makes it a 2-tap action.
      var rm = document.createElement("button");
      rm.className = "minibtn";
      rm.appendChild(iconImg("close", 14));
      (function (c) {
        rm.addEventListener("click", function () {
          armConfirm(rm, function () { deleteAisle(c); });
        });
      })(cat);
      row.appendChild(rm);
      box.appendChild(row);
    });
  }

  // Slugify a label into an aisle key (mirrors data.py async_add_category).
  function slugCat(label) {
    var n = label.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    var s = n.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "cat";
    if (DEFAULT_ORDER.indexOf(s) >= 0) s = "custom_" + s;
    var key = s, i = 2;
    while (catExists(key)) {
      key = s + "_" + i; i++;
    }
    return key;
  }

  // True if an aisle key is already taken (built-in, custom, or present
  // in any store's order).
  function catExists(key) {
    return DEFAULT_ORDER.indexOf(key) >= 0 || !!state.custom[key] ||
      storeNames().some(function (s) {
        return state.storeOrders[s].indexOf(key) >= 0;
      });
  }

  // Create a user aisle from the settings input and queue the mutation.
  // The server appends it to every store order; mirror that locally.
  function addCustomCat() {
    var el = document.getElementById("newCatInput");
    var label = el.value.trim();
    if (!label) return;
    var key = slugCat(label);
    state.custom[key] = label;
    storeNames().forEach(function (s) { state.storeOrders[s].push(key); });
    state.order.push(key);
    queueOp({ op: "newcat", label: label });
    el.value = "";
    renderOrderList();
    render();
  }

  // Delete an aisle (built-in or custom) from every store order; items
  // on it fall back to "other". The server hides built-ins rather than
  // forgetting them, so they can be restored via Reset.
  function deleteAisle(cat) {
    queueOp({ op: "delcat", key: cat });
    delete state.custom[cat];
    delete state.catLabels[cat];
    delete state.colors[cat];
    storeNames().forEach(function (s) {
      state.storeOrders[s] = state.storeOrders[s].filter(function (c) {
        return c !== cat;
      });
    });
    state.order = state.order.filter(function (c) { return c !== cat; });
    state.items.forEach(function (it) { if (it.cat === cat) it.cat = "other"; });
    save();
    renderOrderList();
    render();
    flush();
  }

  // ---- Stores (per-store aisle orders) ---------------------------------------
  var storeSel = document.getElementById("storeSel");
  var editStoreSel = document.getElementById("editStoreSel");
  // editStore: the store whose aisle order the settings editor shows.
  // It is independent from state.store (the active store on the list) so
  // any store's order can be edited without switching the shopping view.
  var editStore = null;

  function storeNames() { return Object.keys(state.storeOrders); }

  // The aisle list shown/edited in Settings (the store's order itself).
  function editOrder() { return state.storeOrders[editStore] || []; }

  // Refresh the store selector on the list (hidden with a single store).
  // Rebuilt only when names/active change so an open <select> is not
  // disturbed by routine renders.
  var _storeSig = null;
  function renderStoreSel() {
    var names = storeNames();
    var sig = names.join("") + "|" + state.store;
    if (sig === _storeSig) return;
    _storeSig = sig;
    storeSel.innerHTML = "";
    names.forEach(function (s) {
      var o = document.createElement("option");
      o.value = s; o.textContent = s;
      storeSel.appendChild(o);
    });
    storeSel.value = state.store;
    storeSel.hidden = names.length <= 1;
  }

  // Switch the active store: the shopping list follows its aisle order.
  function switchStore(name) {
    if (!state.storeOrders[name] || name === state.store) return;
    state.store = name;
    state.order = state.storeOrders[name].slice();
    save();
    renderStoreSel();
    render();
  }

  storeSel.addEventListener("change", function () {
    switchStore(storeSel.value);
  });

  // Rebuild the settings store dropdown + its delete button. The last
  // option is a "+ New store…" sentinel: picking it swaps the select
  // for a name field instead of keeping a separate input row.
  var NEW_STORE = "__new__";
  function renderEditStoreSel() {
    editStoreSel.innerHTML = "";
    storeNames().forEach(function (s) {
      var o = document.createElement("option");
      o.value = s; o.textContent = s;
      editStoreSel.appendChild(o);
    });
    var no = document.createElement("option");
    no.value = NEW_STORE;
    no.textContent = "+ " + t("newStorePlaceholder");
    editStoreSel.appendChild(no);
    editStoreSel.value =
      state.storeOrders[editStore] ? editStore : storeNames()[0];
    document.getElementById("delStoreBtn").hidden = storeNames().length <= 1;
  }

  // Pick which store's order the editor shows — or create one via the
  // sentinel option.
  editStoreSel.addEventListener("change", function () {
    if (editStoreSel.value === NEW_STORE) {
      var rowEl = editStoreSel.parentNode;
      var inp = document.createElement("input");
      inp.type = "text";
      inp.placeholder = t("newStorePlaceholder");
      rowEl.replaceChild(inp, editStoreSel);
      inp.focus();
      var closed = false;
      function done(commit) {
        if (closed) return;
        closed = true;
        rowEl.replaceChild(editStoreSel, inp);
        if (commit) addStore(inp.value.trim());
        else renderEditStoreSel();
      }
      inp.addEventListener("keydown", function (e) {
        if (e.key === "Enter") done(true);
        else if (e.key === "Escape") done(false);
      });
      inp.addEventListener("blur", function () { done(true); });
      return;
    }
    if (!state.storeOrders[editStoreSel.value]) return;
    editStore = editStoreSel.value;
    renderOrderList();
  });

  // Create a store whose order starts as a copy of the edited one.
  function addStore(name) {
    var dup = storeNames().some(function (s) {
      return s.toLowerCase() === name.toLowerCase();
    });
    if (!name || dup) { renderEditStoreSel(); return; }
    var base = editOrder().length ? editOrder() : state.order;
    state.storeOrders[name] = base.slice();
    queueOp({ op: "newstore", name: name, order: base.slice() });
    editStore = name;
    renderEditStoreSel();
    renderStoreSel();
    renderOrderList();
    flush();
  }

  // Delete the store shown in the editor (server keeps at least one).
  var delStoreBtn = document.getElementById("delStoreBtn");
  delStoreBtn.addEventListener("click", function () {
    if (storeNames().length <= 1) return;
    armConfirm(delStoreBtn, function () {
      var name = editStore;
      delete state.storeOrders[name];
      queueOp({ op: "delstore", name: name });
      if (state.store === name) {
        state.store = storeNames()[0];
        state.order = state.storeOrders[state.store].slice();
      }
      editStore = storeNames()[0];
      save();
      renderEditStoreSel();
      renderStoreSel();
      renderOrderList();
      render();
      flush();
    });
  });

  // Populate and open the settings overlay.
  // ---- Dish catalog backup ----------------------------------------------------
  // One overlay serves both directions: "export" fills the textarea with
  // the catalog JSON (read-only, Copy button); "import" leaves it empty
  // and validates whatever is pasted in. Textarea-based rather than file
  // download/upload because Android WebView lacks both without native code.
  var backupSheetEl = document.getElementById("backupSheet");
  var backupText = document.getElementById("backupText");
  // The same overlay backs up the dish catalog (shared, in HA) and the
  // loyalty cards (device-local) — `backupKind` picks the payload and
  // the apply logic.
  var backupKind = "dishes";

  function openBackup(mode, kind) {
    backupKind = kind || "dishes";
    var isCards = backupKind === "cards";
    var titleKey = mode === "export"
      ? (isCards ? "cardsBackupExport" : "backupExportTitle")
      : (isCards ? "cardsBackupImport" : "backupImportTitle");
    document.getElementById("backupTitle").textContent = t(titleKey);
    document.getElementById("backupCopy").hidden = mode !== "export";
    document.getElementById("backupApply").hidden = mode !== "import";
    backupText.readOnly = mode === "export";
    backupText.value = "";
    if (mode === "export") {
      backupText.value = isCards
        ? JSON.stringify(cards, null, 2)
        : JSON.stringify(state.dishes.map(function (d) {
            return {
              name: d.name,
              ingredients: d.ingredients || [],
              source: d.source || "",
            };
          }), null, 2);
    }
    show(backupSheetEl);
  }

  document.getElementById("exportDishes").addEventListener("click", function () {
    openBackup("export", "dishes");
  });
  document.getElementById("importDishes").addEventListener("click", function () {
    openBackup("import", "dishes");
  });
  document.getElementById("exportCards").addEventListener("click", function () {
    openBackup("export", "cards");
  });
  document.getElementById("importCards").addEventListener("click", function () {
    openBackup("import", "cards");
  });
  document.getElementById("backupClose").addEventListener("click", function () {
    hide(backupSheetEl);
  });
  document.getElementById("backupCopy").addEventListener("click", function () {
    backupText.select();
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(backupText.value);
      } else {
        document.execCommand("copy");
      }
      showToast(t("copied"));
    } catch (e) { /* clipboard unavailable — user selects+copies manually */ }
  });
  document.getElementById("backupApply").addEventListener("click", function () {
    var arr = null;
    try { arr = JSON.parse(backupText.value); } catch (e) {}
    if (!Array.isArray(arr)) { showToast(t("backupBad")); return; }
    var n = 0;
    if (backupKind === "cards") {
      // Local cards: append valid entries (name + number required).
      arr.forEach(function (d) {
        if (!d || typeof d.name !== "string" || !d.name.trim()
            || typeof d.code !== "string" || !d.code.trim()) return;
        cards.push({
          id: d.id || Date.now() + "-" + n,
          name: d.name.trim(), code: d.code.trim(),
          fmt: typeof d.fmt === "string" ? d.fmt : "auto",
          color: /^#[0-9a-f]{6}$/i.test(d.color || "") ? d.color : null,
        });
        n++;
      });
      if (!n) { showToast(t("backupBad")); return; }
      saveCards();
      renderCards();
      hide(backupSheetEl);
      showToast(tf("cardsBackupDone", n));
      return;
    }
    arr.forEach(function (d) {
      if (!d || typeof d.name !== "string" || !d.name.trim()) return;
      var name = d.name.trim();
      var ings = normIngs(d.ingredients);
      var source = typeof d.source === "string" ? d.source : "";
      var low = name.toLowerCase(), found = null;
      state.dishes.forEach(function (x) {
        if (x.name.toLowerCase() === low) found = x;
      });
      if (found) {
        found.ingredients = ings;
        found.source = source;
      } else {
        state.dishes.push({
          uid: "local-" + Date.now() + "-" + n,
          name: name, ingredients: ings, source: source,
        });
      }
      queueOp({ op: "dish", name: name, ingredients: ings, source: source });
      n++;
    });
    if (!n) { showToast(t("backupBad")); return; }
    hide(backupSheetEl);
    save();
    flush();
    showToast(tf("backupDone", n));
  });

  function openSettings() {
    document.getElementById("langSelect").value = listoLang();
    document.getElementById("tokenInput").value = getToken();
    var hb = document.getElementById("haBaseInput");
    hb.value = apiBase() === location.origin ? "" : apiBase();
    hb.placeholder = apiBase() || "http://homeassistant.local:8123";
    editStore = state.store;
    // Show the integration version reported by the server (app's own
    // version as fallback before the first sync).
    var v = state.version || APP_VERSION;
    document.getElementById("versionLine").textContent =
      "Listo — HA v" + v + (state.version && state.version !== APP_VERSION
        ? " · app v" + APP_VERSION : "");
    show(settingsEl);
  }

  document.getElementById("newCatBtn").addEventListener("click", addCustomCat);
  document.getElementById("newCatInput").addEventListener("keydown", function (e) {
    if (e.key === "Enter") addCustomCat();
  });
  document.getElementById("settingsBtn").addEventListener("click", openSettings);
  // Refresh state.order from the active store (order edits apply locally
  // right away even before Save sends them to the server).
  function syncActiveOrder() {
    if (state.storeOrders[state.store]) {
      state.order = state.storeOrders[state.store].slice();
    }
  }

  document.getElementById("aislesBtn").addEventListener("click", function () {
    editStore = state.store;
    renderEditStoreSel();
    renderOrderList();
    show(aislesSheetEl);
  });
  document.getElementById("aislesClose").addEventListener("click", function () {
    hide(aislesSheetEl);
    render();
  });
  // Restore the store's default aisle order — also unhides built-ins
  // deleted earlier (an explicit order re-adds them server-side).
  document.getElementById("resetAisles").addEventListener("click", function () {
    var btn = this;
    armConfirm(btn, function () {
      state.storeOrders[editStore] = DEFAULT_ORDER.slice();
      queueOrderOp();
      renderOrderList();
    });
  });
  document.getElementById("closeSettings").addEventListener("click", function () {
    syncActiveOrder();
    hide(settingsEl);
    render();
  });
  document.getElementById("saveSettings").addEventListener("click", function () {
    listoSetLang(document.getElementById("langSelect").value);
    setToken(document.getElementById("tokenInput").value.trim());
    setApiBase(document.getElementById("haBaseInput").value);
    syncActiveOrder();
    authFailed = false;
    hide(settingsEl);
    applyStrings();
    subscribe();
    render();
    flush();
  });

  // ---- Events -----------------------------------------------------------------
  // Queue a new item (name + optional qty) and sync.
  // Adding a name already on the list merges the quantities instead of
  // duplicating the row ("4" + "5" -> "9", "5" + "200g" -> "5 + 200g").
  function addFromInput() {
    var name = input.value.trim();
    if (!name) return;
    var qty = qtyInput.value.trim();
    input.value = "";
    qtyInput.value = "";
    var low = name.toLowerCase(), existing = null, pending = null;
    state.items.forEach(function (it) {
      if (it.name.toLowerCase() === low) existing = it;
    });
    state.pendingAdds.forEach(function (pa) {
      if (pa.name.toLowerCase() === low) pending = pa;
    });
    if (existing) {
      existing.qty = mergeQty(existing.qty, qty);
      // Server merges on /add too — no separate update op needed.
      queueOp({ op: "add", name: name, qty: qty });
    } else if (pending) {
      pending.qty = mergeQty(pending.qty, qty);
    } else {
      state.pendingAdds.push({ name: name, qty: qty });
    }
    save();
    render();
    flush();
  }

  document.getElementById("addBtn").addEventListener("click", addFromInput);
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter") addFromInput();
  });
  qtyInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") addFromInput();
  });

  // Archive all checked items ("finish shopping") — reachable from the
  // minibtn in the checked-section header, which is rebuilt each render.
  function finishShopping() {
    var names = Object.keys(state.checks).filter(function (k) { return state.checks[k]; });
    if (!names.length) return;
    names.forEach(function (n) { if (state.pendingDone.indexOf(n) < 0) state.pendingDone.push(n); });
    state.shoppingDone = true;
    save();
    if (navigator.onLine) {
      flush().then(function () {
        // shoppingDone stays true when the /done call failed — only offer
        // the undo once the server confirmed and stashed the batch.
        if (state.shoppingDone) { showToast(t("listUpdated")); return; }
        showToast(t("listUpdated"), t("undo"), function () {
          // Catch: a server without /restore (older integration) or a
          // network blip must not fail silently.
          postJSON("/restore", {}).then(fetchItems).catch(function () {
            showToast(t("restoreFailed"));
          });
        });
      });
    } else {
      showToast(t("offlineQueued"));
      updateDot();
    }
  }

  // ---- Loyalty cards (device-local, never synced) ---------------------------
  // Stored under their own localStorage key so the feature works fully
  // offline and stays private to each phone — see the README discussion:
  // card numbers are low-sensitivity data, no encryption needed.
  var CARDS_KEY = "listo_cards";
  var cards = (function () {
    try { return JSON.parse(localStorage.getItem(CARDS_KEY)) || []; }
    catch (e) { return []; }
  })();
  function saveCards() {
    try { localStorage.setItem(CARDS_KEY, JSON.stringify(cards)); } catch (e) {}
  }

  var cardsSheetEl = document.getElementById("cardsSheet");
  var cardFormEl = document.getElementById("cardForm");
  var cardViewEl = document.getElementById("cardView");
  var cardFormatSel = document.getElementById("cardFormat");
  var cardNameInp = document.getElementById("cardName");
  var cardNumInp = document.getElementById("cardNumber");
  var cardColorInp = document.getElementById("cardColor");
  // Cards without a chosen color get one from this palette on creation.
  var CARD_PALETTE = ["#4caf50", "#2196f3", "#e91e63", "#ff9800",
                      "#9c27b0", "#009688", "#f44336", "#795548"];
  var editingCard = -1;  // index into cards when editing, -1 = creating

  // Best-guess symbology for "auto": fixed-length numeric formats get
  // their natural type, anything else falls back to Code 128 which
  // accepts arbitrary ASCII.
  function cardFormat(c) {
    if (c.fmt && c.fmt !== "auto") return c.fmt;
    var d = c.code.replace(/\s+/g, "");
    if (/^\d{13}$/.test(d)) return "EAN13";
    if (/^\d{8}$/.test(d)) return "EAN8";
    if (/^\d{12}$/.test(d)) return "UPC";
    return "CODE128";
  }

  // Perceived luminance of a #rrggbb color (0 = black, 1 = white).
  function lumOf(hex) {
    var n = parseInt(hex.slice(1), 16);
    return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255)
            + 0.114 * (n & 255)) / 255;
  }

  // Card search: accent-folded substring match on the card name.
  var cardQuery = "";
  var cardsSearchInp = document.getElementById("cardsSearch");
  function cardMatches(c) {
    var fold = function (s) {
      return s.toLowerCase()
        .normalize("NFD").replace(/[̀-ͯ]/g, "");
    };
    return !cardQuery || fold(c.name).indexOf(fold(cardQuery)) >= 0;
  }

  function renderCards() {
    var ul = document.getElementById("cardsList");
    ul.innerHTML = "";
    document.getElementById("cardsHint").hidden = cards.length > 0;
    cardsSearchInp.hidden = cards.length === 0;
    cards.forEach(function (c, i) {
      if (!cardMatches(c)) return;
      var li = document.createElement("li");
      // The whole row wears the card's color — a light color flips the
      // row to dark text/icons via the .light class.
      li.className = "cardrow";
      var hex = /^#[0-9a-f]{6}$/i.test(c.color || "") ? c.color : null;
      li.style.setProperty("--rowbg", hex || "var(--card2)");
      if (hex && lumOf(hex) > 0.55) li.classList.add("light");
      var nm = document.createElement("span");
      nm.className = "name";
      nm.textContent = c.name;
      li.appendChild(nm);
      var ed = document.createElement("button");
      ed.className = "editbtn";
      ed.style.setProperty("--ico", "url(img/edit.svg)");
      ed.addEventListener("click", function (e) {
        e.stopPropagation();
        openCardForm(i);
      });
      li.appendChild(ed);
      li.addEventListener("click", function () { openCardView(c); });
      ul.appendChild(li);
    });
  }

  // Keep the screen on while the barcode is shown — checkout scanners
  // are slow. Unsupported browsers just skip this.
  var wakeLock = null;
  function keepAwake(on) {
    if (on) {
      if ("wakeLock" in navigator) {
        navigator.wakeLock.request("screen").then(function (w) {
          wakeLock = w;
        }).catch(function () {});
      }
    } else if (wakeLock) {
      wakeLock.release();
      wakeLock = null;
    }
  }

  function drawBarcode(svg, code, fmt) {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    if (fmt === "QR") {
      // qrcode-generator: type 0 = auto-size, "M" error correction.
      // Dark modules are emitted as a single path for a clean render.
      var qr = qrcode(0, "M");
      qr.addData(code);
      qr.make();
      var mc = qr.getModuleCount(), margin = 4;
      var d = "";
      for (var r = 0; r < mc; r++)
        for (var col = 0; col < mc; col++)
          if (qr.isDark(r, col))
            d += "M" + (col + margin) + " " + (r + margin) + "h1v1h-1z";
      svg.setAttribute("viewBox",
        "0 0 " + (mc + margin * 2) + " " + (mc + margin * 2));
      var path = document.createElementNS(
        "http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      path.setAttribute("fill", "#000");
      svg.appendChild(path);
      return;
    }
    JsBarcode(svg, code, {
      format: fmt, displayValue: false, margin: 0,
      width: 2.4, height: 165, background: "#fff", lineColor: "#000"
    });
  }

  function openCardView(c) {
    document.getElementById("cardViewName").textContent = c.name;
    // The card's color fills the screen around the white card.
    cardViewEl.style.background =
      /^#[0-9a-f]{6}$/i.test(c.color || "") ? c.color : "#11191a";
    document.getElementById("cardViewNum").textContent = c.code;
    var svg = document.getElementById("cardSvg");
    var d = c.code.replace(/\s+/g, "");
    try {
      drawBarcode(svg, d, cardFormat(c));
    } catch (e) {
      // The chosen symbology rejected the digits (e.g. bad EAN checksum)
      // — Code 128 accepts anything; a readable code beats a blank view.
      drawBarcode(svg, d, "CODE128");
    }
    show(cardViewEl);
    keepAwake(true);
  }
  cardViewEl.addEventListener("click", function () {
    hide(cardViewEl);
    keepAwake(false);
  });
  // Any hide path must release the wake lock — the Android back button
  // closes overlays through __listoBack and would otherwise leave the
  // screen on forever. Watching .show covers every close path.
  new MutationObserver(function () {
    if (!cardViewEl.classList.contains("show")) keepAwake(false);
  }).observe(cardViewEl, { attributes: true, attributeFilter: ["class"] });

  document.getElementById("cardsBtn").addEventListener("click", function () {
    renderCards();
    show(cardsSheetEl);
  });
  cardsSearchInp.addEventListener("input", function () {
    cardQuery = this.value.trim();
    renderCards();
  });
  document.getElementById("cardsClose").addEventListener("click", function () {
    hide(cardsSheetEl);
  });
  // idx=-1 opens the blank "new card" form, idx>=0 pre-fills for edit.
  function openCardForm(idx) {
    editingCard = idx;
    var c = idx >= 0 ? cards[idx] : null;
    document.getElementById("cardFormTitle").textContent =
      t(idx >= 0 ? "cardEditTitle" : "cardFormTitle");
    cardNameInp.value = c ? c.name : "";
    cardNumInp.value = c ? c.code : "";
    cardFormatSel.value = c ? c.fmt : "auto";
    cardColorInp.value = c && c.color ? c.color
      : CARD_PALETTE[cards.length % CARD_PALETTE.length];
    cardDeleteBtn.style.display = idx >= 0 ? "" : "none";
    show(cardFormEl);
    cardNameInp.focus();
  }
  document.getElementById("addCardBtn").addEventListener("click", function () {
    openCardForm(-1);
  });
  document.getElementById("cardCancel").addEventListener("click", function () {
    hide(cardFormEl);
  });
  var cardDeleteBtn = document.getElementById("cardDelete");
  cardDeleteBtn.addEventListener("click", function () {
    if (editingCard < 0) return;
    var idx = editingCard;
    armConfirm(this, function () {
      cards.splice(idx, 1);
      saveCards();
      renderCards();
      hide(cardFormEl);
      showToast(t("cardDeleted"));
    });
  });
  function saveCardForm() {
    var name = cardNameInp.value.trim();
    var num = cardNumInp.value.trim();
    if (!name || !num) return;
    var c = editingCard >= 0 ? cards[editingCard]
      : { id: Date.now() };
    c.name = name;
    c.code = num;
    c.fmt = cardFormatSel.value;
    c.color = cardColorInp.value;
    // Validate against the symbology before storing — the scanner view
    // should never hold an unrenderable card.
    try {
      drawBarcode(document.createElementNS(
        "http://www.w3.org/2000/svg", "svg"),
        num.replace(/\s+/g, ""), cardFormat(c));
    } catch (e) {
      showToast(t("cardInvalid"));
      return;
    }
    if (editingCard < 0) cards.push(c);
    saveCards();
    renderCards();
    hide(cardFormEl);
  }
  document.getElementById("cardSave").addEventListener("click", saveCardForm);
  cardNumInp.addEventListener("keydown", function (e) {
    if (e.key === "Enter") saveCardForm();
  });

  // Photo scan: <input capture> opens the camera on phones (the APK
  // forwards it to a camera/gallery chooser — see MainActivity's
  // onShowFileChooser). Decode prefers the built-in BarcodeDetector;
  // Quagga is the lazy-loaded offline fallback.
  var cardPhotoInp = document.getElementById("cardPhoto");
  document.getElementById("cardScan").addEventListener("click", function () {
    cardPhotoInp.click();
  });
  cardPhotoInp.addEventListener("change", function () {
    var f = cardPhotoInp.files && cardPhotoInp.files[0];
    cardPhotoInp.value = "";  // re-picking the same photo must refire
    if (f) scanCardPhoto(f);
  });

  var cardScanning = false;
  function fmtFromScan(f) {
    return {
      ean_13: "EAN13", ean_8: "EAN8",
      upc_a: "UPC", upc_e: "UPC", code_128: "CODE128", qr_code: "QR"
    }[f] || "CODE128";
  }
  function scanCardPhoto(file) {
    if (cardScanning) return;
    cardScanning = true;
    showToast(t("cardScanning"));
    var url = URL.createObjectURL(file);
    var done = function (code, fmt) {
      cardScanning = false;
      URL.revokeObjectURL(url);
      if (code) {
        cardNumInp.value = code;
        if (fmt) cardFormatSel.value = fmt;
        showToast(t("cardScanned"));
      } else {
        showToast(t("cardScanFailed"));
      }
    };
    if (window.BarcodeDetector) {
      var img = new Image();
      img.onload = function () {
        new BarcodeDetector().detect(img).then(function (codes) {
          var c = codes && codes[0];
          if (c) done(c.rawValue, fmtFromScan(c.format));
          else jsqrDecode(url, done);
        }).catch(function () { jsqrDecode(url, done); });
      };
      img.onerror = function () { jsqrDecode(url, done); };
      img.src = url;
    } else {
      jsqrDecode(url, done);
    }
  }
  function jsqrDecode(url, done) {
    // jsQR (~130 KB) is lazy-loaded like Quagga; it covers QR codes,
    // which neither Quagga nor some BarcodeDetector builds can read.
    // A miss falls through to Quagga for the linear symbologies.
    var run = function () {
      var img = new Image();
      img.onload = function () {
        var res = null;
        try {
          // Downscale huge photos — QR decoding doesn't need 12 MP.
          var w = img.naturalWidth, h = img.naturalHeight;
          var k = Math.min(1, 1600 / Math.max(w, h));
          var cv = document.createElement("canvas");
          cv.width = Math.round(w * k); cv.height = Math.round(h * k);
          var ctx = cv.getContext("2d");
          ctx.drawImage(img, 0, 0, cv.width, cv.height);
          var d = ctx.getImageData(0, 0, cv.width, cv.height);
          res = jsQR(d.data, d.width, d.height);
        } catch (e) {}
        if (res && res.data) done(res.data, "QR");
        else quaggaDecode(url, done);
      };
      img.onerror = function () { quaggaDecode(url, done); };
      img.src = url;
    };
    if (window.jsQR) { run(); return; }
    var s = document.createElement("script");
    s.src = "jsqr.min.js";
    s.onload = run;
    s.onerror = function () { quaggaDecode(url, done); };
    document.head.appendChild(s);
  }
  function quaggaDecode(url, done) {
    // Quagga (~157 KB) is lazy-loaded so it costs nothing until a user
    // actually scans; the file is precached by the service worker.
    var run = function () {
      Quagga.decodeSingle({
        src: url, numOfWorkers: 0,
        inputStream: { size: 1400 },
        decoder: { readers: [
          "ean_reader", "ean_8_reader", "upc_reader", "upc_e_reader",
          "code_128_reader", "code_39_reader", "codabar_reader",
          "i2of5_reader"
        ] },
        locate: true
      }, function (res) {
        var cr = res && res.codeResult;
        done(cr ? cr.code : null, cr ? fmtFromScan(cr.format) : null);
      });
    };
    if (window.Quagga) { run(); return; }
    var s = document.createElement("script");
    s.src = "quagga.min.js";
    s.onload = run;
    s.onerror = function () { done(null); };
    document.head.appendChild(s);
  }
  // The Android back button releases the wake lock too — cardViewEl is a
  // plain overlay so __listoBack already closes it, just re-hook its side.
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && cardViewEl.classList.contains("show")) keepAwake(true);
  });

  // ---- Keyboard-dismissed caret fix ------------------------------------------
  // Dismissing the soft keyboard (back gesture) does not blur the
  // focused field — a rename box would keep a blinking caret over a
  // locked-looking row. The visual viewport shrinks while the keyboard
  // is up (adjustResize and adjustPan alike), so when it grows back to
  // full height, blur the rename box: its blur handler re-locks it.
  if (window.visualViewport) {
    var vv = window.visualViewport;
    var vvKbOpen = false;
    function vvCheck() {
      var open = vv.height < screen.height * 0.7;
      var el = document.activeElement;
      if (vvKbOpen && !open && el && el.classList &&
          (el.classList.contains("renamebox") || addRow.contains(el))) {
        el.blur();
      }
      vvKbOpen = open;
    }
    vv.addEventListener("resize", vvCheck);
    vv.addEventListener("scroll", vvCheck);
  }

  // ---- Pull-to-refresh -------------------------------------------------------
  // Drag down >75px while scrolled to top triggers a sync. Only vertical
  // drags starting on empty areas count — inputs, overlays and item rows
  // keep their own gestures.
  var ptrEl = document.getElementById("ptr");
  var ptrY0 = null, ptrDy = 0;
  document.addEventListener("touchstart", function (e) {
    if (window.scrollY <= 0 &&
        !e.target.closest("input,textarea,select,button,a,.overlay")) {
      ptrY0 = e.touches[0].clientY;
    }
  }, { passive: true });
  document.addEventListener("touchmove", function (e) {
    if (ptrY0 === null) return;
    ptrDy = e.touches[0].clientY - ptrY0;
    if (ptrDy > 8 && window.scrollY <= 0) {
      e.preventDefault();  // hijack the pull once it is clearly downward
      var pull = Math.min(ptrDy, 110);
      ptrEl.style.transform = "translateY(" + pull * 0.5 + "px)";
      ptrEl.style.opacity = Math.min(1, pull / 70);
    }
  }, { passive: false });
  document.addEventListener("touchend", function () {
    if (ptrY0 !== null && ptrDy > 75) {
      flush();
      showToast(t("refreshing"));
    }
    ptrY0 = null; ptrDy = 0;
    ptrEl.style.transform = "";
    ptrEl.style.opacity = "";
  });

  // Auto-hiding header: scroll down past the header slides it away,
  // any scroll up (or back to the top) brings it back. Small deltas
  // are ignored so the bar doesn't jitter during tiny movements.
  var headerEl = document.querySelector("header");
  var lastScrollY = 0;
  window.addEventListener("scroll", function () {
    var y = window.scrollY;
    if (y > 56 && y > lastScrollY + 4) {
      headerEl.classList.add("hidden-hdr");
    } else if (y < lastScrollY - 4 || y <= 56) {
      headerEl.classList.remove("hidden-hdr");
    }
    lastScrollY = y;
  }, { passive: true });

  window.addEventListener("online", function () { updateDot(); flush(); subscribe(); });
  window.addEventListener("offline", updateDot);

  // Back to foreground: a suspended WebView/tab can leave the SSE stream
  // silently dead (readyState stays OPEN, no error fires). Re-subscribing
  // is the only reliable recovery — it also drains the offline queue.
  function resumeSync() {
    updateDot();
    if (navigator.onLine) flush();
    subscribe();
  }
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) resumeSync();
  });
  // pageshow persisted = page restored from the back/forward cache.
  window.addEventListener("pageshow", function (e) {
    if (e.persisted) resumeSync();
  });

  // Safety net on top of SSE: re-sync once a minute while the app is open.
  setInterval(function () { if (navigator.onLine) flush(); }, 60000);

  // Service worker: lets the app reopen with no network at all (browsers).
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(function () {});
  }

  // Warn when running inside the Home Assistant companion webview,
  // which closes the page as soon as the server connection drops.
  if (/home.?assistant/i.test(navigator.userAgent) &&
      !localStorage.getItem("listo-warn-dismissed")) {
    document.getElementById("haWarn").classList.add("show");
  }
  document.getElementById("haWarnClose").addEventListener("click", function () {
    document.getElementById("haWarn").classList.remove("show");
    localStorage.setItem("listo-warn-dismissed", "1");
  });

  // Expose a sync trigger to the Android wrapper (see MainActivity).
  window.listoFlush = flush;

  applyStrings();
  subscribe();
  if (navigator.onLine) flush();
  // First run inside the APK with no server URL yet: open Settings.
  if (!apiBase()) openSettings();
})();
