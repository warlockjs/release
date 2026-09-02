import path from "node:path";

/** Collect the local files a package manifest promises consumers can resolve. */
export function collectArtifactEntryPoints(manifest) {
  const targets = new Set();
  collectManifestPath(manifest.main, targets, "main");
  collectManifestPath(manifest.module, targets, "module");
  collectManifestPath(manifest.types, targets, "types");
  collectManifestPath(manifest.typings, targets, "typings");
  collectExportPaths(manifest.exports, targets);
  return targets;
}

/** Assert every local entry declared by a manifest exists in its artifact. */
export function assertArtifactContainsItsEntryPoints(manifest, entries, name) {
  const targets = collectArtifactEntryPoints(manifest);
  if (targets.size === 0) {
    throw new Error(
      `${name}: its package.json declares no main, module, types, typings or exports, so there is nothing to verify. ` +
        "A published package that names no entry point cannot be imported.",
    );
  }

  const available = new Set([...entries].map(normalizeEntry));
  const missing = [];
  for (const target of targets) {
    const normalized = normalizeTarget(target, name);
    const exists = normalized.includes("*")
      ? [...available].some(entry => wildcardTargetExpression(normalized).test(entry))
      : available.has(normalized);
    if (!exists) missing.push(target);
  }
  if (missing.length > 0) {
    throw new Error(
      `${name}: the artifact names entry points it does not contain: ` +
        missing.map(target => `missing packed entry target ${target}`).join(", "),
    );
  }
}

function collectManifestPath(value, targets, field) {
  if (value === undefined) return;
  if (typeof value !== "string") throw new Error(`Built manifest ${field} must be a string.`);
  if (isLocalPathTarget(value, field !== "exports")) targets.add(value);
}

function collectExportPaths(value, targets) {
  if (typeof value === "string") {
    if (isLocalPathTarget(value, false)) targets.add(value);
    return;
  }
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) collectExportPaths(item, targets);
    return;
  }
  if (typeof value === "object") {
    for (const target of Object.values(value)) collectExportPaths(target, targets);
  }
}

function isLocalPathTarget(value, allowBareRelative) {
  if (value.startsWith("./") || value.startsWith("../")) return true;
  return allowBareRelative && !path.posix.isAbsolute(value) && !/^(?:[a-z]+:|#|@)/i.test(value);
}

function normalizeTarget(target, name) {
  const normalized = path.posix.normalize(target.replace(/\\/g, "/").replace(/^\.\//, ""));
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized) ||
    /^[a-z]:\//i.test(normalized)
  ) {
    throw new Error(`${name} declares an escaping entry target: ${target}.`);
  }
  return normalized;
}

function normalizeEntry(entry) {
  const normalized = entry.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  return normalized.startsWith("package/") ? normalized.slice("package/".length) : normalized;
}

function wildcardTargetExpression(target) {
  const escaped = target.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".+");
  return new RegExp(`^${escaped}$`);
}
