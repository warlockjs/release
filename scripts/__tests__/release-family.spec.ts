import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import type { PublishHandoff } from "../local-registry-gate.ts";
import {
  NPM_ORIGIN,
  assertMatrixScopeIsStated,
  assertSinglePhysicalCore,
  checkPackageTreeIsClean,
  confirmSubjectsAtOrigin,
  formatCommandFailureOutput,
  parseArguments,
  parseGitPorcelain,
  qualityCheckEnvironment,
  releaseTagName,
  resolveLocalPackageScript,
  resolvePublishedSurface,
  runReleaseFamily,
  tagAndPushAllMembers,
  tagAndPushMember,
  type CommandRequest,
  type ReleaseFamilyDependencies,
  type ReleaseHandoff,
} from "../release-family.ts";
import type { WarlockFamily, WarlockFamilyMember } from "../warlock-family.ts";

const VERSION = "5.3.0";
/**
 * The scope every pre-existing gate test ran under, now said out loud.
 *
 * These tests all mock `runZeroEditGeneratorGate` and assert on what reaches
 * it, so they were always full-matrix runs — the difference is that the scope
 * is no longer implicit. Spread into each gate call rather than defaulted in
 * the runner: a default is exactly what canon `e00fb7b8` forbids, and a test
 * helper that supplies one would hide the requirement from the tests meant to
 * prove it.
 */
const FULL_MATRIX = {
  matrixScope: "full",
  matrixAuthorisation: {
    authorisedBy: "Hasan",
    date: "2026-09-07",
    quote: "run the full matrix for this one",
  },
} as const;
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
    {
      name: "create-warlock",
      root: path.resolve("create-warlock"),
      configuredRoot: path.resolve("create-warlock"),
      version: VERSION,
    },
  ],
};

describe("command failure output", () => {
  it("retains TypeScript diagnostics written to stdout when a wrapper also writes stderr", () => {
    const output = formatCommandFailureOutput(
      "src/form.ts(12,3): error TS2322: Type 'number' is not assignable to type 'string'.\n",
      "typecheck failed: tsconfig.typecheck.json\n",
    );

    assert.match(output, /stderr:[\s\S]*typecheck failed/);
    assert.match(output, /stdout:[\s\S]*TS2322/);
  });

  it("keeps the END of an oversized stream, where a test runner prints what failed", () => {
    const noise = "✓ passing spec\n".repeat(5_000);
    const output = formatCommandFailureOutput(`${noise} FAIL src/broken.spec.ts > the one that failed\n`, "");

    assert.ok(output.length < noise.length);
    assert.match(output, /characters omitted/);
    assert.match(output, /FAIL src\/broken\.spec\.ts > the one that failed/);
  });
});

