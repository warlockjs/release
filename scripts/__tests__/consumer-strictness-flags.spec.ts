import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, after } from "node:test";
import { consumerStrictnessFlags, CONSUMER_TSCONFIG_PATH } from "../consumer-strictness-flags";
import { sharedStrictnessArgs, buildForcedStrictnessArgs } from "../strictness-gate";

const workDir = mkdtempSync(join(tmpdir(), "consumer-strictness-"));
after(() => rmSync(workDir, { recursive: true, force: true }));

function writeTsconfig(name: string, contents: unknown): string {
  const filePath = join(workDir, name);
  writeFileSync(filePath, JSON.stringify(contents), "utf8");
  return filePath;
}

describe("consumerStrictnessFlags", () => {
  it("picks allowlisted boolean flags that are true", () => {
    const filePath = writeTsconfig("fixture-true.json", {
      compilerOptions: {
        strict: true,
        noFallthroughCasesInSwitch: true,
        isolatedModules: true,
        forceConsistentCasingInFileNames: true,
      },
    });
    const flags = consumerStrictnessFlags(filePath);
    assert.deepEqual(
      [...flags].sort(),
      ["forceConsistentCasingInFileNames", "isolatedModules", "noFallthroughCasesInSwitch", "strict"].sort(),
    );
  });

  it("ignores skipLibCheck, non-allowlisted options, and false values", () => {
    const filePath = writeTsconfig("fixture-ignored.json", {
      compilerOptions: {
        skipLibCheck: true,
        moduleResolution: "bundler",
        module: "ESNext",
        strict: false,
        noImplicitAny: false,
        resolveJsonModule: true,
      },
    });
    const flags = consumerStrictnessFlags(filePath);
    assert.deepEqual(flags, []);
  });

  it("throws naming the path when the file is missing", () => {
    const missingPath = join(workDir, "does-not-exist.json");
    assert.throws(() => consumerStrictnessFlags(missingPath), (error: unknown) => error instanceof Error && error.message.includes(missingPath));
  });

  it("throws naming the path when the file is unparseable", () => {
    const filePath = join(workDir, "fixture-broken.json");
    writeFileSync(filePath, "{ not json", "utf8");
    assert.throws(() => consumerStrictnessFlags(filePath), (error: unknown) => error instanceof Error && error.message.includes(filePath));
  });

  it("reads the real consumer template and finds the known consumer-contract flags", () => {
    const flags = consumerStrictnessFlags(CONSUMER_TSCONFIG_PATH);
    assert.ok(flags.includes("noFallthroughCasesInSwitch"));
    assert.ok(flags.includes("isolatedModules"));
  });
});

describe("strictness-gate forced args include the consumer contract", () => {
  it("includes --noFallthroughCasesInSwitch and --isolatedModules alongside the shared strictness args", () => {
    const args = buildForcedStrictnessArgs();
    assert.ok(args.includes("--noFallthroughCasesInSwitch"), "expected --noFallthroughCasesInSwitch in forced args");
    assert.ok(args.includes("--isolatedModules"), "expected --isolatedModules in forced args");
    for (const arg of sharedStrictnessArgs()) {
      assert.ok(args.includes(arg), `expected shared strictness arg ${arg} to still be present`);
    }
  });

  it("has no duplicate flag names", () => {
    const args = buildForcedStrictnessArgs();
    const flagNames = args.filter((_, index) => index % 2 === 0);
    assert.equal(new Set(flagNames).size, flagNames.length);
  });
});
