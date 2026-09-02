import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  runZeroEditGeneratorGate,
  type GateCommandRequest,
  type GeneratorGateContext,
  type ZeroEditGeneratorGateDependencies,
} from "../zero-edit-generator-gate.ts";

const VERSION = "5.3.0";
const NPM_CLI = path.resolve("tools", "npm-cli.js");
const FEATURE_ADAPTER = path.resolve("adapters", "features.mjs");
const OUTPUT_ORACLE = path.resolve("adapters", "generated-output.mjs");
const BROWSER_ORACLE = path.resolve("adapters", "generated-browser.mjs");
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function harness(
  features: string[],
  options: {
    emptyCatalog?: boolean;
    badPin?: boolean;
    nestedCore?: boolean;
    brokenGenerator?: boolean;
  } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "zero-edit-generator-spec-"));
  temporaryRoots.push(root);
  const commands: GateCommandRequest[] = [];
  const events: Array<[string, string | undefined]> = [];
  const context: GeneratorGateContext = {
    candidateVersion: VERSION,
    artifacts: [],
    registryUrl: "http://127.0.0.1:48731/",
    workspaceDirectory: root,
    npmCliPath: NPM_CLI,
    featureCatalogAdapterPath: FEATURE_ADAPTER,
    generatedOutputOraclePath: OUTPUT_ORACLE,
    browserOracleAdapterPath: BROWSER_ORACLE,
    npmEnvironment: {
      npm_config_registry: "http://127.0.0.1:48731/",
      npm_config_cache: path.join(root, "cache"),
      npm_config_userconfig: path.join(root, ".npmrc"),
      npm_config_globalconfig: path.join(root, "global-npmrc"),
    },
  };

  const dependencies: ZeroEditGeneratorGateDependencies = {
    onEvent: (event, detail) => events.push([event, detail]),
    runCommand: async (request) => {
      commands.push(request);
      const first = request.args[0];
      if (first === NPM_CLI) {
        if (request.args[1] === "install" && request.cwd.endsWith(`${path.sep}tool`)) {
          const packageRoot = path.join(request.cwd, "node_modules", "create-warlock");
          await mkdir(path.join(packageRoot, "bin"), { recursive: true });
          await json(path.join(packageRoot, "package.json"), {
            name: "create-warlock",
            version: VERSION,
          });
          await writeFile(
            path.join(packageRoot, "bin", "create-app.js"),
            "// fixture CLI\n",
            "utf8",
          );
        }
        if (
          options.nestedCore &&
          request.args[1] === "install" &&
          request.cwd.includes(`${path.sep}feature-`)
        ) {
          const nested = path.join(
            request.cwd,
            "node_modules",
            "dep",
            "node_modules",
            "@warlock.js",
            "core",
          );
          await mkdir(nested, { recursive: true });
          await json(path.join(nested, "package.json"), {
            name: "@warlock.js/core",
            version: VERSION,
          });
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }

      if (String(first).endsWith(path.join("bin", "create-app.js"))) {
        const name = String(request.args[1]);
        await makeApp(path.join(request.cwd, name));
        return { exitCode: 0, stdout: "", stderr: "" };
      }

      if (String(first).endsWith(path.join("bin", "warlock.js")) && request.args[1] === "add") {
        const manifestPath = path.join(request.cwd, "package.json");
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        const added = request.args.slice(2, -1);
        for (const feature of added) {
          manifest.dependencies[`@warlock.js/${feature}`] = options.badPin ? "^5.0.0" : VERSION;
        }
        await json(manifestPath, manifest);
        await writeFile(
          path.join(request.cwd, "src", "generated-behavior.txt"),
          options.brokenGenerator ? "BROKEN_GENERATOR\n" : `GOOD:${added.join(",")}\n`,
          "utf8",
        );
        return { exitCode: 0, stdout: "", stderr: "" };
      }

      if (first === FEATURE_ADAPTER) {
        const coreRoot = String(request.args[request.args.indexOf("--core-root") + 1]);
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            schemaVersion: 1,
            source: "installed-core-feature-map",
            coreRoot,
            complete: true,
            features: options.emptyCatalog ? [] : features,
          }),
          stderr: "",
        };
      }

      if (first === OUTPUT_ORACLE) {
        const app = arg(request, "--app-root");
        const baseline = arg(request, "--baseline-root");
        const selected = JSON.parse(arg(request, "--features-json")) as string[];
        const behavior = await readFile(path.join(app, "src", "generated-behavior.txt"), "utf8");
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            schemaVersion: 1,
            appRoot: app,
            baselineRoot: baseline,
            features: selected,
            inventoryComplete: true,
            typecheckPassed: !behavior.includes("BROKEN_GENERATOR"),
            development: { booted: true, ready: true, cleanExit: true },
            production: { booted: true, ready: true, cleanExit: true },
            introducedRoutes: selected.map((id) => ({
              id: `route:${id}`,
              developmentRequested: true,
              productionRequested: true,
            })),
            introducedCommands: selected.map((id) => ({ id: `command:${id}`, executed: true })),
            hasWeb: selected.includes("web"),
          }),
          stderr: "",
        };
      }

      if (first === BROWSER_ORACLE) {
        const app = arg(request, "--app-root");
        const behavior = await readFile(path.join(app, "src", "generated-behavior.txt"), "utf8");
        if (request.args.includes("--mutation-control")) {
          return behavior.includes("BROKEN_BY_BROWSER_CONTROL")
            ? { exitCode: 1, stdout: "ZERO_EDIT_BROWSER_ORACLE_ASSERTION_FAILED", stderr: "" }
            : { exitCode: 0, stdout: "mutation was invisible", stderr: "" };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            schemaVersion: 1,
            appRoot: app,
            development: {
              clickPassed: true,
              linkSpaNavigationPassed: true,
              hmrStatePreserved: true,
              consoleErrors: [],
              pageErrors: [],
            },
            production: {
              clickPassed: true,
              linkSpaNavigationPassed: true,
              consoleErrors: [],
              pageErrors: [],
            },
            mutation: {
              relativePath: "src/generated-behavior.txt",
              find: "GOOD:",
              replacement: "BROKEN_BY_BROWSER_CONTROL:",
            },
          }),
          stderr: "",
        };
      }

      throw new Error(`Unexpected command: ${JSON.stringify(request.args)}`);
    },
  };

  async function makeApp(app: string) {
    const core = path.join(app, "node_modules", "@warlock.js", "core");
    await mkdir(path.join(core, "bin"), { recursive: true });
    await mkdir(path.join(app, "src"), { recursive: true });
    await json(path.join(app, "package.json"), {
      name: path.basename(app),
      dependencies: { "@warlock.js/core": VERSION },
      peerDependencies: { "@warlock.js/seal": VERSION },
      optionalDependencies: { "@warlock.js/logger": VERSION },
    });
    await json(path.join(core, "package.json"), { name: "@warlock.js/core", version: VERSION });
    await writeFile(path.join(core, "bin", "warlock.js"), "// fixture CLI\n", "utf8");
    await writeFile(path.join(app, "src", "generated-behavior.txt"), "GOOD:baseline\n", "utf8");
  }

  return { root, context, dependencies, commands, events };
}