function fixture(overrides: Partial<ReleaseFamilyDependencies> = {}): {
  dependencies: ReleaseFamilyDependencies;
  commands: CommandRequest[];
  handoffs: ReleaseHandoff[];
  gateInputs: PublishHandoff[];
} {
  const commands: CommandRequest[] = [];
  const handoffs: ReleaseHandoff[] = [];
  const gateInputs: PublishHandoff[] = [];
  const dependencies: ReleaseFamilyDependencies = {
    loadFamily: async () => FAMILY,
    makeDirectory: async () => undefined,
    makeTemporaryDirectory: async () => path.resolve("release-temp"),
    removeDirectory: async () => undefined,
    removeFile: async () => undefined,
    writeTextFile: async () => undefined,
    readTextFile: async (filePath) => {
      // Default innocent-case package.json: both own-quality scripts declared.
      if (path.basename(filePath) === "package.json") {
        return JSON.stringify({ scripts: { test: "vitest run", typecheck: "tsc --noEmit" } });
      }
      if (path.basename(filePath) === "pnpm-lock.yaml") {
        return "lockfileVersion: '9.0'\n";
      }

      throw new Error(`fixture readTextFile has no stub for ${filePath}`);
    },
    resolvePkgistCli: () => path.resolve("pkgist", "dist", "cli.js"),
    resolveNpmCli: () => path.resolve("npm", "bin", "npm-cli.js"),
    resolvePnpmCli: () => path.resolve("pnpm", "bin", "pnpm.mjs"),
    // Default innocent case: no member has a lockfile, so nothing new fires.
    // Tests that DO care about the lockfile step override this.
    fileExists: async () => false,
    // Default stand-in: every quality-check script "resolves" and its run is
    // handled by the base runCommand stub below (which answers everything
    // with an empty success), so tests unrelated to the own-quality gate see
    // it pass silently. Tests that DO care override this dependency.
    resolvePackageScript: (memberRoot, scriptCommand) => ({
      command: "resolved-node",
      args: [memberRoot, scriptCommand],
    }),
    runCommand: async (request) => {
      commands.push(request);
      if (
        request.command === "git" &&
        request.args[0] === "rev-parse" &&
        request.args[1] === "--abbrev-ref"
      ) {
        // Innocent case: every member is checked out on the same branch
        // origin's default resolves to below.
        return { stdout: "main\n", stderr: "" };
      }
      if (request.command === "git" && request.args[0] === "rev-parse") {
        return { stdout: `${"a".repeat(40)}\n`, stderr: "" };
      }
      if (
        request.command === "git" &&
        request.args[0] === "ls-remote" &&
        request.args[1] === "--symref"
      ) {
        return { stdout: `ref: refs/heads/main\tHEAD\n${"a".repeat(40)}\tHEAD\n`, stderr: "" };
      }
      if (request.args[1] === "pack") {
        const sourceDirectory = request.args[2];
        const packageName = sourceDirectory.includes("create-warlock")
          ? "create-warlock"
          : "warlock.js-notifications";
        return {
          stdout: JSON.stringify([{ filename: `${packageName}-${VERSION}.tgz` }]),
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    },
    inspectArtifact: async (filePath) => {
      const name = filePath.includes("create-warlock")
        ? "create-warlock"
        : "@warlock.js/notifications";
      return {
        manifest: {
          name,
          version: VERSION,
          main: "./esm/index.mjs",
          module: "./esm/index.mjs",
          exports: {
            ".": {
              import: { default: "./esm/index.mjs", types: "./esm/index.d.mts" },
              require: ["node:module", "./cjs/index.cjs"],
            },
          },
          dependencies:
            name === "@warlock.js/notifications"
              ? { "@warlock.js/core": VERSION }
              : { "@warlock.js/fs": VERSION },
        },
        entries: [
          "package/package.json",
          "package/esm/index.mjs",
          "package/esm/index.d.mts",
          "package/cjs/index.cjs",
        ],
      };
    },
    sha256File: async () => HASH,
    runLocalGate: async (input) => {
      const result: PublishHandoff = {
        kind: "warlock-family-publish-handoff",
        candidateVersion: input.candidateVersion,
        artifacts: input.artifacts.map((artifact) => ({ ...artifact })),
        verifiedAt: "2026-09-02T12:00:00.000Z",
      };
      gateInputs.push(result);
      return result;
    },
    writeHandoff: async (_filePath, handoff) => {
      handoffs.push(handoff);
    },
    // Default innocent case for every pre-existing gate-mode test in this
    // file: the strictness ratchet passes cleanly without ever compiling the
    // real workspace. Tests exercising the ratchet itself live in
    // `strictness-family-wiring.spec.ts` and override this explicitly.
    runStrictnessGate: async () => ({
      passed: true,
      text: "strictness-gate: owned diagnostics / allowance\n  (fixture) 0 / 0 OK",
      packages: [],
    }),
    ...overrides,
  };
  return { dependencies, commands, handoffs, gateInputs };
}

describe("runReleaseFamily gate mode", () => {
  it("rejects a requested version that differs from the reconciled family", async () => {
    const control = fixture({
      loadFamily: async () => ({
        ...FAMILY,
        version: "5.2.4",
        members: FAMILY.members.map((member) => ({ ...member, version: "5.2.4" })),
      }),
    });

    await assert.rejects(
      runReleaseFamily({ mode: "gate", version: VERSION, ...FULL_MATRIX }, control.dependencies),
      /does not equal the reconciled family version/,
    );
    assert.equal(control.commands.length, 0);
    assert.equal(control.handoffs.length, 0);
  });

  it("lets one innocent candidate reach exactly one ordered handoff", async () => {
    const control = fixture();
    const handoff = await runReleaseFamily(
      { mode: "gate", version: VERSION, ...FULL_MATRIX },
      control.dependencies,
    );

    assert.ok(handoff);
    assert.deepEqual(
      handoff.subjects,
      FAMILY.members.map((member) => member.name),
    );
    assert.equal(control.gateInputs.length, 1);
    assert.deepEqual(control.handoffs, [handoff]);

    const builds = control.commands.filter((command) => command.args[1] === "build");
    assert.equal(builds.length, FAMILY.members.length);
    for (const [index, build] of builds.entries()) {
      assert.deepEqual(build.args.slice(1, 7), [
        "build",
        FAMILY.members[index].name,
        "--bump",
        VERSION,
        "--no-publish",
        "--no-git",
      ]);
    }
    assert.equal(
      control.commands.filter((command) => command.args[1] === "pack").length,
      FAMILY.members.length,
    );
  });

  it("emits no handoff and makes no npm-origin publish call when the pre-gate fails", async () => {
    const control = fixture({
      runLocalGate: async () => {
        throw new Error("generator red control failed");
      },
    });

    await assert.rejects(
      runReleaseFamily({ mode: "gate", version: VERSION, ...FULL_MATRIX }, control.dependencies),
      /generator red control failed/,
    );

    assert.equal(control.handoffs.length, 0);
    const originPublishes = control.commands.filter(
      (command) => command.args[1] === "publish" && command.args.includes(NPM_ORIGIN),
    );
    assert.equal(originPublishes.length, 0);
  });

  it("rejects a packed artifact with an emitted export target removed before staging or handoff", async () => {
    let localGateCalls = 0;
    const validEntries = [
      "package/package.json",
      "package/esm/index.mjs",
      "package/esm/index.d.mts",
    ];
    let artifactEntries = validEntries.filter((entry) => entry !== "package/esm/index.mjs");
    const control = fixture({
      inspectArtifact: async (filePath) => ({
        manifest: {
          name: filePath.includes("create-warlock")
            ? "create-warlock"
            : "@warlock.js/notifications",
          version: VERSION,
          main: "./esm/index.mjs",
          exports: { ".": { import: "./esm/index.mjs" } },
        },
        entries: artifactEntries,
      }),
      runLocalGate: async (input) => {
        localGateCalls += 1;
        return {
          kind: "warlock-family-publish-handoff",
          candidateVersion: input.candidateVersion,
          artifacts: input.artifacts.map((artifact) => ({ ...artifact })),
          verifiedAt: "2026-09-02T12:00:00.000Z",
        };
      },
    });

    await assert.rejects(
      runReleaseFamily({ mode: "gate", version: VERSION, ...FULL_MATRIX }, control.dependencies),
      /missing packed entry target \.\/esm\/index\.mjs/,
    );
    assert.equal(localGateCalls, 0);
    assert.equal(control.handoffs.length, 0);
    assert.equal(control.commands.filter((command) => command.args[1] === "publish").length, 0);

    // Restore the exact deleted entry. The same release path must now reach the
    // local gate, proving the red result came from the shared packed-entry check.
    artifactEntries = [...validEntries];
    const handoff = await runReleaseFamily(
      { mode: "gate", version: VERSION, ...FULL_MATRIX },
      control.dependencies,
    );
    assert.ok(handoff);
    assert.equal(localGateCalls, 1);
    assert.deepEqual(control.handoffs, [handoff]);
  });
});

describe("per-package clean-tree gate (card 9555ba00)", () => {
  const notificationsRoot = FAMILY.members[0].root; // "@warlock.js/notifications"
  const createWarlockRoot = FAMILY.members[1].root; // "create-warlock"

  function withGitStatus(dirtyByRoot: ReadonlyMap<string, string>): ReturnType<typeof fixture> {
    const control = fixture();
    const baseRunCommand = control.dependencies.runCommand!;
    control.dependencies.runCommand = async (request) => {
      if (request.command === "git" && request.args[0] === "status") {
        control.commands.push(request);
        const stdout = dirtyByRoot.get(request.cwd) ?? "";
        return { stdout, stderr: "" };
      }
      // Delegate every non-git command to the same baseline behaviour the
      // innocent-case fixture uses (build/pack/publish stubs).
      return await baseRunCommand(request);
    };
    return control;
  }

  it("INNOCENT CASE: a clean workspace gates green and packs every member, exactly as today", async () => {
    const control = withGitStatus(new Map());
    const handoff = await runReleaseFamily(
      { mode: "gate", version: VERSION, ...FULL_MATRIX },
      control.dependencies,
    );

    assert.ok(handoff);
    const builds = control.commands.filter((command) => command.args[1] === "build");
    const packs = control.commands.filter((command) => command.args[1] === "pack");
    assert.equal(builds.length, FAMILY.members.length);
    assert.equal(packs.length, FAMILY.members.length);
  });

  it(
    "RED CONTROL (two-sided): dirtying ONE package's published surface refuses only that " +
      "package while the other still builds and packs; reverting passes green again",
    async () => {
      const dirty = new Map([
        [notificationsRoot, " M src/index.ts\n"], // inside published surface (srcDir defaults to "src")
      ]);
      const control = withGitStatus(dirty);

      await assert.rejects(
        runReleaseFamily({ mode: "gate", version: VERSION, ...FULL_MATRIX }, control.dependencies),
        (error) => {
          const message = (error as Error).message;
          assert.match(message, /Refusing to pack @warlock\.js\/notifications/);
          assert.match(message, /src\/index\.ts/);
          return true;
        },
      );

      // Half one: the dirty package was never built or packed.
      const notificationsBuilds = control.commands.filter(
        (command) => command.args[1] === "build" && command.args[2] === "@warlock.js/notifications",
      );
      assert.equal(notificationsBuilds.length, 0, "dirty member must not be built");

      // Half two — the assertion the card says is rejected without: the OTHER
      // 27 (here, the one other fixture member) still built and packed.
      const createWarlockBuilds = control.commands.filter(
        (command) => command.args[1] === "build" && command.args[2] === "create-warlock",
      );
      const createWarlockPacks = control.commands.filter(
        (command) =>
          command.args[1] === "pack" && String(command.args[2]).includes("create-warlock"),
      );
      assert.equal(createWarlockBuilds.length, 1, "clean member must still build");
      assert.equal(createWarlockPacks.length, 1, "clean member must still pack");

      // No handoff was ever produced for the refused candidate version.
      assert.equal(control.handoffs.length, 0);

      // Revert: an all-clean tree for the same two members passes green again.
      const cleanControl = withGitStatus(new Map());
      const handoff = await runReleaseFamily(
        { mode: "gate", version: VERSION, ...FULL_MATRIX },
        cleanControl.dependencies,
      );
      assert.ok(handoff);
      assert.equal(cleanControl.handoffs.length, 1);
    },
  );

  it("a dirty file OUTSIDE the published surface does not refuse, and logs an explicit waiver", async () => {
    const dirty = new Map([
      // "tests/" is not the configured srcDir ("src") and not in this
      // package's pkgist `clone` list, so it never ships.
      [notificationsRoot, "?? tests/fixtures/new-fixture.ts\n"],
    ]);
    const control = withGitStatus(dirty);

    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const handoff = await runReleaseFamily(
        { mode: "gate", version: VERSION, ...FULL_MATRIX },
        control.dependencies,
      );
      assert.ok(handoff, "a surface-external dirty file must not block the release");
    } finally {
      console.warn = originalWarn;
    }

    const waiverLine = warnings.find((line) => line.includes("WAIVED"));
    assert.ok(
      waiverLine,
      "an explicit waiver line must be logged for the surface-external dirty file",
    );
    assert.match(waiverLine!, /@warlock\.js\/notifications/);
    assert.match(waiverLine!, /tests\/fixtures\/new-fixture\.ts/);
  });
});

describe("per-package own quality gate (test/typecheck)", () => {
  const notificationsRoot = FAMILY.members[0].root; // "@warlock.js/notifications"

  // Deterministic stand-in for the real `resolveLocalPackageScript`: marks a
  // command as "already resolved to a direct binary" (`command` is never
  // "npm" or "npx") so assertions below can tell a quality-check invocation
  // apart from a build/pack invocation without touching a real filesystem.
  const RESOLVED_MARKER = "resolved-binary";

  function resolvingDependencies(): Pick<ReleaseFamilyDependencies, "resolvePackageScript"> {
    return {
      resolvePackageScript: (memberRoot, scriptCommand) => ({
        command: RESOLVED_MARKER,
        args: [memberRoot, scriptCommand],
      }),
    };
  }

  function withPackageScripts(
    scriptsByRoot: ReadonlyMap<string, Record<string, string>>,
    runScriptResult: (
      request: CommandRequest,
    ) => { stdout: string; stderr: string } | Error = () => ({
      stdout: "",
      stderr: "",
    }),
  ): ReturnType<typeof fixture> {
    const control = fixture(resolvingDependencies());
    const baseRunCommand = control.dependencies.runCommand!;
    control.dependencies.readTextFile = async (filePath) => {
      if (path.basename(filePath) === "package.json") {
        const root = path.dirname(filePath);
        const scripts = scriptsByRoot.get(root) ?? {
          test: "vitest run",
          typecheck: "tsc --noEmit",
        };
        return JSON.stringify({ scripts });
      }
      throw new Error(`unexpected readTextFile ${filePath}`);
    };
    control.dependencies.runCommand = async (request) => {
      if (request.command === RESOLVED_MARKER) {
        control.commands.push(request);
        const outcome = runScriptResult(request);
        if (outcome instanceof Error) throw outcome;
        return outcome;
      }
      return await baseRunCommand(request);
    };
    return control;
  }

  it(
    "INNOCENT CASE: every member declares green test/typecheck scripts and the gate " +
      "passes and behaves as it does today",
    async () => {
      // Pollute the ambient environment the way the real machine does, to
      // prove the child env is scrubbed rather than merely usually-absent.
      const previousHttpPort = process.env.HTTP_PORT;
      const previousNodeEnv = process.env.NODE_ENV;
      process.env.HTTP_PORT = "4000";
      process.env.NODE_ENV = "production";
      try {
        const control = withPackageScripts(new Map());
        const handoff = await runReleaseFamily(
          { mode: "gate", version: VERSION, ...FULL_MATRIX },
          control.dependencies,
        );

        assert.ok(handoff);
        const runs = control.commands.filter((command) => command.command === RESOLVED_MARKER);
        // Both fixture members × both scripts (test, typecheck).
        assert.equal(runs.length, FAMILY.members.length * 2);
        // Never shelled through npm/npx: each run's command is the resolved
        // binary marker, never "npm" or an args[1] of "run".
        assert.ok(runs.every((run) => run.command === RESOLVED_MARKER));
        // HTTP_PORT and NODE_ENV are cleared from every quality-check child env.
        assert.ok(runs.every((run) => !("HTTP_PORT" in run.env)));
        assert.ok(runs.every((run) => !("NODE_ENV" in run.env)));

        const builds = control.commands.filter((command) => command.args[1] === "build");
        const packs = control.commands.filter((command) => command.args[1] === "pack");
        assert.equal(builds.length, FAMILY.members.length);
        assert.equal(packs.length, FAMILY.members.length);
      } finally {
        if (previousHttpPort === undefined) delete process.env.HTTP_PORT;
        else process.env.HTTP_PORT = previousHttpPort;
        if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previousNodeEnv;
      }
    },
  );

  it(
    "RED CONTROL (two-sided): breaking ONE package's test suite refuses only that package " +
      "while the other still builds and packs; restoring passes green again",
    async () => {
      const control = withPackageScripts(new Map(), (request) => {
        // args[1] carries the resolved script's original command text ("vitest run").
        if (request.cwd === notificationsRoot && request.args[1] === "vitest run") {
          return new Error(
            `${process.execPath} exited 1: FAIL src/index.spec.ts > it explodes\nAssertionError`,
          );
        }
        return { stdout: "", stderr: "" };
      });

      await assert.rejects(
        runReleaseFamily({ mode: "gate", version: VERSION, ...FULL_MATRIX }, control.dependencies),
        (error) => {
          const message = (error as Error).message;
          assert.match(message, /Refusing to pack @warlock\.js\/notifications/);
          assert.match(message, /its own quality gate is red/);
          assert.match(message, new RegExp(`"test" \\(${RESOLVED_MARKER} `));
          return true;
        },
      );

      // Half one: the red member was never built or packed.
      const notificationsBuilds = control.commands.filter(
        (command) => command.args[1] === "build" && command.args[2] === "@warlock.js/notifications",
      );
      assert.equal(notificationsBuilds.length, 0, "red member must not be built");

      // Half two — the assertion that matters: the OTHER 27 (here, the one
      // other fixture member) still built and packed despite the red sibling.
      const createWarlockBuilds = control.commands.filter(
        (command) => command.args[1] === "build" && command.args[2] === "create-warlock",
      );
      const createWarlockPacks = control.commands.filter(
        (command) =>
          command.args[1] === "pack" && String(command.args[2]).includes("create-warlock"),
      );
      assert.equal(createWarlockBuilds.length, 1, "clean sibling must still build");
      assert.equal(createWarlockPacks.length, 1, "clean sibling must still pack");
      assert.equal(control.handoffs.length, 0);

      // Restore: an all-green set of scripts for the same two members passes
      // green again.
      const cleanControl = withPackageScripts(new Map());
      const handoff = await runReleaseFamily(
        { mode: "gate", version: VERSION, ...FULL_MATRIX },
        cleanControl.dependencies,
      );
      assert.ok(handoff);
      assert.equal(cleanControl.handoffs.length, 1);
    },
  );

  it('a package with no "test" script produces a reported-skip line and does NOT refuse', async () => {
    const control = withPackageScripts(
      new Map([[notificationsRoot, { typecheck: "tsc --noEmit" }]]),
    );

    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const handoff = await runReleaseFamily(
        { mode: "gate", version: VERSION, ...FULL_MATRIX },
        control.dependencies,
      );
      assert.ok(handoff, "a missing test script must not block the release");
    } finally {
      console.warn = originalWarn;
    }

    const skipLine = warnings.find((line) => line.includes("SKIPPED"));
    assert.ok(skipLine, "a reported-skip line must be logged for the missing script");
    assert.match(skipLine!, /@warlock\.js\/notifications/);
    assert.match(skipLine!, /no "test" script/);

    // Only "typecheck" ran for the skipped member; "test" never did.
    const notificationsRuns = control.commands.filter(
      (command) => command.command === RESOLVED_MARKER && command.cwd === notificationsRoot,
    );
    assert.deepEqual(
      notificationsRuns.map((command) => command.args[1]),
      ["tsc --noEmit"],
    );
  });

  it(
    "cannot resolve a script's binary: reported as a refusal for that package, never a " +
      "silent pass and never a shelled npx fallback",
    async () => {
      const control = fixture({
        readTextFile: async (filePath) => {
          if (path.basename(filePath) === "package.json") {
            return JSON.stringify({ scripts: { test: "vitest run", typecheck: "tsc --noEmit" } });
          }
          throw new Error(`unexpected readTextFile ${filePath}`);
        },
        resolvePackageScript: () => {
          throw new Error("no node_modules/.bin/vitest found");
        },
      });

      await assert.rejects(
        runReleaseFamily({ mode: "gate", version: VERSION, ...FULL_MATRIX }, control.dependencies),
        (error) => {
          const message = (error as Error).message;
          assert.match(message, /Refusing to pack @warlock\.js\/notifications/);
          assert.match(message, /resolving "vitest run"/);
          assert.match(message, /no node_modules\/\.bin\/vitest found/);
          return true;
        },
      );
      const runCommands = control.commands.filter((command) => command.args[1] === "run");
      assert.equal(runCommands.length, 0, "must never fall back to shelling `npm run`/`npx`");
    },
  );
});

