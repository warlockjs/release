import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import type { PublishHandoff } from "../local-registry-gate.ts";
import {
  NPM_ORIGIN,
  assertSinglePhysicalCore,
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
    resolvePkgistCli: () => path.resolve("pkgist", "dist", "cli.js"),
    resolveNpmCli: () => path.resolve("npm", "bin", "npm-cli.js"),
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
