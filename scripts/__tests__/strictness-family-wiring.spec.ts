import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import {
  parseArguments,
  runReleaseFamily,
  type CommandRequest,
  type ReleaseFamilyDependencies,
  type ReleaseHandoff,
} from "../release-family.ts";
import type { WarlockFamily } from "../warlock-family.ts";
import type { StrictnessGateRunResult } from "../strictness-gate.ts";

/**
 * RED-FIRST spec for wiring `strictness-gate.ts` into `release-family.ts`
 * `gate` mode (card: strictness ratchet as a family-wide pre-build gate).
 *
 * `gate` mode does not yet run the strictness ratchet at all -- these tests
 * are written against the intended behaviour and are expected to fail until
 * the wiring lands:
 *
 *   (a) an OVER strictness result refuses the gate, names the offending
 *       package and its counts, and produces NO handoff;
 *   (b) an all-OK strictness result lets the gate proceed and the handoff
 *       records `strictness: { status: "passed" }`;
 *   (c) `--skip-strictness "<reason>"` skips the ratchet and the handoff
 *       records the skip and the reason, verbatim;
 *   (d) `--skip-strictness` with no reason is an argument error, both from
 *       the CLI parser and from `runReleaseFamily` itself.
 */

const VERSION = "5.3.0";
const HASH = "a".repeat(64);
const FAMILY: WarlockFamily = {
  name: "warlock",
  version: VERSION,
  members: [
    {
      name: "@warlock.js/notifications",
      root: path.resolve("notifications"),
      configuredRoot: path.resolve("notifications"),
      version: VERSION,
    },
  ],
};

const FULL_MATRIX = { matrixScope: "none" } as const;

/** A strictness result every package passes cleanly. */
function passingStrictnessResult(): StrictnessGateRunResult {
  return {
    passed: true,
    text: "strictness-gate: owned diagnostics / allowance\n  core: 0 / 5 OK",
    packages: [{ dir: "core", unmeasured: false, count: 0, allowance: 5, over: 0 }],
  };
}

/** A strictness result where `web` is over its allowance. */
function overStrictnessResult(): StrictnessGateRunResult {
  return {
    passed: false,
    text: "strictness-gate: owned diagnostics / allowance\n  web: 12 / 5 OVER by 7",
    packages: [{ dir: "web", unmeasured: false, count: 12, allowance: 5, over: 7 }],
  };
}

/**
 * Minimal fixture: enough dependencies for a full gate run to succeed
 * (single-member family, every downstream step answered innocently) plus an
 * injectable `runStrictnessGate` fake. Because the strictness check is meant
 * to run BEFORE any member is built or packed, the OVER-case tests below
 * never need the build/pack stubs to do anything but exist.
 */