describe("per-member lockfile regeneration (the create-warlock / 5.6.0 defect)", () => {
  const notificationsRoot = FAMILY.members[0].root; // "@warlock.js/notifications" — no lockfile
  const createWarlockRoot = FAMILY.members[1].root; // "create-warlock" — has one

  const PNPM_MARKER = path.resolve("pnpm", "bin", "pnpm.mjs");

  function lockfileFixture(
    outcomes: {
      lockfileOnly?: (request: CommandRequest) => { stdout: string; stderr: string } | Error;
      frozenInstall?: (request: CommandRequest) => { stdout: string; stderr: string } | Error;
      hasWorkspacePolicy?: boolean;
    } = {},
  ) {
    const stagingRoot = path.join(path.parse(createWarlockRoot).root, "release-lockfile-stage");
    const writes: Array<{ filePath: string; contents: string }> = [];
    const removedDirectories: string[] = [];
    const control = fixture({
      // Only create-warlock carries a lockfile.
      fileExists: async (filePath) =>
        (path.basename(filePath) === "pnpm-lock.yaml" &&
          path.dirname(filePath) === createWarlockRoot) ||
        (outcomes.hasWorkspacePolicy === true &&
          path.basename(filePath) === "pnpm-workspace.yaml" &&
          path.dirname(filePath) === createWarlockRoot),
      readTextFile: async (filePath) => {
        if (path.basename(filePath) === "pnpm-workspace.yaml") {
          return "minimumReleaseAgeExclude:\n  - '@mongez/*'\n";
        }

        if (path.basename(filePath) === "package.json") {
          return JSON.stringify({ scripts: { test: "vitest run", typecheck: "tsc --noEmit" } });
        }

        if (path.basename(filePath) === "pnpm-lock.yaml") {
          return "lockfileVersion: '9.0'\n";
        }

        throw new Error(`fixture readTextFile has no stub for ${filePath}`);
      },
      makeTemporaryDirectory: async () => stagingRoot,
      removeDirectory: async (directory) => {
        removedDirectories.push(directory);
      },
      writeTextFile: async (filePath, contents) => {
        writes.push({ filePath, contents });
      },
    });
    const baseRunCommand = control.dependencies.runCommand!;
    control.dependencies.runCommand = async (request) => {
      if (request.args[0] === PNPM_MARKER && request.args[1] === "install") {
        control.commands.push(request);
        const isFrozen = request.args.includes("--frozen-lockfile");
        const outcome = isFrozen
          ? (outcomes.frozenInstall?.(request) ?? { stdout: "", stderr: "" })
          : (outcomes.lockfileOnly?.(request) ?? { stdout: "", stderr: "" });
        if (outcome instanceof Error) throw outcome;
        return outcome;
      }
      return await baseRunCommand(request);
    };
    return { ...control, stagingRoot, writes, removedDirectories };
  }

  function lockfileCommandsFor(control: ReturnType<typeof lockfileFixture>): CommandRequest[] {
    return control.commands.filter(
      (command) => command.args[0] === PNPM_MARKER && command.cwd === control.stagingRoot,
    );
  }

  it("a member WITH a lockfile gets regenerated then frozen-lockfile-checked, after its build and before its pack", async () => {
    const control = lockfileFixture({ hasWorkspacePolicy: true });
    const handoff = await runReleaseFamily(
      { mode: "gate", version: VERSION, ...FULL_MATRIX },
      control.dependencies,
    );
    assert.ok(handoff);

    const cwCommands = control.commands.filter(
      (command) =>
        (command.args[1] === "build" && command.args[2] === "create-warlock") ||
        command.args[0] === PNPM_MARKER ||
        (command.args[1] === "pack" && String(command.args[2]).includes("create-warlock")),
    );
    const orderedKinds = cwCommands.map((command) => {
      if (command.args[1] === "build") return "build";
      if (command.args[0] === PNPM_MARKER && command.args.includes("--lockfile-only"))
        return "lockfile-only";
      if (command.args[0] === PNPM_MARKER && command.args.includes("--frozen-lockfile"))
        return "frozen-lockfile";
      if (command.args[1] === "pack") return "pack";
      return "other";
    });

    assert.deepEqual(orderedKinds, ["build", "lockfile-only", "frozen-lockfile", "pack"]);

    const pnpmCommands = lockfileCommandsFor(control);
    assert.equal(pnpmCommands.length, 2);
    assert.ok(pnpmCommands.every((command) => command.command === process.execPath));
    assert.ok(pnpmCommands.every((command) => command.args[0] === PNPM_MARKER));
    assert.ok(pnpmCommands.every((command) => command.cwd !== createWarlockRoot));
    assert.ok(
      pnpmCommands.every((command) => !command.args.includes("--ignore-workspace")),
      "the isolated member policy must remain active",
    );
    assert.ok(pnpmCommands.every((command) => command.args.includes("--ignore-scripts")));
    assert.ok(
      pnpmCommands.every((command) => !command.cwd.startsWith(path.dirname(createWarlockRoot))),
    );
    assert.deepEqual(control.removedDirectories, [control.stagingRoot]);
    assert.deepEqual(
      control.writes.slice(0, 3),
      [
        {
          filePath: path.join(control.stagingRoot, "package.json"),
          contents: JSON.stringify({ scripts: { test: "vitest run", typecheck: "tsc --noEmit" } }),
        },
        {
          filePath: path.join(control.stagingRoot, "pnpm-lock.yaml"),
          contents: "lockfileVersion: '9.0'\n",
        },
        {
          filePath: path.join(control.stagingRoot, "pnpm-workspace.yaml"),
          contents: "minimumReleaseAgeExclude:\n  - '@mongez/*'\n",
        },
      ],
      "the member manifest, old lockfile, and existing policy must be copied into the isolated staging directory",
    );
    assert.deepEqual(
      control.writes.filter(
        (write) => write.filePath === path.join(createWarlockRoot, "pnpm-lock.yaml"),
      ),
      [
        {
          filePath: path.join(createWarlockRoot, "pnpm-lock.yaml"),
          contents: "lockfileVersion: '9.0'\n",
        },
      ],
      "only the validated staged lockfile may be copied into the member",
    );
    // Never through npx/pnpm exec.
    assert.ok(control.commands.every((command) => command.command !== "npx"));
    assert.ok(control.commands.every((command) => !command.args.includes("exec")));
  });

  it("does not synthesize a pnpm workspace policy when the member has none", async () => {
    const control = lockfileFixture();
    const handoff = await runReleaseFamily(
      { mode: "gate", version: VERSION, ...FULL_MATRIX },
      control.dependencies,
    );

    assert.ok(handoff);
    assert.equal(
      control.writes.filter(
        (write) => write.filePath === path.join(control.stagingRoot, "pnpm-workspace.yaml"),
      ).length,
      0,
    );
  });

  it("a member WITHOUT a lockfile gets neither regeneration nor the frozen-lockfile check, and is otherwise untouched", async () => {
    const control = lockfileFixture();
    const handoff = await runReleaseFamily(
      { mode: "gate", version: VERSION, ...FULL_MATRIX },
      control.dependencies,
    );
    assert.ok(handoff);

    assert.equal(
      control.commands.filter(
        (command) => command.args[0] === PNPM_MARKER && command.cwd === notificationsRoot,
      ).length,
      0,
    );
    const notifBuilds = control.commands.filter(
      (command) => command.args[1] === "build" && command.args[2] === "@warlock.js/notifications",
    );
    const notifPacks = control.commands.filter(
      (command) => command.args[1] === "pack" && String(command.args[2]).includes("notifications"),
    );
    assert.equal(notifBuilds.length, 1);
    assert.equal(notifPacks.length, 1);
  });

  it("RED CONTROL: a failing frozen-lockfile check refuses THAT member alone; others still build; the run throws once", async () => {
    const control = lockfileFixture({
      frozenInstall: () =>
        new Error(
          `${process.execPath} exited 1: ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" ` +
            "because pnpm-lock.yaml is not up to date with package.json",
        ),
    });

    await assert.rejects(
      runReleaseFamily({ mode: "gate", version: VERSION, ...FULL_MATRIX }, control.dependencies),
      (error) => {
        const message = (error as Error).message;
        assert.match(message, /Refusing to pack create-warlock/);
        assert.match(message, /regenerated lockfile does not agree with its rewritten manifest/);
        assert.match(message, /ERR_PNPM_OUTDATED_LOCKFILE/);
        return true;
      },
    );

    // The failing member was never packed.
    const cwPacks = control.commands.filter(
      (command) => command.args[1] === "pack" && String(command.args[2]).includes("create-warlock"),
    );
    assert.equal(cwPacks.length, 0, "member whose lockfile disagrees must not be packed");
    assert.deepEqual(
      control.writes.filter(
        (write) => write.filePath === path.join(createWarlockRoot, "pnpm-lock.yaml"),
      ),
      [],
      "a lockfile that fails frozen validation must never be copied back to the member",
    );
    assert.deepEqual(control.removedDirectories, [control.stagingRoot]);

    // The other, unaffected member still built and packed.
    const notifBuilds = control.commands.filter(
      (command) => command.args[1] === "build" && command.args[2] === "@warlock.js/notifications",
    );
    const notifPacks = control.commands.filter(
      (command) => command.args[1] === "pack" && String(command.args[2]).includes("notifications"),
    );
    assert.equal(notifBuilds.length, 1, "unaffected sibling must still build");
    assert.equal(notifPacks.length, 1, "unaffected sibling must still pack");

    // Restore: an agreeing lockfile passes green again.
    const cleanControl = lockfileFixture();
    const handoff = await runReleaseFamily(
      { mode: "gate", version: VERSION, ...FULL_MATRIX },
      cleanControl.dependencies,
    );
    assert.ok(handoff);
  });
});

