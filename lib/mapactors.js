// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

'use strict';
/*
 * Read the connection's map .rom for actors the server never replicates. Trader volumes
 * (ShopVolume) and trader doors (KFTraderDoor/KFDoorMover) are server-only gameplay actors - a
 * real client knows their positions because it loaded the map, so we read the same map file
 * (lib/kfrom.js, the KF .rom parser) and pull each actor's Location. The map is one of the USES
 * packages that has a matching <name>.rom in the content/Maps dirs the package map already scans.
 */
const fs = require('fs');
const path = require('path');
const kfrom = require('./kfrom');

const TRADER_CLASSES = ['ShopVolume'];
const DOOR_CLASSES = ['KFTraderDoor', 'KFDoorMover', 'Mover'];

function findMapFile(usesOrder, dirs) {
  for (const u of usesOrder || []) {
    for (const d of dirs || []) {
      try { const f = path.join(d, u.name + '.rom'); if (fs.existsSync(f)) return { name: u.name, file: f }; }
      catch (e) {}
    }
  }
  return null;
}

function actorsToPoints(pkg, classNames) {
  const out = [];
  for (const a of kfrom.readActors(pkg, classNames)) {
    const L = a.location;
    if (!Array.isArray(L)) continue;
    const [x, y, z] = L;
    if (![x, y, z].every((v) => Number.isFinite(v))) continue;
    const yaw = Array.isArray(a.rotation) ? (a.rotation[1] || 0) : 0;   // UE rotator [pitch,yaw,roll], 0..65535
    out.push({ name: a.name, x, y, z, yaw });
  }
  return out;
}

// Padded bbox of the actors the game happens around (PathNode/PlayerStart/ShopVolume). Position
// decodes landing outside it are junk even when self-consistent - worldstate gates tracking on this.
function playableBounds(pkg) {
  let n = 0, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const a of kfrom.readActors(pkg, ['PathNode', 'PlayerStart', 'ShopVolume'])) {
    const L = a.location;
    if (!Array.isArray(L) || !L.every(Number.isFinite)) continue;
    n++;
    if (L[0] < minX) minX = L[0]; if (L[0] > maxX) maxX = L[0];
    if (L[1] < minY) minY = L[1]; if (L[1] > maxY) maxY = L[1];
    if (L[2] < minZ) minZ = L[2]; if (L[2] > maxZ) maxZ = L[2];
  }
  if (n < 8) return null;   // too few anchors to trust (custom maps without bot pathing)
  // XY pad covers zed spawn vaults just outside the walkable net; Z pad covers vents below / roofs above.
  return { minX: minX - 2500, maxX: maxX + 2500, minY: minY - 2500, maxY: maxY + 2500, minZ: minZ - 800, maxZ: maxZ + 1200 };
}

// Returns { map, traders:[{name,x,y,z}], doors:[...], bounds } for the map .rom, or null if not found/parsable.
function loadMapActors(usesOrder, dirs) {
  const found = findMapFile(usesOrder, dirs);
  if (!found) return null;
  try {
    const pkg = kfrom.parsePackage(new Uint8Array(fs.readFileSync(found.file)));
    return { map: found.name, traders: actorsToPoints(pkg, TRADER_CLASSES), doors: actorsToPoints(pkg, DOOR_CLASSES), bounds: playableBounds(pkg) };
  } catch (e) {
    return null;
  }
}

module.exports = { loadMapActors, findMapFile };
