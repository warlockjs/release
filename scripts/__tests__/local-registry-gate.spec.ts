import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import {
  WARLOCK_FAMILY_PACKAGE_NAMES,
  runLocalRegistryPreGate,
  type CommandRequest,
  type GateEvent,
  type LocalRegistryGateDependencies,
  type LocalRegistryGateInput,
  type PublishHandoff,
} from "../local-registry-gate";
import type { GeneratorGateContext } from "../zero-edit-generator-gate";

const VERSION = "5.3.0";
const HASH = "a".repeat(64);
const CHANGED_HASH = "b".repeat(64);
const WORKSPACE = resolve("gate-work");
const NPM_CLI = resolve("tools", "npm-cli.js");
const FEATURE_ADAPTER = resolve("adapters", "features.mjs");
const OUTPUT_ORACLE = resolve("adapters", "generated-output.mjs");
const BROWSER_ORACLE = resolve("adapters", "generated-browser.mjs");
const ARTIFACTS = WARLOCK_FAMILY_PACKAGE_NAMES.map((name, index) => ({
  name,
  tarballPath: resolve("artifacts", `${String(index).padStart(2, "0")}.tgz`),
  sha256: HASH,
}));
const INPUT: LocalRegistryGateInput = {
  candidateVersion: VERSION,
  expectedFamilyNames: WARLOCK_FAMILY_PACKAGE_NAMES,
  artifacts: ARTIFACTS,
  featureCatalogAdapterPath: FEATURE_ADAPTER,
  generatedOutputOraclePath: OUTPUT_ORACLE,
  browserOracleAdapterPath: BROWSER_ORACLE,
  // Stated, never defaulted — see `assertMatrixScopeAgreesWithRows`. These
  // cases are all about the sequencing around a matrix that DOES run, so they
  // say `"full"`; the `"none"` path has its own case below.
  matrixScope: "full",
};

function fixture(overrides: Partial<LocalRegistryGateDependencies> = {}) {
  const events: GateEvent[] = [];
  const commands: CommandRequest[] = [];
  const handoffs: PublishHandoff[] = [];
  const writes = new Map<string, string>();
  const ownershipHandles = new Set<object>();
  const deadPorts: number[] = [];
  const startRequests: Array<{ host: string; port?: number }> = [];
  const fakeServer = {
    listening: true,
    address: () => ({ address: "127.0.0.1", family: "IPv4", port: 48731 }),
  } as unknown as HttpServer;
  const ownedRegistry = { server: fakeServer, port: 48731 };
  const count = { stopped: 0, exited: 0, dead: 0, ready: 0, workspaces: 0, hashes: 0 };
  const dependencies: LocalRegistryGateDependencies = {
    makeTemporaryDirectory: async () => (++count.workspaces, WORKSPACE),
    makeDirectory: async () => undefined,
    writeTextFile: async (path, contents) => void writes.set(path, contents),
    removeDirectory: async () => undefined,
    sha256File: async () => (++count.hashes, HASH),
    resolveNpmCliPath: () => NPM_CLI,
    startRegistry: async (request) => {
      startRequests.push(request);
      return ownedRegistry;
    },
    waitForRegistryReady: async (registry) => {
      ownershipHandles.add(registry);
      count.ready += 1;
    },
    stopRegistry: async (registry) => {
      ownershipHandles.add(registry);
      count.stopped += 1;
    },
    proveRegistryClosed: async (registry) => {
      ownershipHandles.add(registry);
      count.exited += 1;
    },
    provePortDead: async (port) => {
      deadPorts.push(port);
      count.dead += 1;
    },
    runCommand: async (request) => {
      commands.push(request);
      return request.args[1] === "view"
        ? { stdout: JSON.stringify(VERSION), stderr: "" }
        : { stdout: "", stderr: "" };
    },
    runZeroEditGeneratorGate: async () => undefined,
    emitHandoff: async (handoff) => void handoffs.push(handoff),
    onEvent: (event) => void events.push(event),
    now: () => new Date("2026-09-02T12:00:00.000Z"),
    ...overrides,
  };
  return { dependencies, events, commands, handoffs, writes, count, ownershipHandles, ownedRegistry, deadPorts, startRequests };
}