describe("per-member release commit (card D1a)", () => {
  const notificationsRoot = FAMILY.members[0].root; // "@warlock.js/notifications" — no lockfile
  const createWarlockRoot = FAMILY.members[1].root; // "create-warlock" — has one

  const PNPM_MARKER = path.resolve("pnpm", "bin", "pnpm.mjs");

  function commitFixture(
    outcomes: {
      gitStatus?: ReadonlyMap<string, string>;
      commit?: (request: CommandRequest) => { stdout: string; stderr: string } | Error;
      /** What `git diff --cached --name-only` reports staged. Defaults to every path passed -- a real rewrite. */
      staged?: (request: CommandRequest) => string;
    } = {},
  ): ReturnType<typeof fixture> {
    const control = fixture({
      // Only create-warlock carries a lockfile.
      fileExists: async (filePath) =>
        path.basename(filePath) === "pnpm-lock.yaml" &&
        path.dirname(filePath) === createWarlockRoot,
    });
    const baseRunCommand = control.dependencies.runCommand!;
    const revCounts = new Map<string, number>();
    control.dependencies.runCommand = async (request) => {
      if (
        request.command === "git" &&
        request.args[0] === "rev-parse" &&
        request.args[1] !== "--abbrev-ref"
      ) {
        control.commands.push(request);
        const count = (revCounts.get(request.cwd) ?? 0) + 1;
        revCounts.set(request.cwd, count);
        // First call per member (pre-bump gitHead) vs. every call after the
        // release commit (releaseCommitSha) return distinct shas, so a test
        // can tell them apart.
        const sha = count === 1 ? "a".repeat(40) : "b".repeat(40);
        return { stdout: `${sha}\n`, stderr: "" };
      }
      if (
        request.command === "git" &&
        (request.args[0] === "add" || request.args[0] === "commit")
      ) {
        control.commands.push(request);
        const outcome = outcomes.commit?.(request) ?? { stdout: "", stderr: "" };
        if (outcome instanceof Error) throw outcome;
        return outcome;
      }
      if (request.command === "git" && request.args[0] === "status") {
        control.commands.push(request);
        const stdout = outcomes.gitStatus?.get(request.cwd) ?? "";
        return { stdout, stderr: "" };
      }
      if (
        request.command === "git" &&
        request.args[0] === "diff" &&
        request.args.includes("--cached")
      ) {
        control.commands.push(request);
        const separator = request.args.indexOf("--");
        const paths = separator === -1 ? [] : request.args.slice(separator + 1);
        const stdout =
          outcomes.staged?.(request) ??
          paths
            .map(
              (entry) => `${entry}
`,
            )
            .join("");
        return { stdout, stderr: "" };
      }
      return await baseRunCommand(request);
    };
    return control;
  }

  function gitCommandsFor(control: ReturnType<typeof fixture>, root: string): CommandRequest[] {
    return control.commands.filter((command) => command.command === "git" && command.cwd === root);
  }

  it("commits after the lockfile step and before the pack, staging ONLY the paths this release wrote", async () => {
    const control = commitFixture();
    const handoff = await runReleaseFamily(
      { mode: "gate", version: VERSION, ...FULL_MATRIX },
      control.dependencies,
    );
    assert.ok(handoff);

    const cwCommands = control.commands.filter(
      (command) =>
        (command.args[1] === "build" && command.args[2] === "create-warlock") ||
        command.args[0] === PNPM_MARKER ||
        (command.command === "git" &&
          command.cwd === createWarlockRoot &&
          (command.args[0] === "add" || command.args[0] === "commit")) ||
        (command.args[1] === "pack" && String(command.args[2]).includes("create-warlock")),
    );
    const orderedKinds = cwCommands.map((command) => {
      if (command.args[1] === "build") return "build";
      if (command.args[0] === PNPM_MARKER && command.args.includes("--lockfile-only"))
        return "lockfile-only";
      if (command.args[0] === PNPM_MARKER && command.args.includes("--frozen-lockfile"))
        return "frozen-lockfile";
      if (command.command === "git" && command.args[0] === "add") return "add";
      if (command.command === "git" && command.args[0] === "commit") return "commit";
      if (command.args[1] === "pack") return "pack";
      return "other";
    });

    assert.deepEqual(orderedKinds, [
      "build",
      "lockfile-only",
      "frozen-lockfile",
      "add",
      "commit",
      "pack",
    ]);

    const lockfileCommands = control.commands.filter((command) => command.args[0] === PNPM_MARKER);
    assert.ok(lockfileCommands.every((command) => command.cwd !== createWarlockRoot));
    assert.ok(lockfileCommands.every((command) => !command.args.includes("--ignore-workspace")));
    assert.ok(lockfileCommands.every((command) => command.args.includes("--ignore-scripts")));

    // create-warlock regenerated a lockfile this run: both package.json and
    // its lockfile are staged and committed, nothing else.
    const cwGit = gitCommandsFor(control, createWarlockRoot).filter(
      (command) => command.args[0] === "add" || command.args[0] === "commit",
    );
    for (const command of cwGit) {
      assert.deepEqual([...command.args].slice(-2).sort(), ["package.json", "pnpm-lock.yaml"]);
    }

    // notifications has no lockfile: only its package.json is staged.
    const notifGit = gitCommandsFor(control, notificationsRoot).filter(
      (command) => command.args[0] === "add" || command.args[0] === "commit",
    );
    assert.ok(notifGit.length > 0);
    for (const command of notifGit) {
      assert.deepEqual([...command.args].slice(-1), ["package.json"]);
    }

    // Never a sweep.
    for (const command of control.commands) {
      if (command.command !== "git") continue;
      if (command.args[0] === "add" || command.args[0] === "commit") {
        assert.ok(!command.args.includes("-a"));
        assert.ok(!command.args.includes("-A"));
        assert.ok(!command.args.includes("."));
      }
    }
  });

  it("a dirty path OUTSIDE the published surface is NOT staged by the release commit", async () => {
    const control = commitFixture({
      gitStatus: new Map([
        // "tests/" is not the configured srcDir ("src") and not in this
        // package's pkgist `clone` list, so it never ships and is waived by
        // checkPackageTreeIsClean -- but it is still sitting in the tree.
        [notificationsRoot, "?? tests/fixtures/somebody-elses-file.ts\n"],
      ]),
    });
    const handoff = await runReleaseFamily(
      { mode: "gate", version: VERSION, ...FULL_MATRIX },
      control.dependencies,
    );
    assert.ok(handoff, "a surface-external dirty file must not block the release");

    const notifGit = gitCommandsFor(control, notificationsRoot).filter(
      (command) => command.args[0] === "add" || command.args[0] === "commit",
    );
    assert.ok(notifGit.length > 0, "the release commit must still happen");
    for (const command of notifGit) {
      assert.ok(
        !command.args.some((arg) => arg.includes("somebody-elses-file")),
        `must never stage a path outside the published surface; got: ${command.args.join(" ")}`,
      );
      assert.deepEqual([...command.args].slice(-1), ["package.json"]);
    }
  });

  it("records the new release-commit sha in provenance, distinct from the pre-bump gitHead", async () => {
    let capturedProvenance: unknown;
    const control = commitFixture();
    control.dependencies.writeTextFile = async (filePath, contents) => {
      if (path.basename(filePath) === "build-provenance.json")
        capturedProvenance = JSON.parse(contents);
    };
    const handoff = await runReleaseFamily(
      { mode: "gate", version: VERSION, ...FULL_MATRIX },
      control.dependencies,
    );
    assert.ok(handoff);

    const provenance = capturedProvenance as {
      members: Array<{ name: string; gitHead: string; releaseCommitSha: string }>;
    };
    assert.ok(provenance, "provenance must be written");
    for (const entry of provenance.members) {
      assert.equal(entry.gitHead, "a".repeat(40));
      assert.equal(entry.releaseCommitSha, "b".repeat(40));
      assert.notEqual(entry.gitHead, entry.releaseCommitSha);
    }
  });

  it("RED CONTROL: a member whose release commit fails is refused alone; the others still build; the run throws once", async () => {
    const control = commitFixture({
      commit: (request) =>
        request.args[0] === "commit" && request.cwd === createWarlockRoot
          ? new Error(`${process.execPath} exited 1: nothing to commit? or hook refused`)
          : { stdout: "", stderr: "" },
    });

    await assert.rejects(
      runReleaseFamily({ mode: "gate", version: VERSION, ...FULL_MATRIX }, control.dependencies),
      (error) => {
        const message = (error as Error).message;
        assert.match(message, /Refusing to pack create-warlock/);
        assert.match(message, /release edits could not be committed/);
        return true;
      },
    );

    const cwPacks = control.commands.filter(
      (command) => command.args[1] === "pack" && String(command.args[2]).includes("create-warlock"),
    );
    assert.equal(cwPacks.length, 0, "member whose release commit failed must not be packed");

    const notifBuilds = control.commands.filter(
      (command) => command.args[1] === "build" && command.args[2] === "@warlock.js/notifications",
    );
    const notifPacks = control.commands.filter(
      (command) => command.args[1] === "pack" && String(command.args[2]).includes("notifications"),
    );
    assert.equal(notifBuilds.length, 1, "unaffected sibling must still build");
    assert.equal(notifPacks.length, 1, "unaffected sibling must still pack");

    // Restore: a succeeding commit passes green again.
    const cleanControl = commitFixture();
    const handoff = await runReleaseFamily(
      { mode: "gate", version: VERSION, ...FULL_MATRIX },
      cleanControl.dependencies,
    );
    assert.ok(handoff);
  });

  it("a manifest already committed at the release version (nothing staged) is NOT refused: no commit is attempted, and HEAD is the release commit", async () => {
    // The gate reconciles the version from SOURCE, so a real run always
    // starts from manifests already committed at VERSION and pkgist's
    // rewrite stages nothing. Treating that as a failed commit refused
    // every member of the 5.7.0 run.
    let capturedProvenance: unknown;
    const control = commitFixture({ staged: () => "" });
    control.dependencies.writeTextFile = async (filePath, contents) => {
      if (path.basename(filePath) === "build-provenance.json")
        capturedProvenance = JSON.parse(contents);
    };

    const handoff = await runReleaseFamily(
      { mode: "gate", version: VERSION, ...FULL_MATRIX },
      control.dependencies,
    );
    assert.ok(handoff, "a no-op release edit must not refuse the release");

    const commits = control.commands.filter(
      (command) => command.command === "git" && command.args[0] === "commit",
    );
    assert.equal(
      commits.length,
      0,
      "nothing staged means nothing to commit -- a commit must not even be attempted",
    );

    const provenance = capturedProvenance as {
      members: Array<{ name: string; releaseCommitSha: string }>;
    };
    assert.ok(provenance, "provenance must be written");
    for (const entry of provenance.members) {
      assert.match(
        entry.releaseCommitSha,
        /^[0-9a-f]{40}$/,
        `${entry.name} must record HEAD as its release commit`,
      );
    }
  });
});