describe("zero-edit generator matrix", () => {
  it("fails closed before doing work when the required installed/generated adapters are absent", async () => {
    const fixture = await harness(["alpha"]);
    const commands: GateCommandRequest[] = [];
    await assert.rejects(
      runZeroEditGeneratorGate(
        {
          ...fixture.context,
          featureCatalogAdapterPath: undefined,
          generatedOutputOraclePath: undefined,
          browserOracleAdapterPath: undefined,
        },
        {
          ...fixture.dependencies,
          runCommand: async (request) => (
            commands.push(request),
            { exitCode: 0, stdout: "", stderr: "" }
          ),
        },
      ),
      /WARLOCK_FEATURE_CATALOG_ADAPTER/,
    );
    assert.equal(commands.length, 0);
  });

  it("rejects an empty installed feature-map result instead of using a remembered list", async () => {
    const fixture = await harness(["ignored"], { emptyCatalog: true });
    await assert.rejects(
      runZeroEditGeneratorGate(fixture.context, fixture.dependencies),
      /produced no top-level features/,
    );
    assert.equal(
      fixture.events.some(([event]) => event === "isolated-feature-added"),
      false,
    );
  });

  it("runs a fresh isolated row for every derived subject, then one composed row", async () => {
    const fixture = await harness(["alpha", "web"]);
    await runZeroEditGeneratorGate(fixture.context, fixture.dependencies);

    const creates = fixture.events
      .filter(([event]) => event === "scaffold-created")
      .map(([, name]) => name);
    assert.deepEqual(creates, ["baseline", "feature-alpha", "feature-web", "composed"]);
    assert.deepEqual(
      fixture.events.filter(
        ([event]) => event === "isolated-feature-added" || event === "composed-features-added",
      ),
      [
        ["isolated-feature-added", "alpha"],
        ["isolated-feature-added", "web"],
        ["composed-features-added", "alpha,web"],
      ],
    );
    const adds = fixture.commands.filter((command) => command.args[1] === "add");
    assert.deepEqual(
      adds.map((command) => command.args.slice(2)),
      [
        ["alpha", "--no-install"],
        ["web", "--no-install"],
        ["alpha", "web", "--no-install"],
      ],
    );
    assert.ok(adds.every((command) => command.command === process.execPath));

    const npmCommands = fixture.commands.filter((command) => command.args[0] === NPM_CLI);
    assert.ok(npmCommands.some((command) => command.args.includes("--strict-peer-deps")));
    assert.ok(
      npmCommands.some((command) => command.args.includes("ls") && command.args.includes("--all")),
    );
    for (const command of npmCommands) {
      assert.equal(command.command, process.execPath);
      for (const [flag, expected] of [
        ["--registry", fixture.context.registryUrl],
        ["--cache", fixture.context.npmEnvironment.npm_config_cache],
        ["--userconfig", fixture.context.npmEnvironment.npm_config_userconfig],
        ["--globalconfig", fixture.context.npmEnvironment.npm_config_globalconfig],
      ] as const) {
        assert.equal(command.args[command.args.indexOf(flag) + 1], expected);
      }
    }

    const webApp = path.join(fixture.root, "zero-edit-generator", "cases", "feature-web");
    assert.equal(
      await readFile(path.join(webApp, "src", "generated-behavior.txt"), "utf8"),
      "GOOD:web\n",
    );
    assert.equal(
      fixture.events.filter(([event]) => event === "browser-and-red-control-proved").length,
      2,
    );
  });

  it("rejects non-exact generated pins and more than one physical Core", async () => {
    const badPin = await harness(["alpha"], { badPin: true });
    await assert.rejects(
      runZeroEditGeneratorGate(badPin.context, badPin.dependencies),
      /must equal 5\.3\.0/,
    );

    const duplicate = await harness(["alpha"], { nestedCore: true });
    await assert.rejects(
      runZeroEditGeneratorGate(duplicate.context, duplicate.dependencies),
      /exactly one physical/,
    );
  });

  it("lets an innocent real generated file pass and catches a real mutated generator output", async () => {
    const innocent = await harness(["alpha"]);
    await runZeroEditGeneratorGate(innocent.context, innocent.dependencies);
    const innocentFile = path.join(
      innocent.root,
      "zero-edit-generator",
      "cases",
      "feature-alpha",
      "src",
      "generated-behavior.txt",
    );
    assert.equal(await readFile(innocentFile, "utf8"), "GOOD:alpha\n");

    const mutated = await harness(["alpha"], { brokenGenerator: true });
    await assert.rejects(
      runZeroEditGeneratorGate(mutated.context, mutated.dependencies),
      /incomplete typecheck\/lifecycle\/route\/command evidence/,
    );
    const mutatedFile = path.join(
      mutated.root,
      "zero-edit-generator",
      "cases",
      "feature-alpha",
      "src",
      "generated-behavior.txt",
    );
    assert.equal(await readFile(mutatedFile, "utf8"), "BROKEN_GENERATOR\n");
  });
});

function arg(request: GateCommandRequest, flag: string): string {
  const value = request.args[request.args.indexOf(flag) + 1];
  assert.equal(typeof value, "string", `missing ${flag}`);
  return value;
}

async function json(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