function fixture(
  overrides: Partial<ReleaseFamilyDependencies> = {},
): {
  dependencies: ReleaseFamilyDependencies;
  commands: CommandRequest[];
  handoffs: ReleaseHandoff[];
} {
  const commands: CommandRequest[] = [];
  const handoffs: ReleaseHandoff[] = [];
  const dependencies: ReleaseFamilyDependencies = {
    loadFamily: async () => FAMILY,
    makeDirectory: async () => undefined,
    makeTemporaryDirectory: async () => path.resolve("release-temp"),
    removeDirectory: async () => undefined,
    removeFile: async () => undefined,
    writeTextFile: async () => undefined,
    readTextFile: async filePath => {
      if (path.basename(filePath) === "package.json") {
        return JSON.stringify({ scripts: { test: "vitest run", typecheck: "tsc --noEmit" } });
      }
      throw new Error(`fixture readTextFile has no stub for ${filePath}`);
    },
    resolvePkgistCli: () => path.resolve("pkgist", "dist", "cli.js"),
    resolveNpmCli: () => path.resolve("npm", "bin", "npm-cli.js"),
    resolvePnpmCli: () => path.resolve("pnpm", "bin", "pnpm.mjs"),
    fileExists: async () => false,
    resolvePackageScript: (memberRoot, scriptCommand) => ({
      command: "resolved-node",
      args: [memberRoot, scriptCommand],
    }),
    runCommand: async request => {
      commands.push(request);
      if (request.command === "git" && request.args[0] === "rev-parse" && request.args[1] === "--abbrev-ref") {
        return { stdout: "main\n", stderr: "" };
      }
      if (request.command === "git" && request.args[0] === "rev-parse") {
        return { stdout: `${"a".repeat(40)}\n`, stderr: "" };
      }
      if (request.command === "git" && request.args[0] === "ls-remote" && request.args[1] === "--symref") {
        return { stdout: `ref: refs/heads/main\tHEAD\n${"a".repeat(40)}\tHEAD\n`, stderr: "" };
      }
      if (request.args[1] === "pack") {
        return {
          stdout: JSON.stringify([{ filename: `warlock.js-notifications-${VERSION}.tgz` }]),
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    },
    inspectArtifact: async () => ({
      manifest: {
        name: "@warlock.js/notifications",
        version: VERSION,
        main: "./esm/index.mjs",
        module: "./esm/index.mjs",
        exports: {
          ".": {
            import: { default: "./esm/index.mjs", types: "./esm/index.d.mts" },
            require: ["node:module", "./cjs/index.cjs"],
          },
        },
        dependencies: { "@warlock.js/core": VERSION },
      },
      entries: [
        "package/package.json",
        "package/esm/index.mjs",
        "package/esm/index.d.mts",
        "package/cjs/index.cjs",
      ],
    }),
    sha256File: async () => HASH,
    runLocalGate: async input => ({
      kind: "warlock-family-publish-handoff",
      candidateVersion: input.candidateVersion,
      artifacts: input.artifacts.map(artifact => ({ ...artifact })),
      verifiedAt: "2026-09-02T12:00:00.000Z",
    }),
    writeHandoff: async (_filePath, handoff) => {
      handoffs.push(handoff);
    },
    runStrictnessGate: async () => passingStrictnessResult(),
    ...overrides,
  };
  return { dependencies, commands, handoffs };
}

describe("release-family gate mode -- strictness ratchet wiring", () => {
  it("(a) an OVER strictness result refuses the gate, names the package and counts, and produces no handoff", async () => {
    const control = fixture({ runStrictnessGate: async () => overStrictnessResult() });

    await assert.rejects(
      runReleaseFamily({ mode: "gate", version: VERSION, ...FULL_MATRIX }, control.dependencies),
      error => {
        const message = (error as Error).message;
        assert.match(message, /strictness/i);
        assert.match(message, /web/);
        assert.match(message, /12/);
        assert.match(message, /5/);
        return true;
      },
    );
    assert.equal(control.handoffs.length, 0);
    // Refused before any member was ever built or packed.
    const builds = control.commands.filter(command => command.args[1] === "build");
    assert.equal(builds.length, 0, "must refuse before building any tarball");
  });

  it("(b) an all-OK strictness result lets the gate proceed and the handoff records strictness: passed", async () => {
    const seenCalls: string[] = [];
    const control = fixture({
      runStrictnessGate: async () => {
        seenCalls.push("ran");
        return passingStrictnessResult();
      },
    });

    const handoff = (await runReleaseFamily(
      { mode: "gate", version: VERSION, ...FULL_MATRIX },
      control.dependencies,
    )) as ReleaseHandoff;

    assert.ok(handoff);
    assert.deepEqual(seenCalls, ["ran"]);
    assert.equal(control.handoffs.length, 1);
    assert.deepEqual(handoff.strictness, { status: "passed" });
  });

  it('(c) --skip-strictness "reason" skips the ratchet and the handoff records the skip and the reason', async () => {
    const seenCalls: string[] = [];
    const control = fixture({
      runStrictnessGate: async () => {
        seenCalls.push("ran");
        return passingStrictnessResult();
      },
    });

    const handoff = (await runReleaseFamily(
      { mode: "gate", version: VERSION, ...FULL_MATRIX, skipStrictness: "web is mid-refactor, tracked in card 9f" },
      control.dependencies,
    )) as ReleaseHandoff;

    assert.ok(handoff);
    assert.deepEqual(seenCalls, [], "the ratchet must not run at all when skipped");
    assert.deepEqual(handoff.strictness, {
      status: "skipped",
      reason: "web is mid-refactor, tracked in card 9f",
    });
  });

  it("(d) --skip-strictness with no reason is an argument error, from the CLI parser", () => {
    assert.throws(
      () => parseArguments(["gate", "--version", VERSION, "--matrix", "none", "--skip-strictness"]),
      /--skip-strictness requires a reason/,
    );
    assert.throws(
      () => parseArguments(["gate", "--version", VERSION, "--matrix", "none", "--skip-strictness="]),
      /--skip-strictness requires a reason/,
    );
  });

  it("(d) --skip-strictness with no reason is an argument error, from runReleaseFamily itself", async () => {
    const control = fixture();

    await assert.rejects(
      runReleaseFamily(
        { mode: "gate", version: VERSION, ...FULL_MATRIX, skipStrictness: "   " },
        control.dependencies,
      ),
      /--skip-strictness requires a reason/,
    );
    assert.equal(control.handoffs.length, 0);
  });

  it("parses --skip-strictness off the command line", () => {
    const parsed = parseArguments([
      "gate",
      "--version",
      VERSION,
      "--matrix",
      "none",
      "--skip-strictness",
      "reason here",
    ]);
    assert.equal(parsed.skipStrictness, "reason here");
  });
});
