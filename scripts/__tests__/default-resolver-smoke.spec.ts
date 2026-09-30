/**
 * Default-resolver smoke check (card c312ba0b).
 *
 * `resolvePkgistCli()` in `release-family.ts` used to have two independent
 * faults (`require.resolve` against an ESM-only package, and a `cli.js`
 * entry that never existed on disk at any resolver). Every unit test in this
 * suite passed the whole time, because every one of them INJECTS
 * `resolvePkgistCli` as a dependency — the seam that is stubbed in every
 * test is exactly the seam that was broken in production, and nothing ever
 * called the REAL default.
 *
 * This file closes that gap. It calls each script's real, un-injected
 * default dependency resolver — no fixture, no stub — and proves the
 * resolved path exists on disk (`existsSync` / `statSync`, not merely a
 * resolve that returned a string without throwing). It does no other work:
 * it never builds, packs, or publishes anything.
 *
 * Every builder script under `scripts/` was audited for a default-resolver
 * seam like this one. Only three have one:
 *
 *   - release-family.ts            -> resolvePkgistCli(), resolveNpmCli()
 *   - local-registry-gate.ts       -> defaultResolveNpmCliPath()
 *   - zero-edit-generator-gate.ts  -> defaultResolveNpmCliPath()
 *
 * The rest (warlock-family.ts, check-feature-parity.ts, skill-snippet-gate.ts)
 * do filesystem discovery and static imports at startup — no
 * `createRequire`/`require.resolve`/`process.execPath`-guessing default they
 * construct for themselves — so they have nothing of this shape to smoke.
 */
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveNpmCli, resolvePkgistCli } from "../release-family.ts";
import { defaultResolveNpmCliPath as localRegistryResolveNpmCliPath } from "../local-registry-gate.ts";
import { defaultResolveNpmCliPath as zeroEditResolveNpmCliPath } from "../zero-edit-generator-gate.ts";

/** Asserts a resolver's return value is an absolute path that exists on disk, naming the resolver in every failure. */
function assertResolvesToRealFile(resolverName: string, resolved: string): void {
  assert.equal(
    typeof resolved,
    "string",
    `${resolverName}() must return a string path`,
  );
  assert.ok(
    path.isAbsolute(resolved),
    `${resolverName}() resolved to a non-absolute path: ${resolved}`,
  );
  assert.ok(
    existsSync(resolved),
    `${resolverName}() resolved to ${resolved}, but that file does not exist on disk`,
  );
  assert.ok(
    statSync(resolved).isFile(),
    `${resolverName}() resolved to ${resolved}, which exists but is not a regular file`,
  );
}

describe("default-resolver smoke — real startup path, no injection", () => {
  it("release-family.ts: resolvePkgistCli() resolves to a real file with zero stubbing", () => {
    // No dependency object, no fixture: this is exactly what
    // `withDefaults({})` falls back to at the top of a real `gate` run.
    const resolved = resolvePkgistCli();
    assertResolvesToRealFile("resolvePkgistCli", resolved);
  });

  it("release-family.ts: resolveNpmCli() -- branch A (npm_execpath is an absolute npm-cli.js) resolves to a real file", () => {
    // This branch is environment-dependent: it is only taken when the
    // process was actually invoked BY npm. Force it explicitly rather than
    // hoping today's shell happens to exercise it.
    const realNpmCli = discoverARealNpmCliJs();
    const original = process.env.npm_execpath;
    process.env.npm_execpath = realNpmCli;
    try {
      const resolved = resolveNpmCli();
      assert.equal(
        resolved,
        realNpmCli,
        "resolveNpmCli() did not take the npm_execpath branch even though npm_execpath was set to an absolute npm-cli.js path",
      );
      assertResolvesToRealFile("resolveNpmCli (npm_execpath branch)", resolved);
    } finally {
      if (original === undefined) delete process.env.npm_execpath;
      else process.env.npm_execpath = original;
    }
  });

  it("release-family.ts: resolveNpmCli() -- branch B (fallback adjacent to process.execPath) resolves to a real file", () => {
    // Force the fallback by making npm_execpath absent/unusable, exactly as
    // it is when release-family.ts is launched directly through
    // `node --import tsx scripts/release-family.ts`, never through npm.
    const original = process.env.npm_execpath;
    delete process.env.npm_execpath;
    try {
      const resolved = resolveNpmCli();
      const expected = nodeAdjacentNpmCli();
      assert.equal(
        resolved,
        expected,
        "resolveNpmCli() did not take the process.execPath-adjacent fallback branch once npm_execpath was cleared",
      );
      assertResolvesToRealFile("resolveNpmCli (process.execPath fallback branch)", resolved);
    } finally {
      if (original === undefined) delete process.env.npm_execpath;
      else process.env.npm_execpath = original;
    }
  });

  it("local-registry-gate.ts: defaultResolveNpmCliPath() resolves to a real file with zero injection", () => {
    const resolved = localRegistryResolveNpmCliPath();
    assertResolvesToRealFile("local-registry-gate.ts defaultResolveNpmCliPath", resolved);
  });

  it("zero-edit-generator-gate.ts: defaultResolveNpmCliPath() resolves to a real file with zero injection", () => {
    const resolved = zeroEditResolveNpmCliPath();
    assertResolvesToRealFile("zero-edit-generator-gate.ts defaultResolveNpmCliPath", resolved);
  });
});

/**
 * Finds a real, on-disk `npm-cli.js` to use as the forced value of
 * `npm_execpath` in the branch-A test above. Uses the SAME
 * process.execPath-adjacent layout the fallback branch resolves, so this
 * helper never depends on the smoke check's own subject to find its fixture.
 */
function discoverARealNpmCliJs(): string {
  return nodeAdjacentNpmCli();
}

/**
 * The npm CLI installed with the running Node, in either platform layout:
 * Windows keeps `node_modules` beside `node.exe`; Linux and macOS keep it in
 * `<prefix>/lib/node_modules` with node in `<prefix>/bin`. Mirrors the two
 * candidates the resolver itself checks, first match wins.
 */
function nodeAdjacentNpmCli(): string {
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    path.resolve(nodeDir, "node_modules/npm/bin/npm-cli.js"),
    path.resolve(nodeDir, "../lib/node_modules/npm/bin/npm-cli.js"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      `Cannot exercise resolveNpmCli(): no npm-cli.js found at ${candidates.join(" or ")}. ` +
        "This machine has no installed npm CLI beside its Node binary to use as a forced fixture.",
    );
  }
  return found;
}