describe("per-member remote-default-branch gate (the create-warlock / parked-branch defect)", () => {
  const notificationsRoot = FAMILY.members[0].root; // "@warlock.js/notifications"
  const createWarlockRoot = FAMILY.members[1].root; // "create-warlock"

  /**
   * `branchesByRoot` fakes each member's own checked-out branch
   * (`git rev-parse --abbrev-ref HEAD`); `defaultsByRoot` fakes what origin's
   * `git ls-remote --symref origin HEAD` reports as the default. A root
   * mapped to `null` in `defaultsByRoot` fakes an unresolvable answer (no
   * parseable "ref:" line) rather than a resolved-but-different one.
   */
  function withBranches(
    branchesByRoot: ReadonlyMap<string, string>,
    defaultsByRoot: ReadonlyMap<string, string | null>,
  ): ReturnType<typeof fixture> {
    const control = fixture();
    const baseRunCommand = control.dependencies.runCommand!;
    control.dependencies.runCommand = async (request) => {
      if (
        request.command === "git" &&
        request.args[0] === "rev-parse" &&
        request.args[1] === "--abbrev-ref"
      ) {
        control.commands.push(request);
        return { stdout: `${branchesByRoot.get(request.cwd) ?? "main"}\n`, stderr: "" };
      }
      if (
        request.command === "git" &&
        request.args[0] === "ls-remote" &&
        request.args[1] === "--symref"
      ) {
        control.commands.push(request);
        const value = defaultsByRoot.has(request.cwd) ? defaultsByRoot.get(request.cwd) : "main";
        if (value === null || value === undefined) return { stdout: "", stderr: "" };
        return { stdout: `ref: refs/heads/${value}\tHEAD\n${"a".repeat(40)}\tHEAD\n`, stderr: "" };
      }
      return await baseRunCommand(request);
    };
    return control;
  }

  it("INNOCENT CASE: a member checked out on origin's default branch passes and is otherwise untouched", async () => {
    const control = withBranches(
      new Map([
        [notificationsRoot, "main"],
        [createWarlockRoot, "main"],
      ]),
      new Map([
        [notificationsRoot, "main"],
        [createWarlockRoot, "main"],
      ]),
    );

    const handoff = await runReleaseFamily(
      { mode: "gate", version: VERSION, ...FULL_MATRIX },
      control.dependencies,
    );

    assert.ok(handoff);
    assert.equal(
      control.commands.filter((command) => command.args[1] === "build").length,
      FAMILY.members.length,
    );
    assert.equal(
      control.commands.filter((command) => command.args[1] === "pack").length,
      FAMILY.members.length,
    );
  });

  it('passes a member checked out on origin\'s ACTUAL resolved default, even when that default is not "main" (never a hardcoded name)', async () => {
    const control = withBranches(
      new Map([
        [notificationsRoot, "main"],
        [createWarlockRoot, "trunk"],
      ]),
      new Map([
        [notificationsRoot, "main"],
        [createWarlockRoot, "trunk"],
      ]),
    );

    const handoff = await runReleaseFamily(
      { mode: "gate", version: VERSION, ...FULL_MATRIX },
      control.dependencies,
    );

    assert.ok(
      handoff,
      "checked out on origin's own resolved default -- must pass even though it isn't \"main\"",
    );
    const cwPacks = control.commands.filter(
      (command) => command.args[1] === "pack" && String(command.args[2]).includes("create-warlock"),
    );
    assert.equal(cwPacks.length, 1);
  });

  it("refuses a member parked on a non-default branch, naming the member and BOTH branches", async () => {
    const control = withBranches(
      new Map([
        [notificationsRoot, "main"],
        [createWarlockRoot, "fix/scaffold-npm-arborist"],
      ]),
      new Map([
        [notificationsRoot, "main"],
        [createWarlockRoot, "main"],
      ]),
    );

    await assert.rejects(
      runReleaseFamily({ mode: "gate", version: VERSION, ...FULL_MATRIX }, control.dependencies),
      (error: Error) => {
        assert.match(error.message, /create-warlock/);
        assert.match(error.message, /fix\/scaffold-npm-arborist/);
        assert.match(error.message, /main/);
        return true;
      },
    );
  });

  it("one member refused on branch does not stop the others: they still build and pack, and the run throws once at the end", async () => {
    const control = withBranches(
      new Map([
        [notificationsRoot, "main"],
        [createWarlockRoot, "fix/scaffold-npm-arborist"],
      ]),
      new Map([
        [notificationsRoot, "main"],
        [createWarlockRoot, "main"],
      ]),
    );

    await assert.rejects(
      runReleaseFamily({ mode: "gate", version: VERSION, ...FULL_MATRIX }, control.dependencies),
    );

    const cwBuilds = control.commands.filter(
      (command) => command.args[1] === "build" && command.args[2] === "create-warlock",
    );
    assert.equal(cwBuilds.length, 0, "the refused member must never be built");

    const notifBuilds = control.commands.filter(
      (command) => command.args[1] === "build" && command.args[2] === "@warlock.js/notifications",
    );
    const notifPacks = control.commands.filter(
      (command) => command.args[1] === "pack" && String(command.args[2]).includes("notifications"),
    );
    assert.equal(notifBuilds.length, 1, "the unaffected sibling must still build");
    assert.equal(notifPacks.length, 1, "the unaffected sibling must still pack");
    assert.equal(control.handoffs.length, 0, "a refused member must never reach a handoff");
  });

  it("an explicit --allow-branch opt-in genuinely permits the deliberate branch release, and REPORTS its use", async () => {
    const control = withBranches(
      new Map([
        [notificationsRoot, "main"],
        [createWarlockRoot, "fix/scaffold-npm-arborist"],
      ]),
      new Map([
        [notificationsRoot, "main"],
        [createWarlockRoot, "main"],
      ]),
    );
    const reported: string[] = [];
    control.dependencies.report = (line) => reported.push(line);

    const handoff = await runReleaseFamily(
      {
        mode: "gate",
        version: VERSION,
        ...FULL_MATRIX,
        allowNonDefaultBranchFor: ["create-warlock"],
      },
      control.dependencies,
    );

    assert.ok(handoff, "the opt-in must let the deliberate branch release through");
    const cwPacks = control.commands.filter(
      (command) => command.args[1] === "pack" && String(command.args[2]).includes("create-warlock"),
    );
    assert.equal(cwPacks.length, 1, "the explicitly overridden member must still build and pack");

    const overrideLine = reported.find(
      (line) => line.includes("BRANCH OVERRIDE") && line.includes("create-warlock"),
    );
    assert.ok(overrideLine, "the override must be reported in the run output");
    assert.match(overrideLine!, /fix\/scaffold-npm-arborist/);
    assert.match(overrideLine!, /main/);
  });

  it("REFUSES rather than passes when origin's default branch cannot be resolved at all", async () => {
    const control = withBranches(
      new Map([
        [notificationsRoot, "main"],
        [createWarlockRoot, "main"],
      ]),
      new Map([
        [notificationsRoot, "main"],
        [createWarlockRoot, null],
      ]),
    );

    await assert.rejects(
      runReleaseFamily({ mode: "gate", version: VERSION, ...FULL_MATRIX }, control.dependencies),
      (error: Error) => {
        assert.match(error.message, /create-warlock/);
        assert.match(error.message, /could not resolve origin's default branch/);
        return true;
      },
    );
    const cwPacks = control.commands.filter(
      (command) => command.args[1] === "pack" && String(command.args[2]).includes("create-warlock"),
    );
    assert.equal(cwPacks.length, 0, "an unresolvable default must never be treated as a pass");
  });

  it("records BOTH the checked-out branch and origin's default branch in provenance", async () => {
    const control = withBranches(
      new Map([
        [notificationsRoot, "main"],
        [createWarlockRoot, "main"],
      ]),
      new Map([
        [notificationsRoot, "main"],
        [createWarlockRoot, "main"],
      ]),
    );
    let capturedProvenance: unknown;
    control.dependencies.writeTextFile = async (filePath, contents) => {
      if (path.basename(filePath) === "build-provenance.json")
        capturedProvenance = JSON.parse(contents);
    };

    const handoff = await runReleaseFamily(
      { mode: "gate", version: VERSION, ...FULL_MATRIX },
      control.dependencies,
    );
    assert.ok(handoff);

    const provenance = capturedProvenance as {
      members: Array<{ name: string; checkedOutBranch: string; remoteDefaultBranch: string }>;
    };
    assert.ok(provenance, "provenance must be written");
    for (const entry of provenance.members) {
      assert.equal(entry.checkedOutBranch, "main");
      assert.equal(entry.remoteDefaultBranch, "main");
    }
  });
});

describe("resolveLocalPackageScript (real filesystem, no mocking)", () => {
  const builderRoot = path.resolve(import.meta.dirname, "..", "..");

  // These assert that the resolved path is something NODE CAN EXECUTE, not that
  // it equals a particular literal. The first version of this resolver returned
  // `node_modules/.bin/<name>` and the specs asserted exactly that — so they
  // passed while the gate refused 27 of 28 packages, because `.bin/<name>` is a
  // shell shim and `node` dies on its first comment line. A spec that pins the
  // wrong answer is worse than no spec: it makes the wrong answer look agreed.
  it("resolves a plain binary script to a JS entry node can actually run", () => {
    const invocation = resolveLocalPackageScript(builderRoot, "tsx --version");
    assert.equal(invocation.command, process.execPath);
    assert.ok(existsSync(invocation.args[0] as string), `${invocation.args[0]} must exist on disk`);
    assert.ok(
      !(invocation.args[0] as string).includes(`${path.sep}.bin${path.sep}`),
      "must not resolve to the .bin shell shim — node cannot execute it",
    );
    assert.deepEqual(invocation.args.slice(1), ["--version"]);
  });

  it("resolves a binary whose name differs from its package (tsc -> typescript)", () => {
    const invocation = resolveLocalPackageScript(builderRoot, "tsc --noEmit");
    assert.ok(existsSync(invocation.args[0] as string), `${invocation.args[0]} must exist on disk`);
    assert.ok(!(invocation.args[0] as string).includes(`${path.sep}.bin${path.sep}`));
  });

  it("passes through a script that already invokes node, resolving its entry against the package", () => {
    const invocation = resolveLocalPackageScript(
      builderRoot,
      "node node_modules/tsx/dist/cli.mjs --version",
    );
    assert.equal(invocation.command, process.execPath);
    assert.equal(
      invocation.args[0],
      path.join(builderRoot, "node_modules", "tsx", "dist", "cli.mjs"),
    );
    assert.deepEqual(invocation.args.slice(1), ["--version"]);
  });

  it("strips a leading npx (and its flags) rather than shelling it, resolving the same real binary", () => {
    const direct = resolveLocalPackageScript(builderRoot, "tsx --version");
    const viaNpx = resolveLocalPackageScript(builderRoot, "npx -y tsx --version");
    assert.deepEqual(viaNpx, direct);
    assert.notEqual(viaNpx.command, "npx");
  });

  it("walks up to an ancestor when the package's own node_modules has no such binary", () => {
    // A child directory under builderRoot has no node_modules of its own;
    // resolution must still find the real ancestor entry.
    const invocation = resolveLocalPackageScript(
      path.join(builderRoot, "scripts"),
      "tsx --version",
    );
    assert.ok(existsSync(invocation.args[0] as string));
    assert.ok((invocation.args[0] as string).startsWith(path.join(builderRoot, "node_modules")));
  });

  it("throws (never falls back to a shell) when no ancestor has that binary", () => {
    assert.throws(
      () => resolveLocalPackageScript(builderRoot, "definitely-not-a-real-binary --flag"),
      /Cannot resolve local binary "definitely-not-a-real-binary"/,
    );
  });
});

describe("qualityCheckEnvironment", () => {
  it("clears HTTP_PORT and NODE_ENV without mutating the source environment", () => {
    const source = { HTTP_PORT: "4000", NODE_ENV: "production", KEEP: "yes" };
    const result = qualityCheckEnvironment(source);
    assert.equal("HTTP_PORT" in result, false);
    assert.equal("NODE_ENV" in result, false);
    assert.equal(result.KEEP, "yes");
    assert.equal(source.HTTP_PORT, "4000", "source object must be untouched");
  });
});

describe("published surface resolution", () => {
  it("resolves the real notifications package surface from pkgist.config.ts (srcDir + clone)", () => {
    // No injected config here on purpose: this proves the resolution reads
    // the ACTUAL builder/pkgist.config.ts, not a guess from the path.
    const surface = resolvePublishedSurface({
      name: "@warlock.js/notifications",
      root: "../notifications",
      clone: ["README.md", "LICENSE", "CHANGELOG.md", "skills", "llms.txt", "llms-full.txt"],
    });
    assert.equal(surface.source, "pkgist-config");
    assert.ok(surface.roots.includes("src"));
    assert.ok(surface.roots.includes("package.json"));
    assert.ok(surface.roots.includes("skills"));
    assert.ok(surface.roots.includes("llms-full.txt"));
  });

  it("falls back to treating the entire tree as published when a package has no pkgist entry", () => {
    const surface = resolvePublishedSurface(undefined);
    assert.equal(surface.source, "no-pkgist-config-fallback-entire-tree");
    assert.deepEqual(surface.roots, ["."]);
  });
});

describe("parseGitPorcelain", () => {
  it("parses modified, untracked, and renamed entries", () => {
    const entries = parseGitPorcelain(
      [" M src/index.ts", "?? skills/new-skill/SKILL.md", "R  old.ts -> src/new.ts", ""].join("\n"),
    );
    assert.deepEqual(entries, [
      { path: "src/index.ts", status: " M" },
      { path: "skills/new-skill/SKILL.md", status: "??" },
      { path: "src/new.ts", status: "R " },
    ]);
  });
});

describe("checkPackageTreeIsClean", () => {
  it("runs git status scoped to the member's own package root", async () => {
    const seenCwds: string[] = [];
    const runtimeStub = {
      runCommand: async (request: CommandRequest) => {
        seenCwds.push(request.cwd);
        assert.equal(request.command, "git");
        assert.deepEqual(request.args, ["status", "--porcelain=v1", "--untracked-files=all"]);
        return { stdout: "", stderr: "" };
      },
    };
    const member = {
      name: "@warlock.js/notifications",
      root: path.resolve("notifications"),
      configuredRoot: path.resolve("notifications"),
      version: VERSION,
    };
    const result = await checkPackageTreeIsClean(member, runtimeStub as never);
    assert.equal(result.clean, true);
    assert.deepEqual(seenCwds, [member.root]);
  });
});

describe("runReleaseFamily publish mode", () => {
  it("validates the whole batch, asserts isolated origin config, then re-hashes immediately before each publish", async () => {
    const events: string[] = [];
    const artifacts = FAMILY.members.map((member, index) => ({
      name: member.name,
      tarballPath: path.resolve(`artifact-${index}.tgz`),
      sha256: HASH,
    }));
    const control = fixture({
      readTextFile: async () =>
        JSON.stringify({
          kind: "warlock-family-publish-handoff",
          candidateVersion: VERSION,
          subjects: FAMILY.members.map((member) => member.name),
          artifacts,
          verifiedAt: "2026-09-02T12:00:00.000Z",
          matrixScope: "full",
        }),
      sha256File: async (filePath) => {
        events.push(`hash:${path.basename(filePath)}`);
        return HASH;
      },
      runCommand: async (request) => {
        if (request.args[1] === "config") {
          events.push("config");
          return { stdout: `${NPM_ORIGIN}/\n`, stderr: "" };
        }
        if (request.args[1] === "publish") {
          events.push(`publish:${path.basename(request.args[2])}`);
          assert.equal(request.env.npm_config_registry, NPM_ORIGIN);
          assert.match(request.env.npm_config_cache ?? "", /release-temp[\\/]npm-cache$/);
          assert.match(request.env.npm_config_userconfig ?? "", /user\.npmrc$/);
          assert.match(request.env.npm_config_globalconfig ?? "", /global\.npmrc$/);
          assert.ok(request.args.includes(NPM_ORIGIN));
        }
        return { stdout: "", stderr: "" };
      },
    });

    await runReleaseFamily({ mode: "publish", version: VERSION }, control.dependencies);
    assert.deepEqual(events, [
      "hash:artifact-0.tgz",
      "hash:artifact-1.tgz",
      "config",
      "hash:artifact-0.tgz",
      "publish:artifact-0.tgz",
      "hash:artifact-1.tgz",
      "publish:artifact-1.tgz",
    ]);
  });

  it("reports one progress line per package, in order, with the count (the reported defect)", async () => {
    const reported: string[] = [];
    const artifacts = FAMILY.members.map((member, index) => ({
      name: member.name,
      tarballPath: path.resolve(`artifact-${index}.tgz`),
      sha256: HASH,
    }));
    const control = fixture({
      readTextFile: async () =>
        JSON.stringify({
          kind: "warlock-family-publish-handoff",
          candidateVersion: VERSION,
          subjects: FAMILY.members.map((member) => member.name),
          artifacts,
          verifiedAt: "2026-09-02T12:00:00.000Z",
          matrixScope: "full",
        }),
      report: (line) => reported.push(line),
      runCommand: async (request) => {
        if (request.args[1] === "config") return { stdout: `${NPM_ORIGIN}/\n`, stderr: "" };
        return { stdout: "", stderr: "" };
      },
    });

    await runReleaseFamily({ mode: "publish", version: VERSION }, control.dependencies);

    assert.deepEqual(reported, [
      "[1/2] @warlock.js/notifications: published",
      "[2/2] create-warlock: published",
    ]);
  });
});

describe("--reuse-artifacts", () => {
  const notificationsRoot = FAMILY.members[0].root; // "@warlock.js/notifications"
  const createWarlockRoot = FAMILY.members[1].root; // "create-warlock"
  const RECORDED_HEAD_NOTIF = "1".repeat(40);
  const RECORDED_HEAD_CW = "2".repeat(40);
  const RECORDED_TARBALL_NOTIF = path.resolve("release-artifacts-fixture", "notifications.tgz");
  const RECORDED_TARBALL_CW = path.resolve("release-artifacts-fixture", "create-warlock.tgz");

  function reuseFixture(
    options: {
      headsByRoot?: ReadonlyMap<string, string>;
      dirtyByRoot?: ReadonlyMap<string, string>;
      hashOverridesByPath?: ReadonlyMap<string, string>;
    } = {},
  ): ReturnType<typeof fixture> {
    const control = fixture();
    const provenanceMembers = [
      {
        name: "@warlock.js/notifications",
        version: VERSION,
        tarballPath: RECORDED_TARBALL_NOTIF,
        sha256: HASH,
        gitHead: RECORDED_HEAD_NOTIF,
        gitDirtyEntries: [],
        builtAt: "2026-09-01T00:00:00.000Z",
      },
      {
        name: "create-warlock",
        version: VERSION,
        tarballPath: RECORDED_TARBALL_CW,
        sha256: HASH,
        gitHead: RECORDED_HEAD_CW,
        gitDirtyEntries: [],
        builtAt: "2026-09-01T00:00:00.000Z",
      },
    ];

    const baseReadTextFile = control.dependencies.readTextFile!;
    control.dependencies.readTextFile = async (filePath) => {
      if (path.basename(filePath) === "build-provenance.json") {
        return JSON.stringify({
          schemaVersion: 1,
          family: "warlock",
          version: VERSION,
          members: provenanceMembers,
        });
      }
      return await baseReadTextFile(filePath);
    };

    control.dependencies.fileExists = async (filePath) =>
      path.basename(filePath) !== "pnpm-workspace.yaml";

    const baseRunCommand = control.dependencies.runCommand!;
    control.dependencies.runCommand = async (request) => {
      if (
        request.command === "git" &&
        request.args[0] === "rev-parse" &&
        request.args[1] !== "--abbrev-ref"
      ) {
        control.commands.push(request);
        const recorded = request.cwd === notificationsRoot ? RECORDED_HEAD_NOTIF : RECORDED_HEAD_CW;
        const head = options.headsByRoot?.get(request.cwd) ?? recorded;
        return { stdout: `${head}\n`, stderr: "" };
      }
      if (request.command === "git" && request.args[0] === "status") {
        control.commands.push(request);
        return { stdout: options.dirtyByRoot?.get(request.cwd) ?? "", stderr: "" };
      }
      return await baseRunCommand(request);
    };

    const baseSha256File = control.dependencies.sha256File!;
    control.dependencies.sha256File = async (filePath) => {
      const override = options.hashOverridesByPath?.get(filePath);
      return override ?? (await baseSha256File(filePath));
    };

    return control;
  }

  it("REFUSES reuse when a tarball's re-hash does not match the record, and does a FULL rebuild instead", async () => {
    const control = reuseFixture({
      hashOverridesByPath: new Map([[RECORDED_TARBALL_NOTIF, "b".repeat(64)]]),
    });

    const handoff = await runReleaseFamily(
      { mode: "gate", version: VERSION, ...FULL_MATRIX, reuseArtifacts: true },
      control.dependencies,
    );

    assert.ok(handoff);
    assert.notEqual(handoff.reusedArtifacts, true);
    const builds = control.commands.filter((command) => command.args[1] === "build");
    assert.equal(
      builds.length,
      FAMILY.members.length,
      "a hash mismatch must trigger rebuilding EVERY member, never a partial reuse",
    );
    assert.equal(control.handoffs.length, 1);
  });

  it("REFUSES reuse when a package's git HEAD moved since the recorded build, and does a FULL rebuild instead", async () => {
    const control = reuseFixture({
      headsByRoot: new Map([[notificationsRoot, "f".repeat(40)]]),
    });

    const handoff = await runReleaseFamily(
      { mode: "gate", version: VERSION, ...FULL_MATRIX, reuseArtifacts: true },
      control.dependencies,
    );

    assert.ok(handoff);
    assert.notEqual(handoff.reusedArtifacts, true);
    const builds = control.commands.filter((command) => command.args[1] === "build");
    assert.equal(
      builds.length,
      FAMILY.members.length,
      "a moved HEAD must trigger rebuilding EVERY member, never a partial reuse",
    );
  });

  it("REFUSES reuse when a package's working tree changed since the recorded build, and does a FULL rebuild instead", async () => {
    // Outside the published surface (so a FRESH build of this member is not
    // itself blocked by the ordinary dirty-tree gate) -- proving reuse
    // validity is a STRICTER, whole-tree check than "safe to publish".
    const control = reuseFixture({
      dirtyByRoot: new Map([[createWarlockRoot, "?? tests/fixtures/new-fixture.ts\n"]]),
    });

    const handoff = await runReleaseFamily(
      { mode: "gate", version: VERSION, ...FULL_MATRIX, reuseArtifacts: true },
      control.dependencies,
    );

    assert.ok(handoff);
    assert.notEqual(handoff.reusedArtifacts, true);
    const builds = control.commands.filter((command) => command.args[1] === "build");
    assert.equal(
      builds.length,
      FAMILY.members.length,
      "an unrecorded working-tree change must trigger rebuilding EVERY member",
    );
  });

  it("ACCEPTS reuse when every tarball re-hashes clean and every package's HEAD/tree match the recorded build -- and the handoff records the reuse", async () => {
    const control = reuseFixture();

    const handoff = await runReleaseFamily(
      { mode: "gate", version: VERSION, ...FULL_MATRIX, reuseArtifacts: true },
      control.dependencies,
    );

    assert.ok(handoff);
    assert.equal(handoff.reusedArtifacts, true);
    assert.ok(handoff.reuseProvenance);
    assert.equal(handoff.reuseProvenance!.length, FAMILY.members.length);
    assert.deepEqual(
      handoff.artifacts.map((artifact) => artifact.tarballPath),
      [RECORDED_TARBALL_NOTIF, RECORDED_TARBALL_CW],
    );
    const builds = control.commands.filter((command) => command.args[1] === "build");
    assert.equal(builds.length, 0, "a fully valid reuse must never rebuild any member");
    assert.equal(control.handoffs.length, 1);
    assert.equal(control.handoffs[0]?.reusedArtifacts, true);
  });
});

describe("the generator-matrix scope (card 26831930, canon e00fb7b8)", () => {
  /**
   * The suite this replaced asserted that a `--only` run "can NEVER authorise
   * a publish". That was a true statement about the code and, from 2026-09-07,
   * a false one about the rules: the owner reversed it deliberately, having
   * been shown the collision — three permitted answers, one of which could
   * ship. A refusal the owner has lifted is not a safeguard; it is a trap
   * somebody hits mid-release and routes around, which is the one outcome the
   * refusal existed to prevent.
   *
   * What replaced it is a RECORD. All three scopes may publish; none of them
   * may go unstated.
   */
  const captureScope = (control: ReturnType<typeof fixture>) => {
    const seen: { scope?: string; only?: readonly string[] } = {};
    control.dependencies.runLocalGate = async (input) => {
      seen.scope = input.matrixScope;
      seen.only = input.onlyFeatures;
      return {
        kind: "warlock-family-publish-handoff",
        candidateVersion: input.candidateVersion,
        artifacts: input.artifacts.map((artifact) => ({ ...artifact })),
        verifiedAt: "2026-09-02T12:00:00.000Z",
        matrixScope: input.matrixScope,
        ...(input.onlyFeatures ? { matrixRows: [...input.onlyFeatures] } : {}),
      };
    };
    return seen;
  };

  it("OBSERVATION 1 — a FULL run still emits a handoff and still publishes, unchanged", async () => {
    const control = fixture();
    const seen = captureScope(control);

    const handoff = await runReleaseFamily(
      { mode: "gate", version: VERSION, ...FULL_MATRIX },
      control.dependencies,
    );

    assert.equal(seen.scope, "full");
    assert.equal(seen.only, undefined);
    assert.equal(control.handoffs.length, 1);
    assert.equal((handoff as ReleaseHandoff).matrixScope, "full");
  });

  it("OBSERVATION 2 — a SUBSET run WITHOUT authorisation is refused, and the refusal names what is missing", async () => {
    const control = fixture();

    await assert.rejects(
      runReleaseFamily(
        { mode: "gate", version: VERSION, matrixScope: "subset", only: ["create-warlock"] },
        control.dependencies,
      ),
      /--authorised-by/,
    );
    assert.equal(control.handoffs.length, 0);
  });

  it("OBSERVATION 3 — a SUBSET run WITH authorisation now publishes, and the handoff records the rows that ran", async () => {
    const control = fixture();
    const seen = captureScope(control);

    const handoff = (await runReleaseFamily(
      {
        mode: "gate",
        version: VERSION,
        matrixScope: "subset",
        only: ["create-warlock"],
        matrixAuthorisation: {
          authorisedBy: "Hasan",
          date: "2026-09-07",
          quote: "run the create-warlock row only",
        },
      },
      control.dependencies,
    )) as ReleaseHandoff;

    assert.equal(seen.scope, "subset");
    assert.deepEqual(seen.only, ["create-warlock"]);
    assert.equal(control.handoffs.length, 1);
    assert.equal(handoff.matrixScope, "subset");
    assert.deepEqual(handoff.matrixRows, ["create-warlock"]);
    assert.equal(handoff.matrixAuthorisation?.authorisedBy, "Hasan");
  });

  it("a NONE run publishes, needs no authorisation, and says so in the handoff", async () => {
    const control = fixture();
    const seen = captureScope(control);

    const handoff = (await runReleaseFamily(
      { mode: "gate", version: VERSION, matrixScope: "none" },
      control.dependencies,
    )) as ReleaseHandoff;

    assert.equal(seen.scope, "none");
    assert.equal(seen.only, undefined);
    assert.equal(handoff.matrixScope, "none");
    assert.equal(handoff.matrixRows, undefined);
    assert.equal(handoff.matrixAuthorisation, undefined);
  });

  it("REFUSES a gate run that states no scope at all — the default is not 'none', it is a refusal", async () => {
    const control = fixture();

    await assert.rejects(
      runReleaseFamily({ mode: "gate", version: VERSION }, control.dependencies),
      /has not stated its generator-matrix scope/,
    );
    assert.equal(control.handoffs.length, 0);
  });

  it("REFUSES a subset with no rows, and a full or none that carries rows", async () => {
    assert.throws(
      () =>
        assertMatrixScopeIsStated({
          matrixScope: "subset",
          matrixAuthorisation: {
            authorisedBy: "Hasan",
            date: "2026-09-07",
            quote: "run the create-warlock row only",
          },
        }),
      /subset with no selection/,
    );
    assert.throws(
      () =>
        assertMatrixScopeIsStated({
          matrixScope: "full",
          only: ["web"],
          matrixAuthorisation: {
            authorisedBy: "Hasan",
            date: "2026-09-07",
            quote: "run the create-warlock row only",
          },
        }),
      /must not carry a row selection/,
    );
    assert.throws(
      () => assertMatrixScopeIsStated({ matrixScope: "none", only: ["web"] }),
      /must not carry a row selection/,
    );
  });

  it("REFUSES an authorisation attached to 'none' — nobody has to authorise the default", () => {
    assert.throws(
      () =>
        assertMatrixScopeIsStated({
          matrixScope: "none",
          matrixAuthorisation: {
            authorisedBy: "Hasan",
            date: "2026-09-07",
            quote: "run the create-warlock row only",
          },
        }),
      /needs no authorisation/,
    );
  });

  it("REFUSES a half-filled authorisation by naming the missing piece", () => {
    assert.throws(
      () =>
        assertMatrixScopeIsStated({
          matrixScope: "full",
          matrixAuthorisation: { authorisedBy: "Hasan", date: "2026-09-07", quote: "" },
        }),
      /actual words/,
    );
    assert.throws(
      () =>
        assertMatrixScopeIsStated({
          matrixScope: "full",
          matrixAuthorisation: { authorisedBy: "Hasan", date: "07/09/2026", quote: "go" },
        }),
      /ISO date/,
    );
  });

  it("parses the scope and the authorisation off the command line", () => {
    const parsed = parseArguments([
      "gate",
      "--version",
      VERSION,
      "--matrix",
      "subset",
      "--only",
      "web,composed",
      "--authorised-by",
      "Hasan",
      "--authorisation-date",
      "2026-09-07",
      "--authorisation",
      "just those two rows",
    ]);

    assert.equal(parsed.matrixScope, "subset");
    assert.deepEqual(parsed.only, ["web", "composed"]);
    assert.deepEqual(parsed.matrixAuthorisation, {
      authorisedBy: "Hasan",
      date: "2026-09-07",
      quote: "just those two rows",
    });
  });

  it("refuses an unknown --matrix value rather than guessing at it", () => {
    assert.throws(
      () => parseArguments(["gate", "--version", VERSION, "--matrix", "some"]),
      /must be one of none \| subset \| full/,
    );
  });
});

type GitResponses = {
  branch?: string;
  originBranchTip?: string;
  originTagSha?: string;
  localTagSha?: string;
  ancestorOk?: boolean;
  logLines?: readonly string[];
};

/** Shared fake for every `tagAndPushMember`/`tagAndPushAllMembers` test below -- throws on any git invocation it was not told to expect, which is what proves the implementation never queries plain `git rev-parse HEAD` or passes `--force`. */
function respondToGitCommand(request: CommandRequest, responses: GitResponses) {
  if (request.command !== "git") throw new Error(`unexpected non-git command: ${request.command}`);
  const [a0, a1] = request.args;
  if (a0 === "rev-parse" && a1 === "--abbrev-ref") {
    return { stdout: `${responses.branch ?? "main"}\n`, stderr: "" };
  }
  if (a0 === "rev-parse" && a1 === "--verify") {
    if (!responses.localTagSha) throw new Error("tag does not exist locally");
    return { stdout: `${responses.localTagSha}\n`, stderr: "" };
  }
  if (a0 === "ls-remote") {
    const ref = request.args[2];
    if (ref?.startsWith("refs/heads/")) {
      return {
        stdout: responses.originBranchTip ? `${responses.originBranchTip}\t${ref}\n` : "",
        stderr: "",
      };
    }
    if (ref?.startsWith("refs/tags/")) {
      return {
        stdout: responses.originTagSha ? `${responses.originTagSha}\t${ref}\n` : "",
        stderr: "",
      };
    }
    throw new Error(`unexpected ls-remote ref: ${String(ref)}`);
  }
  if (a0 === "merge-base") {
    if (responses.ancestorOk === false) throw new Error("not an ancestor");
    return { stdout: "", stderr: "" };
  }
  if (a0 === "log") {
    return { stdout: `${(responses.logLines ?? []).join("\n")}\n`, stderr: "" };
  }
  if (a0 === "tag" || a0 === "push") {
    return { stdout: "", stderr: "" };
  }
  throw new Error(`respondToGitCommand has no stub for git ${request.args.join(" ")}`);
}

function fakeGitRuntime(responses: GitResponses) {
  const commands: CommandRequest[] = [];
  return {
    commands,
    runCommand: async (request: CommandRequest) => {
      commands.push(request);
      return respondToGitCommand(request, responses);
    },
  };
}

function fakeGitRuntimeByRoot(byRoot: ReadonlyMap<string, GitResponses>) {
  const commands: CommandRequest[] = [];
  return {
    commands,
    runCommand: async (request: CommandRequest) => {
      commands.push(request);
      const responses = byRoot.get(request.cwd);
      if (!responses) throw new Error(`fakeGitRuntimeByRoot has no stub for cwd ${request.cwd}`);
      return respondToGitCommand(request, responses);
    },
  };
}

function makeMember(name: string, root: string): WarlockFamilyMember {
  return { name, root: path.resolve(root), configuredRoot: path.resolve(root), version: VERSION };
}

function provenanceReadTextFile(
  members: ReadonlyArray<{ name: string; releaseCommitSha: string }>,
): (filePath: string) => Promise<string> {
  return async (filePath) => {
    if (path.basename(filePath) === "build-provenance.json") {
      return JSON.stringify({
        schemaVersion: 1,
        family: "warlock",
        version: VERSION,
        members: members.map((member) => ({
          name: member.name,
          version: VERSION,
          tarballPath: path.resolve(`${member.name.replace(/[@/]/g, "-")}.tgz`),
          sha256: HASH,
          gitHead: "1".repeat(40),
          releaseCommitSha: member.releaseCommitSha,
          gitDirtyEntries: [],
          builtAt: "2026-09-01T00:00:00.000Z",
        })),
      });
    }
    throw new Error(`provenanceReadTextFile has no stub for ${filePath}`);
  };
}

describe("tagAndPushMember (D1b)", () => {
  it("tags at the recorded releaseCommitSha, never at HEAD", async () => {
    const member = makeMember("@warlock.js/notifications", "tag-push-notifications-1");
    const sha = "b".repeat(40);
    const runtime = fakeGitRuntime({ branch: "main" });

    const outcome = await tagAndPushMember(member, VERSION, sha, runtime as never);

    assert.equal(outcome.refused, false);
    const tagCommand = runtime.commands.find((command) => command.args[0] === "tag");
    assert.ok(tagCommand, "a tag command must have been issued");
    assert.deepEqual(tagCommand!.args, ["tag", releaseTagName(VERSION), sha]);
    // respondToGitCommand throws on any git invocation it was not told to
    // expect -- a plain `git rev-parse HEAD` (as opposed to
    // `--abbrev-ref HEAD`) is not one of them, so reaching this point at all
    // proves HEAD's own sha was never read on this path.
  });

  it("an existing local tag at the SAME sha is success, not re-created", async () => {
    const member = makeMember("@warlock.js/notifications", "tag-push-notifications-2");
    const sha = "b".repeat(40);
    const runtime = fakeGitRuntime({ branch: "main", localTagSha: sha });

    const outcome = await tagAndPushMember(member, VERSION, sha, runtime as never);

    assert.equal(outcome.refused, false);
    assert.equal(outcome.alreadyTagged, true);
    assert.equal(outcome.tagged, false);
    assert.equal(
      runtime.commands.some((command) => command.args[0] === "tag"),
      false,
    );
  });

  it("an existing local tag at a DIFFERENT sha is a refusal, and --force is never passed", async () => {
    const member = makeMember("@warlock.js/notifications", "tag-push-notifications-3");
    const sha = "b".repeat(40);
    const runtime = fakeGitRuntime({ branch: "main", localTagSha: "d".repeat(40) });

    const outcome = await tagAndPushMember(member, VERSION, sha, runtime as never);

    assert.equal(outcome.refused, true);
    assert.match(outcome.refusalMessage, /already exists locally/);
    assert.match(outcome.refusalMessage, new RegExp(member.name.replace(/[/.]/g, "\\$&")));
    assert.equal(
      runtime.commands.some((command) => command.args.includes("--force")),
      false,
    );
  });

  it("an existing origin tag at a DIFFERENT sha is a refusal, and --force is never passed", async () => {
    const member = makeMember("@warlock.js/notifications", "tag-push-notifications-4");
    const sha = "b".repeat(40);
    const runtime = fakeGitRuntime({ branch: "main", originTagSha: "e".repeat(40) });

    const outcome = await tagAndPushMember(member, VERSION, sha, runtime as never);

    assert.equal(outcome.refused, true);
    assert.match(outcome.refusalMessage, /already exists there/);
    assert.equal(
      runtime.commands.some((command) => command.args.includes("--force")),
      false,
    );
  });

  it("a fully outstanding member is tagged locally, tagged at origin, and pushed at the recorded sha", async () => {
    const member = makeMember("@warlock.js/notifications", "tag-push-notifications-5");
    const sha = "b".repeat(40);
    const runtime = fakeGitRuntime({ branch: "main" });

    const outcome = await tagAndPushMember(member, VERSION, sha, runtime as never);

    assert.equal(outcome.refused, false);
    assert.equal(outcome.tagged, true);
    assert.equal(outcome.tagPushed, true);
    assert.equal(outcome.pushed, true);
    assert.ok(
      runtime.commands.some(
        (command) =>
          command.args[0] === "push" &&
          command.args[1] === "origin" &&
          command.args[2] === `${sha}:refs/heads/main`,
      ),
      "must push exactly the recorded sha to the branch ref, never the branch tip",
    );
  });
});

describe("tagAndPushAllMembers (D1b)", () => {
  it("refuses a member whose origin/<branch> is not an ancestor of the recorded sha, naming it, without stopping the others", async () => {
    const notif = makeMember("@warlock.js/notifications", "tag-push-family-notifications");
    const cw = makeMember("create-warlock", "tag-push-family-create-warlock");
    const notifSha = "b".repeat(40);
    const cwSha = "c".repeat(40);
    const runtime = fakeGitRuntimeByRoot(
      new Map([
        [
          notif.root,
          {
            branch: "main",
            originBranchTip: "f".repeat(40),
            ancestorOk: false,
            logLines: ["f000000 an origin commit this release does not account for"],
          },
        ],
        [cw.root, { branch: "main" }],
      ]),
    );
    const family: WarlockFamily = { name: "warlock", version: VERSION, members: [notif, cw] };
    const handoff = { subjects: [notif.name, cw.name] } as unknown as ReleaseHandoff;

    await assert.rejects(
      tagAndPushAllMembers(family, handoff, VERSION, {
        runCommand: runtime.runCommand,
        readTextFile: provenanceReadTextFile([
          { name: notif.name, releaseCommitSha: notifSha },
          { name: cw.name, releaseCommitSha: cwSha },
        ]),
      } as never),
      (error: Error) => {
        assert.match(error.message, /@warlock\.js\/notifications/);
        assert.match(error.message, /main/);
        assert.match(error.message, /an origin commit this release does not account for/);
        return true;
      },
    );

    const cwWrites = runtime.commands.filter(
      (command) =>
        command.cwd === cw.root && (command.args[0] === "tag" || command.args[0] === "push"),
    );
    assert.ok(
      cwWrites.length > 0,
      "create-warlock must still be tagged and pushed even though notifications was refused",
    );
    const notifWrites = runtime.commands.filter(
      (command) =>
        command.cwd === notif.root && (command.args[0] === "tag" || command.args[0] === "push"),
    );
    assert.equal(notifWrites.length, 0, "the refused member must never be tagged or pushed");
  });

  it("re-running after a partial push tags/pushes only the outstanding members (idempotent)", async () => {
    const notif = makeMember("@warlock.js/notifications", "tag-push-rerun-notifications");
    const cw = makeMember("create-warlock", "tag-push-rerun-create-warlock");
    const notifSha = "b".repeat(40);
    const cwSha = "c".repeat(40);
    // notifications was fully tagged + pushed in a prior run; create-warlock is outstanding.
    const runtime = fakeGitRuntimeByRoot(
      new Map([
        [
          notif.root,
          {
            branch: "main",
            localTagSha: notifSha,
            originTagSha: notifSha,
            originBranchTip: notifSha,
          },
        ],
        [cw.root, { branch: "main" }],
      ]),
    );
    const family: WarlockFamily = { name: "warlock", version: VERSION, members: [notif, cw] };
    const handoff = { subjects: [notif.name, cw.name] } as unknown as ReleaseHandoff;

    const results = await tagAndPushAllMembers(family, handoff, VERSION, {
      runCommand: runtime.runCommand,
      readTextFile: provenanceReadTextFile([
        { name: notif.name, releaseCommitSha: notifSha },
        { name: cw.name, releaseCommitSha: cwSha },
      ]),
    } as never);

    assert.deepEqual(
      results.map((result) => ({
        name: result.name,
        tagged: result.tagged,
        alreadyTagged: result.alreadyTagged,
        pushed: result.pushed,
        alreadyPushed: result.alreadyPushed,
      })),
      [
        {
          name: notif.name,
          tagged: false,
          alreadyTagged: true,
          pushed: false,
          alreadyPushed: true,
        },
        { name: cw.name, tagged: true, alreadyTagged: false, pushed: true, alreadyPushed: false },
      ],
    );

    const notifWrites = runtime.commands.filter(
      (command) =>
        command.cwd === notif.root && (command.args[0] === "tag" || command.args[0] === "push"),
    );
    assert.equal(
      notifWrites.length,
      0,
      "an already-tagged-and-pushed member must issue no write commands on re-run",
    );

    const cwWrites = runtime.commands.filter(
      (command) =>
        command.cwd === cw.root && (command.args[0] === "tag" || command.args[0] === "push"),
    );
    assert.ok(cwWrites.length > 0, "the outstanding member must still be tagged/pushed");
  });
});

describe("runReleaseFamily confirm mode — tag and push only after origin confirms (D1b)", () => {
  it("tags and pushes nothing when origin confirmation fails", async () => {
    const handoffPath = path.resolve("confirm-red-control-handoff.json");
    const control = fixture({
      readTextFile: async (filePath) => {
        if (filePath === handoffPath) {
          return JSON.stringify({
            kind: "warlock-family-publish-handoff",
            candidateVersion: VERSION,
            subjects: FAMILY.members.map((member) => member.name),
            artifacts: FAMILY.members.map((member, index) => ({
              name: member.name,
              tarballPath: path.resolve(`confirm-artifact-${index}.tgz`),
              sha256: HASH,
            })),
            verifiedAt: "2026-09-02T12:00:00.000Z",
            matrixScope: "full",
          });
        }
        throw new Error(`fixture readTextFile has no stub for ${filePath}`);
      },
      sha256File: async () => HASH,
    });
    control.dependencies.runCommand = async (request) => {
      control.commands.push(request);
      if (request.command === "git") {
        throw new Error(
          `unexpected git command reached before origin confirmation succeeded: ${request.args.join(" ")}`,
        );
      }
      if (request.args[1] === "view") {
        throw new Error("npm origin refused to confirm this candidate");
      }
      return { stdout: "", stderr: "" };
    };

    await assert.rejects(
      runReleaseFamily({ mode: "confirm", version: VERSION, handoffPath }, control.dependencies),
      /npm origin refused to confirm/,
    );

    assert.equal(
      control.commands.some((command) => command.command === "git"),
      false,
    );
  });
});

describe("confirmSubjectsAtOrigin — propagation lag vs. a partial release (D2)", () => {
  const ROOT = path.resolve("confirm-subjects-root");
  const CACHE = path.join(ROOT, "npm-cache");
  const NPMRC = path.join(ROOT, ".npmrc");
  const GLOBAL_NPMRC = path.join(ROOT, "global.npmrc");
  const ENV = { PATH: process.env.PATH ?? "" };

  function fakeRuntime(versionsByAttempt: ReadonlyMap<string, readonly (string | undefined)[]>): {
    runtime: {
      resolveNpmCli(): string;
      runCommand(request: CommandRequest): Promise<{ stdout: string; stderr: string }>;
      report(line: string): void;
      sleep(ms: number): Promise<void>;
    };
    reported: string[];
    sleeps: number[];
    viewCalls: string[];
  } {
    const reported: string[] = [];
    const sleeps: number[] = [];
    const viewCalls: string[] = [];
    const attemptsSeen = new Map<string, number>();
    return {
      reported,
      sleeps,
      viewCalls,
      runtime: {
        resolveNpmCli: () => path.resolve("npm", "bin", "npm-cli.js"),
        runCommand: async (request) => {
          const name = request.args[2]?.toString().replace(/@[^@]+$/, "") ?? "";
          viewCalls.push(name);
          const attempt = attemptsSeen.get(name) ?? 0;
          attemptsSeen.set(name, attempt + 1);
          const versions = versionsByAttempt.get(name) ?? [];
          const observed = attempt < versions.length ? versions[attempt] : versions.at(-1);
          return { stdout: JSON.stringify(observed ?? null), stderr: "" };
        },
        report: (line) => reported.push(line),
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    };
  }

  it("a subject unconfirmed on the first poll and confirmed on a later one ends PENDING then live, and the run SUCCEEDS", async () => {
    const handoff: ReleaseHandoff = {
      kind: "warlock-family-publish-handoff",
      candidateVersion: VERSION,
      subjects: ["@warlock.js/notifications"],
      artifacts: [],
      verifiedAt: "2026-09-02T12:00:00.000Z",
    };
    const { runtime, reported } = fakeRuntime(
      new Map([["@warlock.js/notifications", [undefined, VERSION]]]),
    );

    await confirmSubjectsAtOrigin(handoff, runtime, ROOT, CACHE, NPMRC, GLOBAL_NPMRC, ENV);

    assert.ok(
      reported.some(
        (line) => line.includes("@warlock.js/notifications") && line.includes("PENDING"),
      ),
      "expected a PENDING line before confirmation",
    );
    assert.ok(
      reported.some(
        (line) => line === "@warlock.js/notifications: live (confirmed on attempt 2/5)",
      ),
      "expected a live confirmation line naming the successful attempt",
    );
    assert.ok(
      reported.some((line) => line.startsWith("Origin confirmation summary: 1/1 live")),
      "expected the terminal summary to show 1/1 live",
    );
  });

  it("a subject unconfirmed for the whole budget ends MISSING and the run FAILS naming it", async () => {
    const handoff: ReleaseHandoff = {
      kind: "warlock-family-publish-handoff",
      candidateVersion: VERSION,
      subjects: ["@warlock.js/notifications"],
      artifacts: [],
      verifiedAt: "2026-09-02T12:00:00.000Z",
    };
    const { runtime, reported, sleeps } = fakeRuntime(new Map());

    await assert.rejects(
      confirmSubjectsAtOrigin(handoff, runtime, ROOT, CACHE, NPMRC, GLOBAL_NPMRC, ENV),
      /did not confirm 1 of 1 package\(s\).*@warlock\.js\/notifications/s,
    );

    assert.ok(
      reported.some((line) => line === "@warlock.js/notifications: MISSING after 5 attempt(s)"),
      "expected an explicit MISSING line",
    );
    assert.ok(
      reported.some((line) => line.startsWith("Origin confirmation summary: 0/1 live")),
      "expected the terminal summary on the failing path too",
    );
    assert.equal(sleeps.length, 4, "budget of 5 attempts retries 4 times between them");
    assert.ok(
      sleeps.every((ms) => ms === 3_000),
      "the printed/used budget must be the same delay every time",
    );
  });

  it("when two subjects are unconfirmed, BOTH are named -- the old code could name only the first", async () => {
    const handoff: ReleaseHandoff = {
      kind: "warlock-family-publish-handoff",
      candidateVersion: VERSION,
      subjects: ["@warlock.js/notifications", "create-warlock"],
      artifacts: [],
      verifiedAt: "2026-09-02T12:00:00.000Z",
    };
    const { runtime } = fakeRuntime(new Map());

    await assert.rejects(
      confirmSubjectsAtOrigin(handoff, runtime, ROOT, CACHE, NPMRC, GLOBAL_NPMRC, ENV),
      (error) => {
        assert.match((error as Error).message, /@warlock\.js\/notifications/);
        assert.match((error as Error).message, /create-warlock/);
        return true;
      },
    );
  });

  it("never asks npm's write path a read question -- no argument list anywhere contains --dry-run", async () => {
    const handoff: ReleaseHandoff = {
      kind: "warlock-family-publish-handoff",
      candidateVersion: VERSION,
      subjects: ["@warlock.js/notifications"],
      artifacts: [],
      verifiedAt: "2026-09-02T12:00:00.000Z",
    };
    const seenArgs: string[][] = [];
    const { runtime } = fakeRuntime(new Map([["@warlock.js/notifications", [VERSION]]]));
    const spyRuntime = {
      ...runtime,
      runCommand: async (request: CommandRequest) => {
        seenArgs.push([...request.args]);
        return await runtime.runCommand(request);
      },
    };

    await confirmSubjectsAtOrigin(handoff, spyRuntime, ROOT, CACHE, NPMRC, GLOBAL_NPMRC, ENV);

    assert.ok(seenArgs.length > 0);
    assert.ok(seenArgs.every((args) => !args.includes("--dry-run")));
  });
});

describe("physical Core proof", () => {
  it("rejects duplicate physical Core installations", () => {
    assert.throws(
      () =>
        assertSinglePhysicalCore([
          path.resolve("app/node_modules/@warlock.js/core"),
          path.resolve("app/node_modules/x/node_modules/@warlock.js/core"),
        ]),
      /exactly one physical/,
    );
    assert.doesNotThrow(() =>
      assertSinglePhysicalCore([path.resolve("app/node_modules/@warlock.js/core")]),
    );
  });
});
