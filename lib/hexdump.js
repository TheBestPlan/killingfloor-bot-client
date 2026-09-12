// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

'use strict';
// Classic 16-col hexdump with ASCII gutter.
function hexdump(buf, indent = '') {
  const lines = [];
  for (let i = 0; i < buf.length; i += 16) {
    const slice = buf.slice(i, i + 16);
    const hex = [];
    let ascii = '';
    for (let j = 0; j < 16; j++) {
      if (j < slice.length) {
        hex.push(slice[j].toString(16).padStart(2, '0'));
        const c = slice[j];
        ascii += (c >= 0x20 && c < 0x7f) ? String.fromCharCode(c) : '.';
      } else { hex.push('  '); ascii += ' '; }
      if (j === 7) hex.push('');
    }
    lines.push(indent + i.toString(16).padStart(4, '0') + '  ' + hex.join(' ') + '  |' + ascii + '|');
  }
  return lines.join('\n');
}
module.exports = { hexdump };
