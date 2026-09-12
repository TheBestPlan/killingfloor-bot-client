// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

'use strict';
/*
 * Classify a resolved Unreal class name into a map/UI category (player / mon / item / trader / door /
 * mover). The class-ref -> class-name resolution itself lives in PackageMap (pkgmap.js); this is the last
 * step that decides which map layer, if any, an actor of that class belongs to.
 */

const MONSTER_RE = /^Zombie|Husk|Clot|Crawler|Gorefast|Stalker|Bloat|Siren|Scrake|Fleshpound|Patriarch|Brute|KFMonster/i;

function classifyName(name) {
  if (!name) return null;
  if (/ShopVolume|ShopDirectionPointer|TraderPawn|KFShop/i.test(name)) return 'trader';
  // Generic movers (elevators/platforms: Mover, IMover) get their own layer; only door-named movers
  // (KFDoorMover) and trader doors stay under 'door'.
  if (/Mover/i.test(name) && !/Door/i.test(name)) return 'mover';
  if (/DoorMover|TraderDoor|KFDoor|^Door\d/i.test(name)) return 'door';
  if (/Pickup$|Ammo$|AmmoPickup|^Vest$|CashPickup|WeaponLocker|ItemPickup|Pickup[A-Z]/i.test(name)) return 'item';
  if (MONSTER_RE.test(name)) return 'mon';
  if (/^KFHumanPawn$/.test(name)) return 'player';
  return null;   // controllers, effects, etc. are not map entities
}

module.exports = { classifyName };
