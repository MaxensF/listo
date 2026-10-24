// i18n.js — language selection engine.
// Dictionaries live in i18n/<lang>.js and fill LISTO_I18N (loaded after
// this file via <script> tags in index.html).
//
// Usage: t("key") returns the string in the active language;
// tf("key", arg) replaces "%s" placeholders.
// Language is stored in localStorage ("listo-lang"); default = browser.

var LISTO_I18N = {};

var LISTO_LANG_KEY = "listo-lang";

// Active language: stored choice, else browser default (fr if fr-*).
function listoLang() {
  var stored = null;
  try { stored = localStorage.getItem(LISTO_LANG_KEY); } catch (e) {}
  if (stored === "fr" || stored === "en") return stored;
  var nav = (navigator.language || "en").toLowerCase();
  return nav.indexOf("fr") === 0 ? "fr" : "en";
}

function listoSetLang(lang) {
  try { localStorage.setItem(LISTO_LANG_KEY, lang); } catch (e) {}
}

// Translate a key in the active language (fallback: English, then key).
// If a dict file failed to load, degrade to the raw key instead of
// throwing.
function t(key) {
  var dict = LISTO_I18N[listoLang()] || {};
  return dict[key] !== undefined ? dict[key] : ((LISTO_I18N.en || {})[key] || key);
}

// t() + "%s" substitution for every extra argument, in order.
function tf(key) {
  var s = t(key);
  for (var i = 1; i < arguments.length; i++) {
    s = s.replace("%s", arguments[i]);
  }
  return s;
}
