import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import type { PublishHandoff } from "../local-registry-gate.ts";
import {
  NPM_ORIGIN,
  assertSinglePhysicalCore,
  checkPackageTreeIsClean,
  parseGitPorcelain,
  qualityCheckEnvironment,
  resolveLocalPackageScript,
  resolvePublishedSurface,
  runReleaseFamily,
  type CommandRequest,
  type ReleaseFamilyDependencies,
  type ReleaseHandoff,
} from "../release-family.ts";
import type { WarlockFamily } from "../warlock-family.ts";

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
    {
      name: "create-warlock",
      root: path.resolve("create-warlock"),
      configuredRoot: path.resolve("create-warlock"),
      version: VERSION,
    },
  ],
};

function fixture(
  overrides: Partial<ReleaseFamilyDependencies> = {},
): {
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
    readTextFile: async filePath => {
      // Default innocent-case package.json: both own-quality scripts declared.
      if (path.basename(filePath) === "package.json") {
        return JSON.stringify({ scripts: { test: "vitest run", typecheck: "tsc --noEmit" } });
      }
      throw new Error(`fixture readTextFile has no stub for ${filePath}`);
    },
    resolvePkgistCli: () => path.resolve("pkgist", "dist", "cli.js"),
    resolveNpmCli: () => path.resolve("npm", "bin", "npm-cli.js"),
    // Default stand-in: every quality-check script "resolves" and its run is
    // handled by the base runCommand stub below (which answers everything
    // with an empty success), so tests unrelated to the own-quality gate see
    // it pass silently. Tests that DO care override this dependency.
    resolvePackageScript: (memberRoot, scriptCommand) => ({
      command: "resolved-node",
      args: [memberRoot, scriptCommand],
    }),
    runCommand: async request => {
      commands.push(request);
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
    inspectArtifact: async filePath => {
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
    runLocalGate: async input => {
      const result: PublishHandoff = {
        kind: "warlock-family-publish-handoff",
        candidateVersion: input.candidateVersion,
        artifacts: input.artifacts.map(artifact => ({ ...artifact })),
        verifiedAt: "2026-09-02T12:00:00.000Z",
      };
      gateInputs.push(result);
      return result;
    },
    writeHandoff: async (_filePath, handoff) => {
      handoffs.push(handoff);
    },
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
        members: FAMILY.members.map(member => ({ ...member, version: "5.2.4" })),
      }),
    });

    await assert.rejects(
      runReleaseFamily({ mode: "gate", version: VERSION }, control.dependencies),
      /does not equal the reconciled family version/,
    );
    assert.equal(control.commands.length, 0);
    assert.equal(control.handoffs.length, 0);
  });

  it("lets one innocent candidate reach exactly one ordered handoff", async () => {
    const control = fixture();
    const handoff = await runReleaseFamily(
      { mode: "gate", version: VERSION },
      control.dependencies,
    );

    assert.ok(handoff);
    assert.deepEqual(handoff.subjects, FAMILY.members.map(member => member.name));
    assert.equal(control.gateInputs.length, 1);
    assert.deepEqual(control.handoffs, [handoff]);

    const builds = control.commands.filter(command => command.args[1] === "build");
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
      control.commands.filter(command => command.args[1] === "pack").length,
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
      runReleaseFamily({ mode: "gate", version: VERSION }, control.dependencies),
      /generator red control failed/,
    );

    assert.equal(control.handoffs.length, 0);
    const originPublishes = control.commands.filter(
      command =>
        command.args[1] === "publish" &&
        command.args.includes(NPM_ORIGIN),
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
    let artifactEntries = validEntries.filter(entry => entry !== "package/esm/index.mjs");
    const control = fixture({
      inspectArtifact: async filePath => ({
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
      runLocalGate: async input => {
        localGateCalls += 1;
        return {
          kind: "warlock-family-publish-handoff",
          candidateVersion: input.candidateVersion,
          artifacts: input.artifacts.map(artifact => ({ ...artifact })),
          verifiedAt: "2026-09-02T12:00:00.000Z",
        };
      },
    });

    await assert.rejects(
      runReleaseFamily({ mode: "gate", version: VERSION }, control.dependencies),
      /missing packed entry target \.\/esm\/index\.mjs/,
    );
    assert.equal(localGateCalls, 0);
    assert.equal(control.handoffs.length, 0);
    assert.equal(
      control.commands.filter(command => command.args[1] === "publish").length,
      0,
    );

    // Restore the exact deleted entry. The same release path must now reach the
    // local gate, proving the red result came from the shared packed-entry check.
    artifactEntries = [...validEntries];
    const handoff = await runReleaseFamily(
      { mode: "gate", version: VERSION },
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
    control.dependencies.runCommand = async request => {
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
    const handoff = await runReleaseFamily({ mode: "gate", version: VERSION }, control.dependencies);

    assert.ok(handoff);
    const builds = control.commands.filter(command => command.args[1] === "build");
    const packs = control.commands.filter(command => command.args[1] === "pack");
    assert.equal(builds.length, FAMILY.members.length);
    assert.equal(packs.length, FAMILY.members.length);
  });

  it("RED CONTROL (two-sided): dirtying ONE package's published surface refuses only that " +
    "package while the other still builds and packs; reverting passes green again", async () => {
    const dirty = new Map([
      [notificationsRoot, " M src/index.ts\n"], // inside published surface (srcDir defaults to "src")
    ]);
    const control = withGitStatus(dirty);

    await assert.rejects(
      runReleaseFamily({ mode: "gate", version: VERSION }, control.dependencies),
      error => {
        const message = (error as Error).message;
        assert.match(message, /Refusing to pack @warlock\.js\/notifications/);
        assert.match(message, /src\/index\.ts/);
        return true;
      },
    );

    // Half one: the dirty package was never built or packed.
    const notificationsBuilds = control.commands.filter(
      command => command.args[1] === "build" && command.args[2] === "@warlock.js/notifications",
    );
    assert.equal(notificationsBuilds.length, 0, "dirty member must not be built");

    // Half two — the assertion the card says is rejected without: the OTHER
    // 27 (here, the one other fixture member) still built and packed.
    const createWarlockBuilds = control.commands.filter(
      command => command.args[1] === "build" && command.args[2] === "create-warlock",
    );
    const createWarlockPacks = control.commands.filter(
      command => command.args[1] === "pack" && String(command.args[2]).includes("create-warlock"),
    );
    assert.equal(createWarlockBuilds.length, 1, "clean member must still build");
    assert.equal(createWarlockPacks.length, 1, "clean member must still pack");

    // No handoff was ever produced for the refused candidate version.
    assert.equal(control.handoffs.length, 0);

    // Revert: an all-clean tree for the same two members passes green again.
    const cleanControl = withGitStatus(new Map());
    const handoff = await runReleaseFamily({ mode: "gate", version: VERSION }, cleanControl.dependencies);
    assert.ok(handoff);
    assert.equal(cleanControl.handoffs.length, 1);
  });

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
      const handoff = await runReleaseFamily({ mode: "gate", version: VERSION }, control.dependencies);
      assert.ok(handoff, "a surface-external dirty file must not block the release");
    } finally {
      console.warn = originalWarn;
    }

    const waiverLine = warnings.find(line => line.includes("WAIVED"));
    assert.ok(waiverLine, "an explicit waiver line must be logged for the surface-external dirty file");
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
    runScriptResult: (request: CommandRequest) => { stdout: string; stderr: string } | Error = () => ({
      stdout: "",
      stderr: "",
    }),
  ): ReturnType<typeof fixture> {
    const control = fixture(resolvingDependencies());
    const baseRunCommand = control.dependencies.runCommand!;
    control.dependencies.readTextFile = async filePath => {
      if (path.basename(filePath) === "package.json") {
        const root = path.dirname(filePath);
        const scripts = scriptsByRoot.get(root) ?? { test: "vitest run", typecheck: "tsc --noEmit" };
        return JSON.stringify({ scripts });
      }
      throw new Error(`unexpected readTextFile ${filePath}`);
    };
    control.dependencies.runCommand = async request => {
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

  it("INNOCENT CASE: every member declares green test/typecheck scripts and the gate " +
    "passes and behaves as it does today", async () => {
    // Pollute the ambient environment the way the real machine does, to
    // prove the child env is scrubbed rather than merely usually-absent.
    const previousHttpPort = process.env.HTTP_PORT;
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.HTTP_PORT = "4000";
    process.env.NODE_ENV = "production";
    try {
      const control = withPackageScripts(new Map());
      const handoff = await runReleaseFamily({ mode: "gate", version: VERSION }, control.dependencies);

      assert.ok(handoff);
      const runs = control.commands.filter(command => command.command === RESOLVED_MARKER);
      // Both fixture members × both scripts (test, typecheck).
      assert.equal(runs.length, FAMILY.members.length * 2);
      // Never shelled through npm/npx: each run's command is the resolved
      // binary marker, never "npm" or an args[1] of "run".
      assert.ok(runs.every(run => run.command === RESOLVED_MARKER));
      // HTTP_PORT and NODE_ENV are cleared from every quality-check child env.
      assert.ok(runs.every(run => !("HTTP_PORT" in run.env)));
      assert.ok(runs.every(run => !("NODE_ENV" in run.env)));

      const builds = control.commands.filter(command => command.args[1] === "build");
      const packs = control.commands.filter(command => command.args[1] === "pack");
      assert.equal(builds.length, FAMILY.members.length);
      assert.equal(packs.length, FAMILY.members.length);
    } finally {
      if (previousHttpPort === undefined) delete process.env.HTTP_PORT;
      else process.env.HTTP_PORT = previousHttpPort;
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it("RED CONTROL (two-sided): breaking ONE package's test suite refuses only that package " +
    "while the other still builds and packs; restoring passes green again", async () => {
    const control = withPackageScripts(new Map(), request => {
      // args[1] carries the resolved script's original command text ("vitest run").
      if (request.cwd === notificationsRoot && request.args[1] === "vitest run") {
        return new Error(
          `${process.execPath} exited 1: FAIL src/index.spec.ts > it explodes\nAssertionError`,
        );
      }
      return { stdout: "", stderr: "" };
    });

    await assert.rejects(
      runReleaseFamily({ mode: "gate", version: VERSION }, control.dependencies),
      error => {
        const message = (error as Error).message;
        assert.match(message, /Refusing to pack @warlock\.js\/notifications/);
        assert.match(message, /its own quality gate is red/);
        assert.match(message, new RegExp(`"test" \\(${RESOLVED_MARKER} `));
        return true;
      },
    );

    // Half one: the red member was never built or packed.
    const notificationsBuilds = control.commands.filter(
      command => command.args[1] === "build" && command.args[2] === "@warlock.js/notifications",
    );
    assert.equal(notificationsBuilds.length, 0, "red member must not be built");

    // Half two — the assertion that matters: the OTHER 27 (here, the one
    // other fixture member) still built and packed despite the red sibling.
    const createWarlockBuilds = control.commands.filter(
      command => command.args[1] === "build" && command.args[2] === "create-warlock",
    );
    const createWarlockPacks = control.commands.filter(
      command => command.args[1] === "pack" && String(command.args[2]).includes("create-warlock"),
    );
    assert.equal(createWarlockBuilds.length, 1, "clean sibling must still build");
    assert.equal(createWarlockPacks.length, 1, "clean sibling must still pack");
    assert.equal(control.handoffs.length, 0);

    // Restore: an all-green set of scripts for the same two members passes
    // green again.
    const cleanControl = withPackageScripts(new Map());
    const handoff = await runReleaseFamily({ mode: "gate", version: VERSION }, cleanControl.dependencies);
    assert.ok(handoff);
    assert.equal(cleanControl.handoffs.length, 1);
  });

  it("a package with no \"test\" script produces a reported-skip line and does NOT refuse", async () => {
    const control = withPackageScripts(
      new Map([[notificationsRoot, { typecheck: "tsc --noEmit" }]]),
    );

    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const handoff = await runReleaseFamily({ mode: "gate", version: VERSION }, control.dependencies);
      assert.ok(handoff, "a missing test script must not block the release");
    } finally {
      console.warn = originalWarn;
    }

    const skipLine = warnings.find(line => line.includes("SKIPPED"));
    assert.ok(skipLine, "a reported-skip line must be logged for the missing script");
    assert.match(skipLine!, /@warlock\.js\/notifications/);
    assert.match(skipLine!, /no "test" script/);

    // Only "typecheck" ran for the skipped member; "test" never did.
    const notificationsRuns = control.commands.filter(
      command => command.command === RESOLVED_MARKER && command.cwd === notificationsRoot,
    );
    assert.deepEqual(notificationsRuns.map(command => command.args[1]), ["tsc --noEmit"]);
  });

  it("cannot resolve a script's binary: reported as a refusal for that package, never a " +
    "silent pass and never a shelled npx fallback", async () => {
    const control = fixture({
      readTextFile: async filePath => {
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
      runReleaseFamily({ mode: "gate", version: VERSION }, control.dependencies),
      error => {
        const message = (error as Error).message;
        assert.match(message, /Refusing to pack @warlock\.js\/notifications/);
        assert.match(message, /resolving "vitest run"/);
        assert.match(message, /no node_modules\/\.bin\/vitest found/);
        return true;
      },
    );
    const runCommands = control.commands.filter(command => command.args[1] === "run");
    assert.equal(runCommands.length, 0, "must never fall back to shelling `npm run`/`npx`");
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
    const invocation = resolveLocalPackageScript(path.join(builderRoot, "scripts"), "tsx --version");
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
      readTextFile: async () => JSON.stringify({
        kind: "warlock-family-publish-handoff",
        candidateVersion: VERSION,
        subjects: FAMILY.members.map(member => member.name),
        artifacts,
        verifiedAt: "2026-09-02T12:00:00.000Z",
      }),
      sha256File: async filePath => {
        events.push(`hash:${path.basename(filePath)}`);
        return HASH;
      },
      runCommand: async request => {
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
});

describe("physical Core proof", () => {
  it("rejects duplicate physical Core installations", () => {
    assert.throws(
      () => assertSinglePhysicalCore([
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
