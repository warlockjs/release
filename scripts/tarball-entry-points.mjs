/**
 * Guard against a "hollow" tarball -- a package whose pre-pack BUILD
 * DIRECTORY contains every file its manifest promises (the directory-based
 * entry-point guard already checks that), but whose `files` allowlist or
 * `.npmignore` rules quietly excluded those same files from the tarball
 * `npm pack` actually produced. Such a package installs fine and its
 * manifest looks correct, but `require`/`import` (or its `bin`) fails at
 * the consumer the moment they try to use it.
 *
 * This module is deliberately independent of the directory-based guard: it
 * reasons only about the tarball's own flat entry list, and it additionally
 * checks `bin` -- a field the directory guard does not check at all.
 */

/** Collect the local files a package manifest promises consumers can resolve. */
export function collectTarballEntryTargets(manifest) {
  const targets = new Set();
  addPathTarget(manifest.main, targets);
  addPathTarget(manifest.module, targets);
  addPathTarget(manifest.types, targets);
  addPathTarget(manifest.typings, targets);
  addBinTargets(manifest.bin, targets);
  addExportTargets(manifest.exports, targets);
  return targets;
}

function addPathTarget(value, targets) {
  if (typeof value !== "string" || value.length === 0) return;
  targets.add(value);
}

function addBinTargets(value, targets) {
  if (typeof value === "string") {
    addPathTarget(value, targets);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const target of Object.values(value)) addPathTarget(target, targets);
}

/** Walk an `exports` map. A `null` target and a `*` glob subpath/target are both
 * left unverifiable by design -- a glob names a family of files, not one concrete
 * path, and `null` explicitly blocks that condition/subpath from resolving. */
function addExportTargets(value, targets) {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    addPathTarget(value, targets);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) addExportTargets(item, targets);
    return;
  }
  if (typeof value === "object") {
    for (const [key, target] of Object.entries(value)) {
      if (key.includes("*")) continue;
      addExportTargets(target, targets);
    }
  }
}

/** Normalise a manifest-declared or tarball-observed path so the two compare
 * equal regardless of a leading "./", a leading "package/" pack prefix,
 * backslashes, or a trailing slash. */
function normalize(value) {
  return value
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^package\//, "")
    .replace(/\/$/, "");
}

/**
 * Assert that a packed tarball actually contains every entry point its own
 * manifest promises. `entryPaths` is the flat list of paths the tarball's tar
 * stream actually contains (e.g. "package/esm/index.js").
 *
 * Throws naming the package, every missing declared path, and calling out
 * that the tarball is hollow -- with `files`/`.npmignore` named as the
 * likely cause, since that is the one place a full build directory and a
 * thin tarball diverge.
 */
export function assertTarballContainsItsEntryPoints(name, manifest, entryPaths) {
  const targets = collectTarballEntryTargets(manifest);
  if (targets.size === 0) return;

  const available = new Set([...entryPaths].map(normalize));
  const missing = [];
  for (const target of targets) {
    if (target.includes("*")) continue; // glob/pattern target -- nothing concrete to verify
    if (!available.has(normalize(target))) missing.push(target);
  }
  if (missing.length === 0) return;

  throw new Error(
    `${name}: packed tarball is hollow -- its package.json declares entry points that are not ` +
      `present in the tarball: ${missing.join(", ")}. This usually means a "files" field or an ` +
      `.npmignore entry in ${name} excluded them from the pack.`,
  );
}
