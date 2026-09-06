import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  realpath,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import type { CandidateArtifact } from "./local-registry-gate.ts";

const EXACT_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;
const REQUIRED_NPM_ENV = [
  "npm_config_registry",
  "npm_config_cache",
  "npm_config_userconfig",
  "npm_config_globalconfig",
] as const;

export interface GeneratorGateContext {
  candidateVersion: string;
  artifacts: readonly CandidateArtifact[];
  registryUrl: string;
  npmEnvironment: Readonly<NodeJS.ProcessEnv>;
  workspaceDirectory: string;
  /** Absolute npm-cli.js path. Defaults to the installed npm beside Node. */
  npmCliPath?: string;
  /**
   * Required JSON adapter for the installed Core feature map. The adapter is
   * called as `node adapter --core-root <root> --format json` and must print a
   * FeatureCatalog. Core's current `add --list` is ANSI text, not a stable
   * machine seam, so this gate deliberately has no remembered-list fallback.
   */
  featureCatalogAdapterPath?: string;
  /**
   * Required generated-output oracle. It inventories and executes every route
   * and command introduced relative to the untouched scaffold, and owns the
   * typecheck/dev-readiness/production-build/start probes described below.
   */
  generatedOutputOraclePath?: string;
  /**
   * Required adapter around the existing browser oracle which accepts
   * `--app-root`. The current published-react-gate creates a private fixture,
   * so pointing at it directly is intentionally rejected by its certificate.
   */
  browserOracleAdapterPath?: string;
}

