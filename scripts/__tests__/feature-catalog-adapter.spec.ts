/**
 * WARLOCK_FEATURE_CATALOG_ADAPTER (card 0a173f80) — verification.
 *
 * The zero-edit generator gate spawns this adapter as a plain Node child
 * process (`command === process.execPath`, `zero-edit-generator-gate.ts:373`)
 * and parses its stdout as JSON via `parseFeatureCatalog`
 * (`zero-edit-generator-gate.ts:434-449`). This spec drives both sides for
 * real:
 *
 *  - it npm-installs the actual published 5.3.2 `@warlock.js/core` tarball
 *    from `release-artifacts/5.3.2/` into a temp directory (no faked
 *    filesystem, no remembered feature list) and runs the adapter against
 *    that real install;
 *  - it cross-checks the emitted feature list against the keys of
 *    `featuresMap` in `core/src/generations/features/index.ts` — the actual
 *    source of truth `warlock add` dispatches against;
 *  - it feeds the adapter's real stdout through the gate's own
 *    `parseFeatureCatalog` (imported, not reimplemented) for three
 *    red-control observations: the good case passes, a mismatched
 *    `coreRoot` is rejected, and an empty `features` array is rejected by
 *    name.
 *
 * The npm install is real and network-free (`--offline` against the local
 * npm cache warmed by this same tarball elsewhere in this task), so it costs
 * real wall-clock time once per run — that is the price of not faking the
 * one thing this adapter exists to prove it actually inspected.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { parseFeatureCatalog } from "../zero-edit-generator-gate.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const ADAPTER = path.resolve(HERE, "..", "adapters", "feature-catalog-adapter.mjs");
const TARBALL = path.resolve(
  REPO_ROOT,
  "builder",
  "release-artifacts",
  "5.3.2",
  "warlock.js-core-5.3.2.tgz",
);
const FEATURES_SOURCE = path.resolve(
  REPO_ROOT,
  "core",
  "src",
  "generations",
  "features",
  "index.ts",
);

let installRoot: string;
let coreRoot: string;

function run(command: string, args: readonly string[], cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // npm.cmd is a shell shim on Windows and only resolves through PATH with
    // a shell; every argument here is a fixed, non-user-controlled literal
    // (a temp path this spec created, or a static npm flag), so shell
    // interpolation is not an injection risk in this fixed call shape.
    const child = spawn(command, args, {
      cwd,
      shell: process.platform === "win32" && command.endsWith(".cmd"),
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode: exitCode ?? 1, stdout, stderr }));
  });
}

/**
 * Extracts the `featuresMap` key order straight out of the TypeScript source
 * `warlock add` dispatches against, without needing a TS loader — the
 * object-literal keys (bare identifier or quoted) up to its closing brace.
 */
function readFeatureKeysFromSource(source: string): string[] {
  const start = source.indexOf("export const featuresMap");
  assert.ok(start >= 0, "featuresMap declaration not found in features/index.ts");
  const openBrace = source.indexOf("{", start);
  const closeBrace = source.indexOf("\n};", openBrace);
  const body = source.slice(openBrace + 1, closeBrace);
  const keys: string[] = [];

  for (const line of body.split("\n")) {
    const match = line.match(/^\s*(?:"([a-z0-9-]+)"|([a-zA-Z][a-zA-Z0-9]*)):/);
    if (match) {
      keys.push(match[1] ?? match[2]);
    }
  }

  return keys;
}

describe("WARLOCK_FEATURE_CATALOG_ADAPTER — real installed core, with red controls", () => {
  before(async () => {
    installRoot = await mkdtemp(path.join(tmpdir(), "feature-catalog-adapter-spec-"));
    await mkdir(installRoot, { recursive: true });
    await writeFile(
      path.join(installRoot, "package.json"),
      `${JSON.stringify({ name: "feature-catalog-adapter-spec-fixture", private: true }, null, 2)}\n`,
      "utf8",
    );

    const install = await run(
      process.platform === "win32" ? "npm.cmd" : "npm",
      [
        "install",
        TARBALL,
        "--no-save",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--prefer-offline",
      ],
      installRoot,
    );
    assert.equal(
      install.exitCode,
      0,
      `npm install of the real 5.3.2 core tarball failed: ${install.stderr || install.stdout}`,
    );

    coreRoot = await realpath(path.join(installRoot, "node_modules", "@warlock.js", "core"));
  });

  after(async () => {
    await rm(installRoot, { recursive: true, force: true });
  });

  it("emits a schemaVersion 1 installed-core-feature-map catalog the gate's parseFeatureCatalog accepts", async () => {
    const result = await run(process.execPath, [ADAPTER, "--core-root", coreRoot, "--format", "json"], installRoot);
    assert.equal(result.exitCode, 0, `adapter exited non-zero: ${result.stderr}`);

    const catalog = parseFeatureCatalog(result.stdout, coreRoot);

    assert.equal(catalog.schemaVersion, 1);
    assert.equal(catalog.source, "installed-core-feature-map");
    assert.equal(catalog.complete, true);
    assert.equal(path.resolve(catalog.coreRoot), path.resolve(coreRoot));
    assert.ok(catalog.features.length > 0, "feature list must not be empty");
  });

  it("cross-checks the emitted feature list against featuresMap in core/src/generations/features/index.ts", async () => {
    const result = await run(process.execPath, [ADAPTER, "--core-root", coreRoot, "--format", "json"], installRoot);
    const catalog = JSON.parse(result.stdout) as { features: string[] };

    const sourceText = await readFile(FEATURES_SOURCE, "utf8");
    const expected = readFeatureKeysFromSource(sourceText);

    assert.deepEqual(
      catalog.features,
      expected,
      "adapter's feature list (and order) must exactly match featuresMap's keys in core/src/generations/features/index.ts",
    );
  });

  it("red control: parseFeatureCatalog passes the good catalog, rejects a mismatched coreRoot, and rejects an empty feature list", async () => {
    const result = await run(process.execPath, [ADAPTER, "--core-root", coreRoot, "--format", "json"], installRoot);
    const goodCatalog = JSON.parse(result.stdout) as Record<string, unknown>;

    assert.doesNotThrow(() => parseFeatureCatalog(JSON.stringify(goodCatalog), coreRoot));

    const wrongRoot = path.join(tmpdir(), "not-the-real-core-root");
    assert.throws(
      () => parseFeatureCatalog(JSON.stringify(goodCatalog), wrongRoot),
      /did not identify the installed Core root it inspected/,
    );

    const emptyCatalog = { ...goodCatalog, features: [] };
    assert.throws(
      () => parseFeatureCatalog(JSON.stringify(emptyCatalog), coreRoot),
      /produced no top-level features/,
    );
  });
});
