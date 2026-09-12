// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

'use strict';
// Self-test for the GUI translations (Setup -> Language). Catches the three ways a locale rots:
// a missing/extra key, a dropped {placeholder} (the string would render "{n}" to the user), and a
// key used by the page or the renderer that no dictionary defines.
// Run: node test/i18n.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'renderer');
const src = fs.readFileSync(path.join(dir, 'i18n.js'), 'utf8');
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(dir, 'renderer.js'), 'utf8');

// i18n.js is a browser script (no module system): run it against a stub window to get its API.
const win = {};
new Function('window', src)(win);
const { DICT, LANGS, t } = win.KFI18N;

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); pass++; console.log('PASS ' + name); };

const enKeys = Object.keys(DICT.en).sort();
const vars = (s) => (s.match(/\{\w+\}/g) || []).sort().join(',');

ok('every README language has a dictionary', LANGS.every(([code]) => !!DICT[code]) && LANGS.length === Object.keys(DICT).length);

for (const [code] of LANGS) {
  const keys = Object.keys(DICT[code]).sort();
  const missing = enKeys.filter((k) => !(k in DICT[code]));
  const extra = keys.filter((k) => !(k in DICT.en));
  ok(code + ': no missing keys' + (missing.length ? ' -> ' + missing.join(', ') : ''), missing.length === 0);
  ok(code + ': no stale keys' + (extra.length ? ' -> ' + extra.join(', ') : ''), extra.length === 0);
  const badVars = enKeys.filter((k) => vars(DICT[code][k] || '') !== vars(DICT.en[k]));
  ok(code + ': placeholders match en' + (badVars.length ? ' -> ' + badVars.join(', ') : ''), badVars.length === 0);
}

// Keys the markup binds to (textContent / innerHTML / title / placeholder).
const htmlKeys = [...html.matchAll(/data-i18n(?:-html|-title|-ph)?="([^"]+)"/g)].map((m) => m[1]);
const unknownHtml = [...new Set(htmlKeys)].filter((k) => !(k in DICT.en));
ok('index.html uses only known keys' + (unknownHtml.length ? ' -> ' + unknownHtml.join(', ') : ''), unknownHtml.length === 0);
ok('index.html actually binds keys', htmlKeys.length > 50);

// Keys the renderer passes to t()/setT(): any 'namespace.name' literal in the file must exist.
const NS = /^(log|sb|map|world|mode|dlg|th|tab|ph|tt|btn|st|f|hint|menu|mi|panel|browser|wave|win|title)\.[A-Za-z0-9]+$/;
const jsKeys = [...renderer.matchAll(/'([^']+)'/g)].map((m) => m[1]).filter((s) => NS.test(s));
const unknownJs = [...new Set(jsKeys)].filter((k) => !(k in DICT.en));
ok('renderer.js uses only known keys' + (unknownJs.length ? ' -> ' + unknownJs.join(', ') : ''), unknownJs.length === 0);

// Fallback + interpolation: an untranslated key falls back to English, an unknown key renders itself.
global.document = { documentElement: {}, querySelectorAll: () => [] };   // apply() walks the page; here there is none
win.KFI18N.apply('ru');
ok('t() interpolates vars', t('sb.objects', { n: 7 }).includes('7'));
ok('t() falls back to en', t('__nope__') === '__nope__' && t('mode.real') !== DICT.en['mode.real']);
win.KFI18N.apply('en');
ok('default language is English', t('btn.connect') === 'Connect');

console.log('\ni18n: ' + pass + '/' + pass + ' checks passed');