export interface GateCommandRequest {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface GateCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ZeroEditGeneratorGateDependencies {
  runCommand?(request: GateCommandRequest): Promise<GateCommandResult>;
  makeDirectory?(directory: string): Promise<void>;
  readTextFile?(filePath: string): Promise<string>;
  writeTextFile?(filePath: string, contents: string): Promise<void>;
  realPath?(filePath: string): Promise<string>;
  listDirectory?(directory: string): Promise<readonly string[]>;
  pathIsDirectory?(filePath: string): Promise<boolean>;
  resolveNpmCliPath?(): string;
  onEvent?(event: string, detail?: string): void;
}

export interface FeatureCatalog {
  schemaVersion: 1;
  source: "installed-core-feature-map";
  coreRoot: string;
  complete: true;
  features: string[];
}

interface RuntimeCertificate {
  schemaVersion: 1;
  appRoot: string;
  baselineRoot: string;
  features: string[];
  inventoryComplete: true;
  typecheckPassed: true;
  development: RuntimePhaseCertificate;
  production: RuntimePhaseCertificate;
  introducedRoutes: Array<{ id: string; developmentRequested: true; productionRequested: true }>;
  introducedCommands: Array<{ id: string; executed: true }>;
  hasWeb: boolean;
}

interface RuntimePhaseCertificate {
  booted: true;
  ready: true;
  cleanExit: true;
}

interface BrowserCertificate {
  schemaVersion: 1;
  appRoot: string;
  development: {
    clickPassed: true;
    linkSpaNavigationPassed: true;
    hmrStatePreserved: true;
    consoleErrors: [];
    pageErrors: [];
  };
  production: {
    clickPassed: true;
    linkSpaNavigationPassed: true;
    consoleErrors: [];
    pageErrors: [];
  };
  mutation: { relativePath: string; find: string; replacement: string };
}

type Runtime = Required<ZeroEditGeneratorGateDependencies>;

/**
 * Full candidate generator matrix. This function has no permissive mode: all
 * feature, generated-output, and browser evidence comes from explicit adapters
 * targeting the installed/generated candidate. Missing machine seams are a
 * release blocker, never a reason to skip a row.
 */
export async function runZeroEditGeneratorGate(
  context: GeneratorGateContext,
  dependencies: ZeroEditGeneratorGateDependencies = {},
): Promise<void> {
  const runtime = withDefaults(dependencies);
  const config = assertContext(context, runtime);
  const root = path.resolve(context.workspaceDirectory, "zero-edit-generator");
  const tool = path.join(root, "tool");
  const casesRoot = path.join(root, "cases");
  await runtime.makeDirectory(tool);
  await runtime.makeDirectory(casesRoot);
  await runtime.writeTextFile(
    path.join(tool, "package.json"),
    `${JSON.stringify({ name: "warlock-zero-edit-tool", private: true }, null, 2)}\n`,
  );

  await runNpm(runtime, context, config.npmCliPath, tool, [
    "install",
    `create-warlock@${context.candidateVersion}`,
    "--save-exact",
    "--strict-peer-deps",
    "--ignore-scripts",
  ]);
  const createRoot = path.join(tool, "node_modules", "create-warlock");
  await assertInstalledIdentity(runtime, createRoot, "create-warlock", context.candidateVersion);
  const createCli = path.join(createRoot, "bin", "create-app.js");

  const baseline = await scaffold(runtime, context, createCli, casesRoot, "baseline");
  await assertGeneratedAndInstalled(runtime, context, config.npmCliPath, baseline);
  const coreRoot = path.join(baseline, "node_modules", "@warlock.js", "core");
  await assertInstalledIdentity(runtime, coreRoot, "@warlock.js/core", context.candidateVersion);

  const catalogResult = await runRequired(runtime, {
    command: process.execPath,
    args: [config.featureCatalogAdapterPath, "--core-root", coreRoot, "--format", "json"],
    cwd: baseline,
    env: gateEnvironment(context),
  }, "installed feature-map adapter");
  const catalog = parseFeatureCatalog(catalogResult.stdout, await runtime.realPath(coreRoot));
  runtime.onEvent("subjects-derived", catalog.features.join(","));

  await exerciseCase(runtime, context, config, baseline, baseline, []);
  for (const feature of catalog.features) {
    const app = await scaffold(runtime, context, createCli, casesRoot, `feature-${safeName(feature)}`);
    await addFeatures(runtime, context, app, [feature]);
    await assertGeneratedAndInstalled(runtime, context, config.npmCliPath, app);
    await exerciseCase(runtime, context, config, app, baseline, [feature]);
  }

  const composed = await scaffold(runtime, context, createCli, casesRoot, "composed");
  await addFeatures(runtime, context, composed, catalog.features);
  await assertGeneratedAndInstalled(runtime, context, config.npmCliPath, composed);
  await exerciseCase(runtime, context, config, composed, baseline, catalog.features);
}

async function scaffold(
  runtime: Runtime,
  context: GeneratorGateContext,
  createCli: string,
  parent: string,
  name: string,
): Promise<string> {
  const app = path.join(parent, name);
  if (existsSync(app)) throw new Error(`Fresh scaffold target already exists: ${app}`);
  await runRequired(runtime, {
    command: process.execPath,
    args: [createCli, name, "--yes", "--no-db", "--no-git", "--no-jwt", "--pm=npm"],
    cwd: parent,
    env: { ...gateEnvironment(context), NODE_ENV: "development" },
  }, `create-warlock ${name}`);
  await runtime.readTextFile(path.join(app, "package.json"));
  runtime.onEvent("scaffold-created", name);
  return app;
}

async function addFeatures(
  runtime: Runtime,
  context: GeneratorGateContext,
  app: string,
  features: readonly string[],
): Promise<void> {
  if (features.length === 0) throw new Error("Refusing an empty add invocation.");
  const warlockCli = path.join(app, "node_modules", "@warlock.js", "core", "bin", "warlock.js");
  await runRequired(runtime, {
    command: process.execPath,
    args: [warlockCli, "add", ...features, "--no-install"],
    cwd: app,
    env: gateEnvironment(context),
  }, `warlock add ${features.join(" ")}`);
  runtime.onEvent(features.length === 1 ? "isolated-feature-added" : "composed-features-added", features.join(","));
}

async function assertGeneratedAndInstalled(
  runtime: Runtime,
  context: GeneratorGateContext,
  npmCliPath: string,
  app: string,
): Promise<void> {
  const manifest = parseObject(await runtime.readTextFile(path.join(app, "package.json")), app);
  assertExactCandidatePins(manifest, context.candidateVersion);
  await runNpm(runtime, context, npmCliPath, app, ["install", "--strict-peer-deps"]);
  await runNpm(runtime, context, npmCliPath, app, ["ls", "--all"]);
  await assertOnePhysicalCore(runtime, app, context.candidateVersion);
}

async function exerciseCase(
  runtime: Runtime,
  context: GeneratorGateContext,
  config: RequiredAdapterConfig,
  app: string,
  baseline: string,
  features: readonly string[],
): Promise<void> {
  const args = oracleArguments(app, baseline, features, context.candidateVersion);
  const result = await runRequired(runtime, {
    command: process.execPath,
    args: [config.generatedOutputOraclePath, ...args],
    cwd: app,
    env: gateEnvironment(context),
  }, `generated-output oracle (${caseLabel(features)})`);
  const certificate = parseRuntimeCertificate(result.stdout, app, baseline, features);
  runtime.onEvent("generated-output-proved", caseLabel(features));
  if (!certificate.hasWeb) return;

  const browserRequest = {
    command: process.execPath,
    args: [config.browserOracleAdapterPath, ...args],
    cwd: app,
    env: gateEnvironment(context),
  } satisfies GateCommandRequest;
  const browser = parseBrowserCertificate(
    (await runRequired(runtime, browserRequest, `browser oracle (${caseLabel(features)})`)).stdout,
    app,
  );
  await proveBrowserMutation(runtime, browserRequest, browser, app);
  parseBrowserCertificate(
    (await runRequired(runtime, browserRequest, "browser oracle after mutation restore")).stdout,
    app,
  );
  runtime.onEvent("browser-and-red-control-proved", caseLabel(features));
}

async function proveBrowserMutation(
  runtime: Runtime,
  request: GateCommandRequest,
  certificate: BrowserCertificate,
  app: string,
): Promise<void> {
  const target = resolveInside(app, certificate.mutation.relativePath);
  const original = await runtime.readTextFile(target);
  const occurrences = original.split(certificate.mutation.find).length - 1;
  if (occurrences !== 1 || certificate.mutation.find === certificate.mutation.replacement) {
    throw new Error("Browser mutation must replace exactly one real generated behavior token.");
  }
  const mutated = original.replace(certificate.mutation.find, certificate.mutation.replacement);
  await runtime.writeTextFile(target, mutated);
  try {
    const failed = await runtime.runCommand({
      ...request,
      args: [...request.args, "--mutation-control"],
    });
    if (failed.exitCode === 0 || !/ZERO_EDIT_BROWSER_ORACLE_ASSERTION_FAILED/.test(`${failed.stdout}\n${failed.stderr}`)) {
      throw new Error("Browser oracle did not fail on the real generated-file mutation control.");
    }
  } finally {
    await runtime.writeTextFile(target, original);
  }
  if ((await runtime.readTextFile(target)) !== original) {
    throw new Error(`Browser mutation target was not restored: ${target}`);
  }
}

interface RequiredAdapterConfig {
  npmCliPath: string;
  featureCatalogAdapterPath: string;
  generatedOutputOraclePath: string;
  browserOracleAdapterPath: string;
}

function assertContext(context: GeneratorGateContext, runtime: Runtime): RequiredAdapterConfig {
  if (!EXACT_VERSION.test(context.candidateVersion)) throw new Error("Generator candidate must be an exact semver.");
  if (!path.isAbsolute(context.workspaceDirectory)) throw new Error("Generator workspace must be absolute.");
  const registry = new URL(context.registryUrl);
  if (registry.protocol !== "http:" || registry.hostname !== "127.0.0.1" || !registry.port) {
    throw new Error("Generator registry must be an explicit owned 127.0.0.1 HTTP registry.");
  }
  for (const key of REQUIRED_NPM_ENV) {
    if (!context.npmEnvironment[key]) throw new Error(`Generator npm environment is missing ${key}.`);
  }
  if (context.npmEnvironment.npm_config_registry !== context.registryUrl) {
    throw new Error("Generator npm environment registry does not match its explicit registry URL.");
  }
  const required = (value: string | undefined, envName: string): string => {
    if (!value || !path.isAbsolute(value)) {
      throw new Error(`${envName} must name an absolute required adapter; this gate never skips or substitutes a fixture.`);
    }
    return path.resolve(value);
  };
  const npmCliPath = context.npmCliPath ?? runtime.resolveNpmCliPath();
  if (!path.isAbsolute(npmCliPath) || path.basename(npmCliPath) !== "npm-cli.js") {
    throw new Error("npmCliPath must be an absolute npm-cli.js path.");
  }
  return {
    npmCliPath,
    featureCatalogAdapterPath: required(context.featureCatalogAdapterPath, "WARLOCK_FEATURE_CATALOG_ADAPTER"),
    generatedOutputOraclePath: required(context.generatedOutputOraclePath, "WARLOCK_GENERATED_OUTPUT_ORACLE"),
    browserOracleAdapterPath: required(context.browserOracleAdapterPath, "WARLOCK_GENERATED_BROWSER_ORACLE"),
  };
}

async function runNpm(
  runtime: Runtime,
  context: GeneratorGateContext,
  npmCliPath: string,
  cwd: string,
  args: readonly string[],
): Promise<GateCommandResult> {
  const explicit = [
    "--registry", context.registryUrl,
    "--cache", context.npmEnvironment.npm_config_cache!,
    "--userconfig", context.npmEnvironment.npm_config_userconfig!,
    "--globalconfig", context.npmEnvironment.npm_config_globalconfig!,
    "--no-audit", "--no-fund",
  ];
  return await runRequired(runtime, {
    command: process.execPath,
    args: [npmCliPath, ...args, ...explicit],
    cwd,
    env: gateEnvironment(context),
  }, `npm ${args.join(" ")}`);
}

async function runRequired(runtime: Runtime, request: GateCommandRequest, label: string): Promise<GateCommandResult> {
  if (request.command !== process.execPath) throw new Error(`${label} must execute through the current Node binary.`);
  const result = await runtime.runCommand(request);
  if (result.exitCode !== 0) {
    throw new Error(`${label} exited ${result.exitCode}: ${tail(result.stderr || result.stdout)}`);
  }
  return result;
}

function gateEnvironment(context: GeneratorGateContext): NodeJS.ProcessEnv {
  return { ...context.npmEnvironment, CI: "1", NO_COLOR: "1" };
}

export function assertExactCandidatePins(manifest: Record<string, unknown>, version: string): void {
  let found = 0;
  for (const field of DEPENDENCY_FIELDS) {
    const value = manifest[field];
    if (value === undefined) continue;
    if (!isStringRecord(value)) throw new Error(`Generated ${field} must be an object.`);
    for (const [name, specification] of Object.entries(value)) {
      if (!name.startsWith("@warlock.js/")) continue;
      found += 1;
      if (specification !== version) {
        throw new Error(`Generated ${field}.${name} must equal ${version}; found ${specification}.`);
      }
    }
  }
  if (found === 0) throw new Error("Generated app declared no @warlock.js/* dependencies.");
}

async function assertOnePhysicalCore(runtime: Runtime, app: string, version: string): Promise<void> {
  const roots: string[] = [];
  await walk(app);
  const physical = new Set<string>();
  for (const root of roots) physical.add(await runtime.realPath(root));
  if (physical.size !== 1 || roots.length !== 1) {
    throw new Error(`Expected exactly one physical @warlock.js/core; found ${roots.length} locations / ${physical.size} real paths.`);
  }
  await assertInstalledIdentity(runtime, roots[0], "@warlock.js/core", version);

  async function walk(directory: string): Promise<void> {
    for (const name of await runtime.listDirectory(directory)) {
      if (name === ".git") continue;
      const child = path.join(directory, name);
      if (!(await runtime.pathIsDirectory(child))) continue;
      if (name === "node_modules") {
        const candidate = path.join(child, "@warlock.js", "core");
        if (await runtime.pathIsDirectory(candidate)) roots.push(candidate);
      }
      await walk(child);
    }
  }
}

async function assertInstalledIdentity(runtime: Runtime, root: string, name: string, version: string): Promise<void> {
  const manifest = parseObject(await runtime.readTextFile(path.join(root, "package.json")), root);
  if (manifest.name !== name || manifest.version !== version) {
    throw new Error(`Installed identity mismatch for ${name}: ${String(manifest.name)}@${String(manifest.version)}.`);
  }
}

export function parseFeatureCatalog(source: string, coreRoot: string): FeatureCatalog {
  const value = parseObject(source, "feature catalog") as Partial<FeatureCatalog>;
  if (value.schemaVersion !== 1 || value.source !== "installed-core-feature-map" || value.complete !== true) {
    throw new Error("Feature adapter must return a complete schemaVersion 1 installed-core-feature-map catalog.");
  }
  if (path.resolve(String(value.coreRoot ?? "")) !== path.resolve(coreRoot)) {
    throw new Error("Feature catalog did not identify the installed Core root it inspected.");
  }
  if (!Array.isArray(value.features) || value.features.length === 0) {
    throw new Error("Installed Core feature map produced no top-level features.");
  }
  if (new Set(value.features).size !== value.features.length || !value.features.every(validFeature)) {
    throw new Error("Installed Core feature catalog contains duplicate or unsafe feature keys.");
  }
  return value as FeatureCatalog;
}

function parseRuntimeCertificate(source: string, app: string, baseline: string, features: readonly string[]): RuntimeCertificate {
  const value = parseObject(source, "generated-output certificate") as unknown as RuntimeCertificate;
  if (
    value.schemaVersion !== 1 || value.inventoryComplete !== true || value.typecheckPassed !== true ||
    path.resolve(value.appRoot ?? "") !== path.resolve(app) ||
    path.resolve(value.baselineRoot ?? "") !== path.resolve(baseline) ||
    !sameStrings(value.features, features) ||
    !phasePassed(value.development) || !phasePassed(value.production) ||
    !Array.isArray(value.introducedRoutes) ||
    value.introducedRoutes.some(route => !route.id || route.developmentRequested !== true || route.productionRequested !== true) ||
    !Array.isArray(value.introducedCommands) ||
    value.introducedCommands.some(command => !command.id || command.executed !== true) ||
    typeof value.hasWeb !== "boolean"
  ) {
    throw new Error("Generated-output oracle returned incomplete typecheck/lifecycle/route/command evidence.");
  }
  return value;
}

function parseBrowserCertificate(source: string, app: string): BrowserCertificate {
  const value = parseObject(source, "browser certificate") as unknown as BrowserCertificate;
  if (
    value.schemaVersion !== 1 || path.resolve(value.appRoot ?? "") !== path.resolve(app) ||
    value.development?.clickPassed !== true || value.development?.linkSpaNavigationPassed !== true ||
    value.development?.hmrStatePreserved !== true || value.development?.consoleErrors?.length !== 0 ||
    value.development?.pageErrors?.length !== 0 || value.production?.clickPassed !== true ||
    value.production?.linkSpaNavigationPassed !== true || value.production?.consoleErrors?.length !== 0 ||
    value.production?.pageErrors?.length !== 0 || !value.mutation?.relativePath || !value.mutation.find ||
    !value.mutation.replacement
  ) {
    throw new Error("Browser oracle returned incomplete generated-app dev/prod/click/Link/HMR/error evidence.");
  }
  resolveInside(app, value.mutation.relativePath);
  return value;
}

function oracleArguments(app: string, baseline: string, features: readonly string[], version: string): string[] {
  return ["--app-root", app, "--baseline-root", baseline, "--features-json", JSON.stringify(features), "--candidate-version", version, "--format", "json"];
}

function resolveInside(root: string, relative: string): string {
  if (path.isAbsolute(relative)) throw new Error("Mutation path must be relative to the generated app.");
  const resolved = path.resolve(root, relative);
  const relation = path.relative(path.resolve(root), resolved);
  if (!relation || relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new Error("Mutation path escapes or names the generated app root.");
  }
  return resolved;
}

function parseObject(source: string, label: string): Record<string, unknown> {
  try {
    const value = JSON.parse(source.trim());
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Cannot parse ${label} JSON: ${formatError(error)}.`);
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.values(value as object).every(item => typeof item === "string");
}

function validFeature(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function safeName(value: string): string {
  if (!validFeature(value)) throw new Error(`Unsafe feature key: ${value}`);
  return value;
}

function phasePassed(value: RuntimePhaseCertificate | undefined): boolean {
  return value?.booted === true && value.ready === true && value.cleanExit === true;
}

function sameStrings(left: readonly string[] | undefined, right: readonly string[]): boolean {
  return Array.isArray(left) && left.length === right.length && left.every((item, index) => item === right[index]);
}

function caseLabel(features: readonly string[]): string {
  return features.length === 0 ? "baseline" : features.length === 1 ? features[0] : "composed";
}

function tail(value: string): string {
  return value.split(/\r?\n/).slice(-40).join("\n");
}

function formatError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export function defaultResolveNpmCliPath(): string {
  const require = createRequire(import.meta.url);
  const candidates: string[] = [];
  try {
    candidates.push(path.join(path.dirname(require.resolve("npm/package.json")), "bin", "npm-cli.js"));
  } catch {
    // Fall through to layouts relative to the active Node executable.
  }
  candidates.push(
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  );
  const found = candidates.find(candidate => path.isAbsolute(candidate) && existsSync(candidate));
  if (!found) throw new Error("Cannot resolve an absolute npm-cli.js; pass GeneratorGateContext.npmCliPath.");
  return found;
}

async function defaultRunCommand(request: GateCommandRequest): Promise<GateCommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(request.command, [...request.args], {
      cwd: request.cwd,
      env: request.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", chunk => (stdout += chunk));
    child.stderr?.setEncoding("utf8").on("data", chunk => (stderr += chunk));
    child.once("error", reject);
    child.once("close", code => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });
}

function withDefaults(dependencies: ZeroEditGeneratorGateDependencies): Runtime {
  return {
    runCommand: dependencies.runCommand ?? defaultRunCommand,
    makeDirectory: dependencies.makeDirectory ?? (directory => mkdir(directory, { recursive: true }).then(() => undefined)),
    readTextFile: dependencies.readTextFile ?? (file => readFile(file, "utf8")),
    writeTextFile: dependencies.writeTextFile ?? ((file, contents) => writeFile(file, contents, "utf8")),
    realPath: dependencies.realPath ?? (file => realpath(file)),
    listDirectory: dependencies.listDirectory ?? (directory => readdir(directory)),
    pathIsDirectory: dependencies.pathIsDirectory ?? (async file => {
      try { return (await stat(file)).isDirectory(); } catch { return false; }
    }),
    resolveNpmCliPath: dependencies.resolveNpmCliPath ?? defaultResolveNpmCliPath,
    onEvent: dependencies.onEvent ?? (() => undefined),
  };
}