describe("local registry unit sequencing controls (not the real-registry acceptance proof)", () => {
  it("rejects a family subset before creating a workspace", async () => {
    const control = fixture();
    await assert.rejects(
      runLocalRegistryPreGate(
        { ...INPUT, expectedFamilyNames: WARLOCK_FAMILY_PACKAGE_NAMES.slice(1), artifacts: ARTIFACTS.slice(1) },
        control.dependencies,
      ),
      /exactly the 29-package/,
    );
    assert.equal(control.count.workspaces, 0);
  });

  it("accepts caller order when it is the exact family set and preserves it", async () => {
    const order = [...WARLOCK_FAMILY_PACKAGE_NAMES].reverse();
    const artifacts = [...ARTIFACTS].reverse();
    const control = fixture();
    const handoff = await runLocalRegistryPreGate(
      { ...INPUT, expectedFamilyNames: order, artifacts },
      control.dependencies,
    );
    assert.deepEqual(handoff.artifacts.map(({ name }) => name), order);
  });

  it("rejects a start seam that cannot prove its claimed port belongs to its returned server", async () => {
    const dishonestServer = {
      listening: true,
      address: () => ({ address: "127.0.0.1", family: "IPv4", port: 49999 }),
    } as unknown as HttpServer;
    const control = fixture({
      startRegistry: async () => ({ server: dishonestServer, port: 48731 }),
    });
    await assert.rejects(
      runLocalRegistryPreGate(INPUT, control.dependencies),
      /exact owned loopback server and actual port/,
    );
    assert.equal(control.count.ready, 0);
    assert.equal(control.count.stopped, 1);
    assert.deepEqual(control.deadPorts, [48731]);
  });

  it('matrixScope "none" skips the MATRIX and nothing else — registry, staging and per-member confirmation all still run', async () => {
    let generatorRan = false;
    const control = fixture({
      runZeroEditGeneratorGate: async () => {
        generatorRan = true;
      },
    });

    const handoff = await runLocalRegistryPreGate(
      { ...INPUT, matrixScope: "none" },
      control.dependencies,
    );

    assert.equal(generatorRan, false, "the matrix must not run at scope none");
    assert.ok(control.events.includes("generator-gate-skipped"));
    assert.equal(control.events.includes("generator-gate-passed"), false);

    // The part that is NOT skipped, asserted rather than assumed: the registry
    // was owned and torn down, and every one of the 28 members was staged and
    // confirmed installable from it. "Skipping the matrix" must not quietly
    // become "skipping the gate".
    assert.ok(control.events.includes("registry-ready"));
    assert.ok(control.events.includes("registry-server-proved-closed"));
    assert.equal(
      control.events.filter((event) => event === "artifact-confirmed-locally").length,
      WARLOCK_FAMILY_PACKAGE_NAMES.length,
    );

    // And it says so where it counts.
    assert.equal(handoff.matrixScope, "none");
    assert.equal(handoff.matrixRows, undefined);
  });

  it("REFUSES a candidate that states no matrixScope, before anything is built or started", async () => {
    const control = fixture();
    const { matrixScope, ...withoutScope } = INPUT;

    await assert.rejects(
      runLocalRegistryPreGate(withoutScope as typeof INPUT, control.dependencies),
      /matrixScope must be stated/,
    );
    assert.deepEqual(control.events, [], "nothing may start before the scope is known");
  });

  it("keeps an innocent candidate local, immutable, sanitized, and hands off after all proofs", async () => {
    let generatorContext: GeneratorGateContext | undefined;
    const control = fixture({
      runZeroEditGeneratorGate: async (context) => {
        generatorContext = context;
        assert.equal(Object.isFrozen(context.artifacts), true);
        assert.ok(context.artifacts.every(Object.isFrozen));
        assert.equal(Object.isFrozen(context.npmEnvironment), true);
      },
    });
    const inherited = Object.fromEntries(
      ["npm_config_registry", "NPM_CONFIG_CACHE", "NODE_AUTH_TOKEN", "HTTPS_PROXY"].map(
        (key) => [key, process.env[key]],
      ),
    );
    Object.assign(process.env, {
      npm_config_registry: "https://evil.invalid/",
      NPM_CONFIG_CACHE: resolve("unsafe-cache"),
      NODE_AUTH_TOKEN: "must-not-leak",
      HTTPS_PROXY: "http://proxy.invalid",
    });
    let handoff: PublishHandoff;
    try {
      handoff = await runLocalRegistryPreGate(INPUT, control.dependencies);
    } finally {
      for (const [key, value] of Object.entries(inherited)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    assert.ok(generatorContext);
    assert.equal(generatorContext.featureCatalogAdapterPath, FEATURE_ADAPTER);
    assert.equal(generatorContext.generatedOutputOraclePath, OUTPUT_ORACLE);
    assert.equal(generatorContext.browserOracleAdapterPath, BROWSER_ORACLE);
    assert.deepEqual(control.handoffs, [handoff]);
    assert.equal(Object.isFrozen(handoff), true);
    assert.deepEqual(control.count, { stopped: 1, exited: 1, dead: 1, ready: 1, workspaces: 1, hashes: ARTIFACTS.length * 2 });
    assert.equal(control.ownershipHandles.size, 1);
    assert.equal([...control.ownershipHandles][0], control.ownedRegistry);
    assert.deepEqual(control.startRequests, [{ configPath: join(WORKSPACE, "verdaccio.yaml"), host: "127.0.0.1", cwd: WORKSPACE }]);
    assert.equal("port" in control.startRequests[0], false);
    assert.deepEqual(control.deadPorts, [control.ownedRegistry.port]);
    const config = control.writes.get(join(WORKSPACE, "verdaccio.yaml")) ?? "";
    assert.match(config, /npmjs:\n    url: https:\/\/registry\.npmjs\.org\//);
    assert.doesNotMatch(config.slice(config.indexOf("'@warlock.js/*'"), config.indexOf("'@*/*'")), /proxy:/);
    assert.match(config.slice(config.indexOf("'@*/*'")), /proxy: npmjs/);
    for (const command of control.commands) {
      assert.equal(command.command, process.execPath);
      assert.equal(command.args[0], NPM_CLI);
      for (const [option, expected] of [
        ["--registry", "http://127.0.0.1:48731/"],
        ["--cache", join(WORKSPACE, "npm-cache")],
        ["--userconfig", join(WORKSPACE, ".npmrc")],
        ["--globalconfig", join(WORKSPACE, "global-npmrc")],
      ] as const) {
        const index = command.args.indexOf(option);
        assert.notEqual(index, -1);
        assert.equal(command.args[index + 1], expected);
      }
      assert.equal(command.env.npm_config_registry, "http://127.0.0.1:48731/");
      assert.equal(command.env.NPM_CONFIG_CACHE, undefined);
      assert.equal(command.env.NODE_AUTH_TOKEN, undefined);
      assert.equal(command.env.HTTPS_PROXY, undefined);
    }
    assert.ok(control.events.indexOf("registry-ready") < control.events.indexOf("generator-gate-started"));
    assert.ok(control.events.indexOf("registry-server-proved-closed") < control.events.indexOf("port-proved-dead"));
    assert.ok(control.events.lastIndexOf("artifact-reverified") < control.events.indexOf("handoff-emitted"));
  });

  it("keeps a broken generator red and still proves process and port death", async () => {
    let publications = 0;
    const control = fixture({
      runZeroEditGeneratorGate: async () => { throw new Error("generated app does not boot"); },
      emitHandoff: async () => void ++publications,
    });
    await assert.rejects(runLocalRegistryPreGate(INPUT, control.dependencies), /does not boot/);
    assert.equal(publications, 0);
    assert.equal(control.count.exited, 1);
    assert.equal(control.count.dead, 1);
    assert.ok(control.commands.filter(({ args }) => args[1] === "publish").every(({ args }) => args.includes("http://127.0.0.1:48731/")));
  });

  it("re-hashes after generator/cleanup and rejects changed bytes before handoff", async () => {
    let hashes = 0;
    const control = fixture({ sha256File: async () => (++hashes <= 29 ? HASH : CHANGED_HASH) });
    await assert.rejects(runLocalRegistryPreGate(INPUT, control.dependencies), /changed after local rehearsal/);
    assert.equal(control.handoffs.length, 0);
    assert.equal(control.count.exited, 1);
    assert.equal(control.count.dead, 1);
  });
});

it(
  "opt-in acceptance control: real Verdaccio, exact tarballs, real zero-edit generator",
  { skip: process.env.WARLOCK_REAL_VERDACCIO_GATE !== "1" },
  async () => {
    const manifestPath = process.env.WARLOCK_GATE_MANIFEST;
    const generatorPath = process.env.WARLOCK_ZERO_EDIT_GENERATOR_GATE;
    assert.ok(manifestPath, "WARLOCK_GATE_MANIFEST is required");
    assert.ok(generatorPath, "WARLOCK_ZERO_EDIT_GENERATOR_GATE is required");
    const input = JSON.parse(await readFile(resolve(manifestPath), "utf8")) as LocalRegistryGateInput;
    const generator = (await import(pathToFileURL(resolve(generatorPath)).href)) as {
      runZeroEditGeneratorGate?: (context: GeneratorGateContext) => Promise<void>;
    };
    assert.equal(typeof generator.runZeroEditGeneratorGate, "function");
    const handoff = await runLocalRegistryPreGate(input, { runZeroEditGeneratorGate: generator.runZeroEditGeneratorGate! });
    assert.deepEqual(new Set(handoff.artifacts.map(({ name }) => name)), new Set(WARLOCK_FAMILY_PACKAGE_NAMES));
  },
);
