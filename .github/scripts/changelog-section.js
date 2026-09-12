// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan
//
// Prints the CHANGELOG.md entry of one version so release.yml can hand it to
// `gh release create --notes-file`. GitHub's own note generation only lists
// pull requests, and this history is made of plain commits.
//
//   node .github/scripts/changelog-section.js 0.1.0 > release-notes.md
//   node .github/scripts/changelog-section.js --self-test
//
// The version may carry a leading "v" (the tag name is passed as is).

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const MISSING_ENTRY = (version) => `No CHANGELOG.md entry for ${version}.`;
const EMPTY_ENTRY = "Maintenance release: no user-facing changes were recorded for this version.";

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Matches the heading commit-and-tag-version writes for a release:
 *   ## 0.1.0 (2026-09-12)
 *   ## [0.2.0](https://host/compare/v0.1.0...v0.2.0) (2026-10-01)
 * The version must end right before whitespace, "(" or "]" so that 0.1.0 never
 * captures the 0.1.0-rc.1 or 0.1.01 entry.
 */
function releaseHeading(version) {
  const v = escapeRegExp(version.replace(/^v/, ""));
  return new RegExp(`^##\\s+\\[?v?${v}(?=[\\s(\\]]|$)(?:\\]\\((\\S+)\\))?`);
}

function changelogSection(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const heading = releaseHeading(version);
  let compareUrl = "";
  let from = -1;

  for (let i = 0; i < lines.length; i++) {
    const hit = heading.exec(lines[i]);
    if (hit) {
      from = i + 1;
      compareUrl = hit[1] || "";
      break;
    }
  }
  if (from === -1) return MISSING_ENTRY(version);

  let to = lines.length;
  for (let i = from; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      to = i;
      break;
    }
  }

  const body = lines.slice(from, to).join("\n").trim() || EMPTY_ENTRY;
  return compareUrl ? `${body}\n\n**Full Changelog**: ${compareUrl}` : body;
}

function selfTest() {
  const log = [
    "# Changelog",
    "",
    "## [0.2.0](https://example.test/compare/v0.1.0...v0.2.0) (2026-10-01)",
    "",
    "### Features",
    "",
    "* **gui:** add a thing",
    "",
    "## 0.1.0 (2026-09-12)",
    "",
    "### Features",
    "",
    "* **net:** first thing",
    "",
    "## 0.1.0-rc.1 (2026-09-01)",
    "",
    "### Bug Fixes",
    "",
    "* rc only",
    "",
  ].join("\n");

  assert.equal(changelogSection(log, "0.1.0"), "### Features\n\n* **net:** first thing");
  assert.equal(changelogSection(log, "v0.1.0"), "### Features\n\n* **net:** first thing");
  assert.equal(
    changelogSection(log, "0.2.0"),
    "### Features\n\n* **gui:** add a thing\n\n**Full Changelog**: https://example.test/compare/v0.1.0...v0.2.0",
  );
  assert.equal(changelogSection(log, "0.1.0-rc.1"), "### Bug Fixes\n\n* rc only");
  assert.equal(changelogSection(log, "9.9.9"), MISSING_ENTRY("9.9.9"));
  assert.equal(changelogSection("# Changelog\n\n## 0.3.0 (2026-11-11)\n\n\n", "0.3.0"), EMPTY_ENTRY);
  assert.equal(changelogSection(log.replace(/\n/g, "\r\n"), "0.1.0"), "### Features\r\n\r\n* **net:** first thing".replace(/\r/g, ""));
  console.log("changelog-section: self-test passed");
}

function main(argv) {
  if (argv[0] === "--self-test") return selfTest();
  const version = argv[0];
  if (!version) {
    console.error("usage: node .github/scripts/changelog-section.js <version|tag> [CHANGELOG.md]");
    process.exit(2);
  }
  const file = argv[1] || path.resolve(process.cwd(), "CHANGELOG.md");
  process.stdout.write(changelogSection(fs.readFileSync(file, "utf8"), version) + "\n");
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { changelogSection };
