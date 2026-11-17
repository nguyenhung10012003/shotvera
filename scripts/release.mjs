#!/usr/bin/env node
// Cuts a release: bumps the version everywhere, commits, tags vX.Y.Z and pushes. Pushing the tag
// starts .github/workflows/release.yml, which builds every platform and publishes the GitHub Release.
//
//   npm run release -- patch            0.1.0 -> 0.1.1
//   npm run release -- minor            0.1.0 -> 0.2.0
//   npm run release -- 1.0.0            explicit version
//   npm run release -- 1.0.0-1          pre-release (numeric ids only: the Windows MSI rejects "-beta")
//   npm run release -- patch --no-push  commit and tag locally only
//
// tauri.conf.json reads its version from package.json, so only the npm and Cargo files change here.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const push = !args.includes("--no-push");
const bump = args.find((a) => !a.startsWith("--"));

const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();
const fail = (msg) => {
  console.error(`release: ${msg}`);
  process.exit(1);
};

if (!bump) fail("usage: npm run release -- <patch|minor|major|X.Y.Z[-N]> [--no-push]");

// --- work out the new version --------------------------------------------------------------
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const current = pkg.version;
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-(\d+))?$/;
const m = VERSION_RE.exec(current);
if (!m) fail(`current version ${current} is not X.Y.Z`);
const [major, minor, patch] = m.slice(1, 4).map(Number);
const next =
  bump === "major" ? `${major + 1}.0.0`
  : bump === "minor" ? `${major}.${minor + 1}.0`
  : bump === "patch" ? (m[4] ? `${major}.${minor}.${patch}` : `${major}.${minor}.${patch + 1}`)
  : bump.replace(/^v/, "");
if (!VERSION_RE.test(next)) {
  fail(`"${next}" is not a valid version. Use X.Y.Z or X.Y.Z-N (pre-release ids must be numeric for the Windows MSI).`);
}
const tag = `v${next}`;

// --- make sure the tree is in a releasable state ------------------------------------------
if (git("status", "--porcelain")) fail("the working tree has uncommitted changes; commit or stash them first");
const branch = git("rev-parse", "--abbrev-ref", "HEAD");
if (branch !== "main") fail(`releases are cut from main (you are on ${branch})`);
if (push) {
  git("fetch", "--quiet", "origin", "main", "--tags");
  if (git("rev-list", "--count", "HEAD..origin/main") !== "0") fail("main is behind origin/main; pull first");
}
if (git("tag", "--list", tag)) fail(`tag ${tag} already exists`);

// --- bump -----------------------------------------------------------------------------------
pkg.version = next;
writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");

const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
lock.version = next;
if (lock.packages?.[""]) lock.packages[""].version = next;
writeFileSync("package-lock.json", JSON.stringify(lock, null, 2) + "\n");

const replaceOnce = (file, re, replacement) => {
  const text = readFileSync(file, "utf8");
  if (!re.test(text)) fail(`could not find the version in ${file}`);
  writeFileSync(file, text.replace(re, replacement));
};
// The first `version =` line in Cargo.toml is the [package] one; dependencies use inline tables.
replaceOnce("src-tauri/Cargo.toml", /^version = "[^"]*"$/m, `version = "${next}"`);
replaceOnce("src-tauri/Cargo.lock", /(\nname = "shotvera"\nversion = )"[^"]*"/, `$1"${next}"`);

// --- commit, tag, push ------------------------------------------------------------------------
git("add", "package.json", "package-lock.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock");
git("commit", "--quiet", "-m", `chore(release): ${tag}`);
git("tag", "-a", tag, "-m", `Shotvera ${next}`);
console.log(`Bumped ${current} -> ${next} and tagged ${tag}.`);

if (!push) {
  console.log(`Not pushed. When ready: git push --atomic origin main ${tag}`);
  process.exit(0);
}
execFileSync("git", ["push", "--atomic", "origin", "main", tag], { stdio: "inherit" });

const remote = git("remote", "get-url", "origin").replace(/^git@github\.com:/, "https://github.com/").replace(/\.git$/, "");
console.log(`\nPushed ${tag}. The release workflow is now building the installers:\n  ${remote}/actions\n  ${remote}/releases/tag/${tag}`);
