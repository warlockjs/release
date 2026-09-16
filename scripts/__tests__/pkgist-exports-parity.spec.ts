import assert from "node:assert/strict";
import { describe, it } from "node:test";

import pkgistConfig from "../../pkgist.config.ts";
import {
  ALLOWLIST,
  BUILDER_ROOT,
  collectConfiguredPackages,
  compareOnePackage,
  entryToExportPath,
  runPkgistExportsParityGate,
} from "../pkgist-exports-parity.ts";

describe("entryToExportPath", () => {
  it('maps the root index.ts to "."', () => {
    assert.equal(entryToExportPath("index.ts"), ".");
  });

  it("maps a nested index.ts to its parent directory", () => {
    assert.equal(entryToExportPath("client/runtime/index.ts"), "./client/runtime");
    assert.equal(entryToExportPath("entry/index.ts"), "./entry");
    assert.equal(entryToExportPath("server/index.ts"), "./server");
  });

  it("maps a non-index .ts file to its own extensionless path", () => {
    assert.equal(entryToExportPath("page-cache.ts"), "./page-cache");
    assert.equal(entryToExportPath("server/page-cache.ts"), "./server/page-cache");
  });
});

describe("compareOnePackage", () => {
  it("reports no violation when derived keys equal source keys", () => {
    const pkg = { name: "@x/pkg", root: "../pkg", entries: ["index.ts", "vite/index.ts"] };
    const violation = compareOnePackage(pkg, [".", "./vite"]);
    assert.equal(violation, undefined);
  });

  it("flags a key pkgist will publish that source exports does not have", () => {
    const pkg = { name: "@x/pkg", root: "../pkg", entries: ["index.ts", "server/index.ts"] };
    const violation = compareOnePackage(pkg, ["."]);
    assert.ok(violation);
    assert.deepEqual(violation!.publishedOnly, ["./server"]);
    assert.deepEqual(violation!.sourceOnly, []);
  });

  it("flags a source exports key pkgist will not publish", () => {
    const pkg = { name: "@x/pkg", root: "../pkg", entries: ["index.ts"] };
    const violation = compareOnePackage(pkg, [".", "./missing-entry"]);
    assert.ok(violation);
    assert.deepEqual(violation!.publishedOnly, []);
    assert.deepEqual(violation!.sourceOnly, ["./missing-entry"]);
  });

  it("does not flag a published-only key that is on the ALLOWLIST for that package", () => {
    // Mirrors the real @warlock.js/web "./entry" + "./server" seams.
    const pkg = {
      name: "@warlock.js/web",
      root: "../web",
      entries: ["index.ts", "server/index.ts"],
    };
    const violation = compareOnePackage(pkg, ["."]);
    assert.equal(violation, undefined);
  });

  it("still flags an unallowlisted mismatch on a package that DOES have allowlist entries", () => {
    const pkg = {
      name: "@warlock.js/web",
      root: "../web",
      entries: ["index.ts", "server/index.ts", "surprise/index.ts"],
    };
    const violation = compareOnePackage(pkg, ["."]);
    assert.ok(violation);
    assert.deepEqual(violation!.publishedOnly, ["./surprise"]);
  });
});

describe("ALLOWLIST", () => {
  it("every entry carries a non-empty reason", () => {
    for (const entry of ALLOWLIST) {
      assert.ok(
        entry.reason.length > 20,
        `${entry.packageName} ${entry.exportPath} needs a real reason`,
      );
    }
  });
});

describe("runPkgistExportsParityGate (real pkgist.config.ts)", () => {
  it("finds @warlock.js/web comparable, and compares it clean", () => {
    const report = runPkgistExportsParityGate(BUILDER_ROOT, pkgistConfig);
    assert.ok(
      report.comparedPackages.includes("@warlock.js/web"),
      "expected @warlock.js/web to be comparable",
    );
    assert.deepEqual(report.violations, [], JSON.stringify(report.violations));
  });

  it("skips @warlock.js/core: it has entries but no source exports map", () => {
    const report = runPkgistExportsParityGate(BUILDER_ROOT, pkgistConfig);
    assert.ok(report.skippedPackages.includes("@warlock.js/core"));
    assert.ok(!report.comparedPackages.includes("@warlock.js/core"));
  });

  it("real config: every configured package resolves (no throw) via collectConfiguredPackages", () => {
    const packages = collectConfiguredPackages(pkgistConfig);
    assert.ok(packages.length > 20, `expected the full family, got ${packages.length}`);
    assert.ok(packages.some((p) => p.name === "@warlock.js/web"));
  });
});
