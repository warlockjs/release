import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { collectOwnedDiagnostics, type WorkspacePackage } from "../strictness-gate.ts";

/**
 * Two-sided coverage for program-containment diagnostic ownership (TS6059
 * "file is not under rootDir", and its file-list sibling TS6307): these are a
 * property of the PROGRAM that raised them, not of the file they point at, so
 * they must be charged to the package whose compile produced them -- unlike
 * every other diagnostic code, which keeps file-directory ownership.
 *
 * Fixtures live under `fixtures/strictness-gate/`:
 *   - pkg-a/src/own-error.ts -- a plain TS2322 type error, unreachable from
 *     pkg-b: the innocent control, owned by pkg-a's own compile only.
 *   - pkg-a/src/shared.ts    -- also a plain TS2322 type error.
 *   - pkg-a/src/index.ts     -- a re-export barrel, `export * from "./shared"`,
 *     the same shape as core/src/router/index.ts's
 *     `export * from "./normalize-route-path"`.
 *   - pkg-b/src/index.ts     -- relative-imports pkg-a's barrel from OUTSIDE
 *     pkg-b's rootDir ("./src"), the same shape as
 *     web/src/build/generate-pages-barrel.ts reaching core/src/router source
 *     through a path that escapes web's rootDir.
 *
 * Compiling pkg-b's own program pulls in both pkg-a/src/index.ts (via the
 * import) and pkg-a/src/shared.ts (via index.ts's re-export), both outside
 * pkg-b's rootDir. TypeScript reports shared.ts's TS6059 AT pkg-a/src/index.ts's
 * own re-export statement -- a location INSIDE pkg-a -- even though pkg-b's
 * program is what raised it (verified directly against real tsc output; this
 * is exactly the shape of the real core/web TS6059, which lands at
 * core/src/router/index.ts:3 while web's program produced it). pkg-b's
 * program also separately surfaces pkg-a/src/shared.ts's own TS2322 (at
 * shared.ts's own location, unaffected by which program compiled it).
 *
 * Running pkg-a alone never triggers a containment error (both its own files
 * are inside its own rootDir there).
 */

const FIXTURES_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "strictness-gate");

function fixturePackage(dir: string): WorkspacePackage {
  return { dir, path: path.join(FIXTURES_ROOT, dir) };
}

const PKG_A = fixturePackage("pkg-a");
const PKG_B = fixturePackage("pkg-b");

describe("collectOwnedDiagnostics -- program-containment diagnostic ownership", () => {
  it("innocent case: a normal type error in a file under pkg-a, from pkg-a's own program, is owned by pkg-a", () => {
    const measurement = collectOwnedDiagnostics([PKG_A]);

    const owned = measurement.diagnostics.get("pkg-a") ?? [];
    const own = owned.find((diagnostic) => diagnostic.file.endsWith("pkg-a/src/own-error.ts"));

    assert.ok(own, "expected pkg-a's own TS2322 in pkg-a/src/own-error.ts to be owned by pkg-a");
    assert.equal(own?.code, 2322);
  });

  it("unchanged case: a non-containment error in a file under pkg-a, surfaced while compiling pkg-b's program, still follows file-directory ownership", () => {
    const measurement = collectOwnedDiagnostics([PKG_A, PKG_B]);

    const ownedByA = measurement.diagnostics.get("pkg-a") ?? [];
    const sharedTypeError = ownedByA.find(
      (diagnostic) => diagnostic.file.endsWith("pkg-a/src/shared.ts") && diagnostic.code === 2322,
    );

    assert.ok(sharedTypeError, "expected shared.ts's own TS2322, raised while compiling pkg-b, to still be owned by pkg-a");

    const ownedByB = measurement.diagnostics.get("pkg-b") ?? [];
    assert.ok(
      !ownedByB.some((diagnostic) => diagnostic.code === 2322),
      "pkg-b must not pick up the non-containment diagnostic",
    );
  });

  it("moved case: TS6059 produced by pkg-b's program, located inside pkg-a, is owned by pkg-b", () => {
    const measurement = collectOwnedDiagnostics([PKG_A, PKG_B]);

    // TypeScript reports shared.ts's rootDir violation AT pkg-a/src/index.ts's
    // own re-export statement (a location inside pkg-a) -- see the spec-file
    // doc comment above for why. File-directory ownership (the pre-fix rule)
    // would charge this to pkg-a; the fix charges every TS6059/TS6307 to the
    // producing program instead.
    const ownedByB = measurement.diagnostics.get("pkg-b") ?? [];
    const containment = ownedByB.find(
      (diagnostic) => diagnostic.file.endsWith("pkg-a/src/index.ts") && diagnostic.code === 6059,
    );

    assert.ok(containment, "expected the TS6059 located in pkg-a/src/index.ts to be charged to pkg-b, the producing program");

    const ownedByA = measurement.diagnostics.get("pkg-a") ?? [];
    assert.ok(
      !ownedByA.some((diagnostic) => diagnostic.code === 6059),
      "pkg-a must not also carry the containment diagnostic that pkg-b's program raised",
    );
  });
});
