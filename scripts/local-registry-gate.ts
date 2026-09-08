/**
 * Source-safe release pre-gate.
 *
 * This module can publish only to the loopback Verdaccio instance that it
 * owns. A successful result is a handoff to the separate production release
 * step; production npm publication deliberately does not exist here.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { request, type Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { spawn } from "node:child_process";

import type { GeneratorGateContext } from "./zero-edit-generator-gate.ts";

/** Exact family membership; the release orchestrator owns publish order. */
export const WARLOCK_FAMILY_PACKAGE_NAMES = Object.freeze([
  "@warlock.js/ai",
  "@warlock.js/ai-panoptic",
  "@warlock.js/ai-anthropic",
  "@warlock.js/ai-bedrock",
  "@warlock.js/ai-google",
  "@warlock.js/ai-ollama",
  "@warlock.js/ai-openai",
  "@warlock.js/ai-live",
  "@warlock.js/ai-mistral",
  "@warlock.js/ai-groq",
  "@warlock.js/ai-deepseek",
  "@warlock.js/ai-xai",
  "@warlock.js/ai-tools",
  "@warlock.js/ai-workspace",
  "@warlock.js/auth",
  "@warlock.js/cache",
  "@warlock.js/cascade",
  "@warlock.js/context",
  "@warlock.js/core",
  "create-warlock",
  "@warlock.js/fs",
  "@warlock.js/herald",
  "@warlock.js/logger",
  "@warlock.js/scheduler",
  "@warlock.js/seal",
  "@warlock.js/notifications",
  "@warlock.js/web",
  "@warlock.js/access",
] as const);

export interface CandidateArtifact {
  /** Exact npm package name expected inside the tarball. */
  name: string;
  /** Absolute path to the immutable tarball produced by the build. */
  tarballPath: string;
  /** Lower- or upper-case hexadecimal SHA-256 of that exact tarball. */
  sha256: string;
}

/**
 * The three answers canon `e00fb7b8` permits to "does the generator matrix
 * run for this release?". All three may publish; what none of them may do is
 * go unstated.
 */
export type MatrixScope = "full" | "subset" | "none";

export interface LocalRegistryGateInput {
  candidateVersion: string;
  /** Exact family set in the caller-owned publish order. */
  expectedFamilyNames: readonly string[];
  artifacts: readonly CandidateArtifact[];
  /**
   * The three required generator-gate adapter paths, read from the
   * environment exactly once by the outermost entry point
   * (release-family.ts) and threaded through as plain context data from
   * here on. The keys are required (their VALUE may be `undefined`, which
   * the generator gate itself refuses) so that a caller which forgets to
   * wire one of them fails to compile instead of silently going missing.
   */
  featureCatalogAdapterPath: string | undefined;
  generatedOutputOraclePath: string | undefined;
  browserOracleAdapterPath: string | undefined;
  /**
   * How much of the zero-edit generator matrix this run executes.
   *
   * REQUIRED, with no default, and that is the point. Canon `e00fb7b8` made
   * the matrix opt-in: a release may ship without it. The safeguard that
   * replaced the mandatory gate is the RECORD -- every release states the
   * scope it ran, in the handoff, the release summary and
   * `docs/src/data/releases.json`. A default here would let an unstated scope
   * become a stated one by accident, which is exactly the silent degradation
   * the ruling was written to prevent.
   *
   * `"none"` skips the matrix and nothing else: the registry is still owned
   * and started, every tarball is still staged, and every member is still
   * confirmed installable from it. Skipping the matrix is not skipping the
   * gate.
   */
  matrixScope: MatrixScope;
  /**
   * The rows a `"subset"` run executes, threaded straight through to the
   * generator gate unexamined -- this module has no opinion on feature names.
   * Required for `"subset"`, refused for the other two: a row list on a
   * `"none"` run would describe rows nothing ran.
   */
  onlyFeatures?: readonly string[];
}

export interface PublishHandoff {
  kind: "warlock-family-publish-handoff";
  candidateVersion: string;
  artifacts: ReadonlyArray<{
    name: string;
    tarballPath: string;
    sha256: string;
  }>;
  verifiedAt: string;
  /**
   * What this candidate was verified BY, carried in the artifact that
   * authorises the publish rather than left to a human to remember.
   *
   * A degraded release must degrade loudly: a handoff whose scope is
   * `"none"` says so to everything downstream -- the publish step, the
   * release summary, and the public record in `releases.json` -- instead of
   * looking identical to one that ran all 30 rows.
   */
  matrixScope: MatrixScope;
  /** The rows that actually ran. Present only for `"subset"`. */
  matrixRows?: readonly string[];
}

export type GateEvent =
  | "registry-started"
  | "registry-ready"
  | "environment-asserted"
  | "artifact-verified"
  | "artifact-reverified"
  | "artifact-published-locally"
  | "artifact-confirmed-locally"
  | "generator-gate-started"
  | "generator-gate-passed"
  | "generator-gate-skipped"
  | "registry-stopped"
  | "registry-server-proved-closed"
  | "port-proved-dead"
  | "handoff-emitted";

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface CommandRequest {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface RegistryStartRequest {
  configPath: string;
  host: "127.0.0.1";
  cwd: string;
}

export interface OwnedRegistryServer {
  /** Exact server returned by Verdaccio's programmatic app.listen(0). */
  readonly server: HttpServer;
  /** Actual OS-assigned port read from server.address(). */
  readonly port: number;
}

export interface LocalRegistryGateDependencies {
  /** The mandatory, zero-edit scaffold/add/build/execute gate. */
  runZeroEditGeneratorGate(context: GeneratorGateContext): Promise<void>;
  /** Consumes the green result; it must not publish from this module. */
  emitHandoff?(handoff: PublishHandoff): Promise<void> | void;
  onEvent?(event: GateEvent, detail?: string): void;
  makeTemporaryDirectory?(prefix: string): Promise<string>;
  makeDirectory?(path: string): Promise<void>;
  writeTextFile?(path: string, contents: string): Promise<void>;
  removeDirectory?(path: string): Promise<void>;
  sha256File?(path: string): Promise<string>;
  startRegistry?(request: RegistryStartRequest): Promise<OwnedRegistryServer>;
  waitForRegistryReady?(registry: OwnedRegistryServer): Promise<void>;
  stopRegistry?(registry: OwnedRegistryServer): Promise<void>;
  proveRegistryClosed?(registry: OwnedRegistryServer): Promise<void>;
  provePortDead?(port: number): Promise<void>;
  resolveNpmCliPath?(): string;
  runCommand?(request: CommandRequest): Promise<CommandResult>;
  now?(): Date;
}

const LOOPBACK_HOST = "127.0.0.1" as const;
const EXACT_SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function assertCandidate(input: LocalRegistryGateInput): void {
  if (!EXACT_SEMVER.test(input.candidateVersion)) {
    throw new Error(`Candidate version must be an exact semver: ${input.candidateVersion}`);
  }

  if (
    input.expectedFamilyNames.length !== WARLOCK_FAMILY_PACKAGE_NAMES.length ||
    new Set(input.expectedFamilyNames).size !== WARLOCK_FAMILY_PACKAGE_NAMES.length ||
    WARLOCK_FAMILY_PACKAGE_NAMES.some(
      (name) => !input.expectedFamilyNames.includes(name),
    )
  ) {
    throw new Error(
      "expectedFamilyNames must contain exactly the 28-package Warlock family",
    );
  }

  if (input.artifacts.length !== WARLOCK_FAMILY_PACKAGE_NAMES.length) {
    throw new Error(
      `The local-registry gate requires exactly ${WARLOCK_FAMILY_PACKAGE_NAMES.length} tarball artifacts`,
    );
  }

  const names = new Set<string>();
  for (const [index, artifact] of input.artifacts.entries()) {
    if (!artifact.name || names.has(artifact.name)) {
      throw new Error(`Artifact names must be non-empty and unique: ${artifact.name}`);
    }
    names.add(artifact.name);

    if (artifact.name !== input.expectedFamilyNames[index]) {
      throw new Error(
        `Artifact ${index + 1} must be ${input.expectedFamilyNames[index]}, got ${artifact.name}`,
      );
    }

    if (!isAbsolute(artifact.tarballPath)) {
      throw new Error(`Artifact path must be absolute: ${artifact.tarballPath}`);
    }
    if (!/^[a-fA-F0-9]{64}$/.test(artifact.sha256)) {
      throw new Error(`Artifact ${artifact.name} must provide an exact SHA-256`);
    }
  }

  assertMatrixScopeAgreesWithRows(input.matrixScope, input.onlyFeatures);
}

/**
 * The scope and the row list must describe the same run.
 *
 * A `"subset"` with no rows would run the whole matrix while the handoff
 * claimed a subset; a `"full"` or `"none"` carrying rows would record rows
 * that either were not the selection or did not run at all. Either way the
 * handoff would misdescribe what was verified, which is the one thing it
 * exists to get right.
 */
export function assertMatrixScopeAgreesWithRows(
  scope: MatrixScope,
  rows: readonly string[] | undefined,
): void {
  // Checked here rather than trusted from the type, because the callers that
  // matter are a CLI and a JSON file on disk. An absent scope reaching the
  // handoff would only be caught at publish time — long after the 28 builds,
  // the registry and the gate have all been paid for.
  if (scope !== "full" && scope !== "subset" && scope !== "none") {
    throw new Error(
      `matrixScope must be stated as one of "full" | "subset" | "none"; got ${JSON.stringify(scope)}.`,
    );
  }

  if (scope === "subset") {
    if (!rows || rows.length === 0) {
      throw new Error(
        'matrixScope "subset" requires the rows it runs -- a subset with no selection is a full run wearing the wrong label.',
      );
    }
    return;
  }

  if (rows && rows.length > 0) {
    throw new Error(
      `matrixScope "${scope}" must not carry a row selection; got ${rows.join(", ")}.`,
    );
  }
}

function snapshotCandidate(input: LocalRegistryGateInput): Readonly<LocalRegistryGateInput> {
  assertCandidate(input);
  const expectedFamilyNames = Object.freeze([...input.expectedFamilyNames]);
  const artifacts = Object.freeze(
    input.artifacts.map((artifact) =>
      Object.freeze({
        name: artifact.name,
        tarballPath: artifact.tarballPath,
        sha256: artifact.sha256.toLowerCase(),
      }),
    ),
  );
  return Object.freeze({
    candidateVersion: input.candidateVersion,
    expectedFamilyNames,
    artifacts,
    featureCatalogAdapterPath: input.featureCatalogAdapterPath,
    generatedOutputOraclePath: input.generatedOutputOraclePath,
    browserOracleAdapterPath: input.browserOracleAdapterPath,
    matrixScope: input.matrixScope,
    onlyFeatures: input.onlyFeatures ? Object.freeze([...input.onlyFeatures]) : undefined,
  });
}

async function defaultSha256File(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

async function defaultStartRegistry(
  request: RegistryStartRequest,
): Promise<OwnedRegistryServer> {
  const require = createRequire(import.meta.url);
  const verdaccio = require("verdaccio") as {
    runServer?: (configPath: string) => Promise<{
      listen(port: number, host: string): HttpServer;
    }>;
  };
  if (typeof verdaccio.runServer !== "function") {
    throw new Error("Installed Verdaccio does not export its programmatic runServer API");
  }
  const app = await verdaccio.runServer(request.configPath);
  const server = app.listen(0, request.host);
  await new Promise<void>((resolve, reject) => {
    if (server.listening) resolve();
    else {
      server.once("listening", resolve);
      server.once("error", reject);
    }
  });
  const address = server.address();
  if (!address || typeof address === "string" || address.address !== request.host) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Verdaccio did not bind an owned IPv4 loopback listener");
  }
  return { server, port: address.port };
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: LOOPBACK_HOST, port });
    socket.setTimeout(200);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    const closed = () => {
      socket.destroy();
      resolve(false);
    };
    socket.once("error", closed);
    socket.once("timeout", closed);
  });
}

function verdaccioPing(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const ping = request(
      {
        host: LOOPBACK_HOST,
        port,
        path: "/-/ping",
        method: "GET",
        timeout: 300,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.once("end", () => {
          let pingPayload = false;
          try {
            const parsed = JSON.parse(body);
            pingPayload = typeof parsed === "object" && parsed !== null;
          } catch {
            pingPayload = false;
          }
          resolve(
            response.statusCode === 200 &&
              /application\/json/i.test(String(response.headers["content-type"] ?? "")) &&
              pingPayload,
          );
        });
      },
    );
    ping.once("timeout", () => {
      ping.destroy();
      resolve(false);
    });
    ping.once("error", () => resolve(false));
    ping.end();
  });
}

async function defaultWaitForRegistryReady(
  registry: OwnedRegistryServer,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const address = registry.server.address();
    if (
      !registry.server.listening ||
      !address ||
      typeof address === "string" ||
      address.port !== registry.port ||
      address.address !== LOOPBACK_HOST
    ) {
      throw new Error("Owned Verdaccio server stopped or changed address before readiness");
    }
    if ((await verdaccioPing(registry.port)) && registry.server.listening) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Owned Verdaccio did not answer its HTTP identity ping on ${LOOPBACK_HOST}:${registry.port}`,
  );
}

async function defaultStopRegistry(registry: OwnedRegistryServer): Promise<void> {
  if (!registry.server.listening) return;
  registry.server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) =>
    registry.server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function defaultProveRegistryClosed(registry: OwnedRegistryServer): Promise<void> {
  if (registry.server.listening || registry.server.address() !== null) {
    throw new Error(`Owned Verdaccio server on port ${registry.port} is still alive`);
  }
}

async function defaultProvePortDead(port: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!(await canConnect(port))) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Registry port ${LOOPBACK_HOST}:${port} is still live after shutdown`);
}

async function defaultRunCommand(request: CommandRequest): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(request.command, [...request.args], {
      cwd: request.cwd,
      env: request.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr?.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${request.command} exited ${code}: ${stderr || stdout}`));
    });
  });
}

function yamlPath(path: string): string {
  return `'${path.replace(/\\/g, "/").replace(/'/g, "''")}'`;
}

function registryConfig(storage: string, htpasswd: string): string {
  return [
    `storage: ${yamlPath(storage)}`,
    "auth:",
    "  htpasswd:",
    `    file: ${yamlPath(htpasswd)}`,
    "    max_users: -1",
    "uplinks:",
    "  npmjs:",
    "    url: https://registry.npmjs.org/",
    "packages:",
    // Candidate namespaces intentionally have no proxy: a missing local family
    // package must be red, never silently satisfied by the production registry.
    "  '@warlock.js/*':",
    "    access: $all",
    "    publish: $all",
    "    unpublish: $all",
    "  'create-warlock':",
    "    access: $all",
    "    publish: $all",
    "    unpublish: $all",
    "  '@*/*':",
    "    access: $all",
    "    proxy: npmjs",
    "  '**':",
    "    access: $all",
    "    proxy: npmjs",
    "middlewares:",
    "  audit:",
    "    enabled: false",
    "log: { type: stdout, format: pretty, level: warn }",
    "",
  ].join("\n");
}

function assertLoopbackRegistry(registryUrl: string, port: number): void {
  const parsed = new URL(registryUrl);
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== LOOPBACK_HOST ||
    Number(parsed.port) !== port
  ) {
    throw new Error(`Refusing npm publish to non-owned registry: ${registryUrl}`);
  }
}

function assertOwnedRegistryServer(registry: OwnedRegistryServer): void {
  const address = registry.server.address();
  if (
    !registry.server.listening ||
    !address ||
    typeof address === "string" ||
    address.address !== LOOPBACK_HOST ||
    address.port !== registry.port ||
    !Number.isInteger(registry.port) ||
    registry.port <= 0
  ) {
    throw new Error("startRegistry did not return its exact owned loopback server and actual port");
  }
}

function npmEnvironment(
  registryUrl: string,
  cacheDirectory: string,
  userConfigPath: string,
  globalConfigPath: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!isUnsafeInheritedNpmVariable(key)) env[key] = value;
  }
  Object.assign(env, {
    npm_config_registry: registryUrl,
    npm_config_cache: cacheDirectory,
    npm_config_userconfig: userConfigPath,
    npm_config_globalconfig: globalConfigPath,
    npm_config_audit: "false",
    npm_config_fund: "false",
  });

  for (const [key, expected] of Object.entries({
    npm_config_registry: registryUrl,
    npm_config_cache: cacheDirectory,
    npm_config_userconfig: userConfigPath,
    npm_config_globalconfig: globalConfigPath,
  })) {
    if (env[key] !== expected) throw new Error(`npm environment assertion failed: ${key}`);
  }
  const allowedUnsafeKeys = new Set([
    "npm_config_registry",
    "npm_config_cache",
    "npm_config_userconfig",
    "npm_config_globalconfig",
    "npm_config_audit",
    "npm_config_fund",
  ]);
  for (const key of Object.keys(env)) {
    if (isUnsafeInheritedNpmVariable(key) && !allowedUnsafeKeys.has(key)) {
      throw new Error(`Unsafe inherited npm environment survived sanitization: ${key}`);
    }
  }
  return env;
}

function isUnsafeInheritedNpmVariable(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    lower.startsWith("npm_config_") ||
    lower.startsWith("npm_package_") ||
    lower === "npm_execpath" ||
    lower === "npm_node_execpath" ||
    lower === "npmrc" ||
    lower === "node_auth_token" ||
    lower === "npm_token" ||
    lower === "http_proxy" ||
    lower === "https_proxy" ||
    lower === "all_proxy" ||
    lower === "no_proxy" ||
    (lower.includes("npm") && /(registry|auth|token|proxy|config)/.test(lower))
  );
}

export function defaultResolveNpmCliPath(): string {
  const candidates: string[] = [];
  if (process.env.npm_execpath?.endsWith("npm-cli.js")) {
    candidates.push(process.env.npm_execpath);
  }
  const require = createRequire(import.meta.url);
  try {
    candidates.push(require.resolve("npm/bin/npm-cli.js"));
  } catch {
    // npm may hide its bin through package exports.
  }
  try {
    candidates.push(join(dirname(require.resolve("npm/package.json")), "bin", "npm-cli.js"));
  } catch {
    // Try layouts relative to the running Node executable next.
  }
  candidates.push(
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  );

  const resolved = candidates.find(
    (candidate) => isAbsolute(candidate) && candidate.endsWith("npm-cli.js") && existsSync(candidate),
  );
  if (!resolved) {
    throw new Error(
      "npm's JavaScript CLI was not found; inject resolveNpmCliPath with an absolute npm-cli.js path",
    );
  }
  return resolved;
}

function assertNpmCommand(
  request: CommandRequest,
  npmCliPath: string,
  registryUrl: string,
  cacheDirectory: string,
  userConfigPath: string,
  globalConfigPath: string,
): void {
  if (request.command !== process.execPath || request.args[0] !== npmCliPath) {
    throw new Error("npm must run as process.execPath + the resolved npm-cli.js, never as npm.cmd");
  }
  for (const [option, expected] of [
    ["--registry", registryUrl],
    ["--cache", cacheDirectory],
    ["--userconfig", userConfigPath],
    ["--globalconfig", globalConfigPath],
  ] as const) {
    const index = request.args.indexOf(option);
    if (index < 0 || request.args[index + 1] !== expected) {
      throw new Error(`npm command is missing exact ${option} ${expected}`);
    }
  }
  if (
    request.env.npm_config_registry !== registryUrl ||
    request.env.npm_config_cache !== cacheDirectory ||
    request.env.npm_config_userconfig !== userConfigPath ||
    request.env.npm_config_globalconfig !== globalConfigPath
  ) {
    throw new Error("npm command environment does not match its isolated explicit options");
  }
  for (const key of Object.keys(request.env)) {
    const allowed = new Set([
      "npm_config_registry",
      "npm_config_cache",
      "npm_config_userconfig",
      "npm_config_globalconfig",
      "npm_config_audit",
      "npm_config_fund",
    ]);
    if (isUnsafeInheritedNpmVariable(key) && !allowed.has(key)) {
      throw new Error(`Unsafe npm environment on command: ${key}`);
    }
  }
}

/**
 * Publishes the candidate tarballs to an ephemeral local registry and runs the
 * injected zero-edit generator gate. It returns/emits a production handoff
 * only after the candidate, cleanup, and dead-port proof are all green.
 */
export async function runLocalRegistryPreGate(
  input: LocalRegistryGateInput,
  dependencies: LocalRegistryGateDependencies,
): Promise<PublishHandoff> {
  // Snapshot synchronously, before any caller-controlled async seam can mutate
  // the candidate object that the gate is actually proving.
  const candidate = snapshotCandidate(input);

  const makeTemporaryDirectory =
    dependencies.makeTemporaryDirectory ?? ((prefix) => mkdtemp(join(tmpdir(), prefix)));
  const makeDirectory =
    dependencies.makeDirectory ?? ((path) => mkdir(path, { recursive: true }).then(() => undefined));
  const writeTextFile =
    dependencies.writeTextFile ?? ((path, contents) => writeFile(path, contents, "utf8"));
  const removeDirectory =
    dependencies.removeDirectory ?? ((path) => rm(path, { recursive: true, force: true }));
  const sha256File = dependencies.sha256File ?? defaultSha256File;
  const startRegistry = dependencies.startRegistry ?? defaultStartRegistry;
  const waitForRegistryReady =
    dependencies.waitForRegistryReady ?? defaultWaitForRegistryReady;
  const stopRegistry = dependencies.stopRegistry ?? defaultStopRegistry;
  const proveRegistryClosed =
    dependencies.proveRegistryClosed ?? defaultProveRegistryClosed;
  const provePortDead = dependencies.provePortDead ?? defaultProvePortDead;
  const runCommand = dependencies.runCommand ?? defaultRunCommand;
  const resolveNpmCliPath = dependencies.resolveNpmCliPath ?? defaultResolveNpmCliPath;
  const event = (name: GateEvent, detail?: string) => dependencies.onEvent?.(name, detail);

  const workspaceDirectory = await makeTemporaryDirectory("warlock-local-registry-gate-");
  const storageDirectory = join(workspaceDirectory, "storage");
  const cacheDirectory = join(workspaceDirectory, "npm-cache");
  const configPath = join(workspaceDirectory, "verdaccio.yaml");
  const htpasswdPath = join(workspaceDirectory, "htpasswd");
  const npmrcPath = join(workspaceDirectory, ".npmrc");
  const globalNpmrcPath = join(workspaceDirectory, "global-npmrc");
  let registry: OwnedRegistryServer | undefined;
  let gatePassed = false;
  let gateFailure: unknown;
  const cleanupFailures: unknown[] = [];

  try {
    await makeDirectory(storageDirectory);
    await makeDirectory(cacheDirectory);
    await writeTextFile(configPath, registryConfig(storageDirectory, htpasswdPath));
    registry = await startRegistry({
      configPath,
      host: LOOPBACK_HOST,
      cwd: workspaceDirectory,
    });
    assertOwnedRegistryServer(registry);
    const registryUrl = `http://${LOOPBACK_HOST}:${registry.port}/`;
    assertLoopbackRegistry(registryUrl, registry.port);
    event("registry-started", String(registry.port));

    // npm refuses `publish` with ENEEDAUTH unless a token exists for the target
    // registry HOST, regardless of what the registry itself allows — this
    // Verdaccio grants `publish: $all`, and npm still would not send the
    // request. The token is a placeholder: the owned registry is loopback-only,
    // its lifetime is this gate, and its htpasswd file is empty, so nothing
    // authenticates against anything. Its only job is to satisfy the client.
    //
    // The key must be the registry's host and port with no scheme, which is
    // why it is derived from `registryUrl` rather than written by hand — the
    // port is assigned by the OS at start-up and differs every run.
    const registryAuthKey = registryUrl.replace(/^https?:/, "");
    await writeTextFile(
      npmrcPath,
      `registry=${registryUrl}\ncache=${cacheDirectory}\nalways-auth=false\n` +
        `${registryAuthKey}:_authToken=local-registry-gate\n`,
    );
    await writeTextFile(globalNpmrcPath, "");
    const npmCliPath = resolveNpmCliPath();
    if (!isAbsolute(npmCliPath) || !npmCliPath.endsWith("npm-cli.js")) {
      throw new Error("resolveNpmCliPath must return an absolute npm-cli.js path");
    }
    const env = npmEnvironment(
      registryUrl,
      cacheDirectory,
      npmrcPath,
      globalNpmrcPath,
    );
    event("environment-asserted");

    const runNpm = async (args: readonly string[]): Promise<CommandResult> => {
      const request: CommandRequest = {
        command: process.execPath,
        args: [npmCliPath, ...args],
        cwd: workspaceDirectory,
        env: { ...env },
      };
      assertNpmCommand(
        request,
        npmCliPath,
        registryUrl,
        cacheDirectory,
        npmrcPath,
        globalNpmrcPath,
      );
      return await runCommand(request);
    };

    await waitForRegistryReady(registry);
    event("registry-ready");

    for (const artifact of candidate.artifacts) {
      const actualHash = (await sha256File(artifact.tarballPath)).toLowerCase();
      if (actualHash !== artifact.sha256.toLowerCase()) {
        throw new Error(
          `SHA-256 mismatch for ${artifact.name}: expected ${artifact.sha256}, got ${actualHash}`,
        );
      }
      event("artifact-verified", artifact.name);

      await runNpm([
          "publish",
          artifact.tarballPath,
          "--registry",
          registryUrl,
          "--cache",
          cacheDirectory,
          "--userconfig",
          npmrcPath,
          "--globalconfig",
          globalNpmrcPath,
          "--ignore-scripts",
        ]);
      event("artifact-published-locally", artifact.name);

      const observed = await runNpm([
          "view",
          `${artifact.name}@${candidate.candidateVersion}`,
          "version",
          "--json",
          "--registry",
          registryUrl,
          "--cache",
          cacheDirectory,
          "--userconfig",
          npmrcPath,
          "--globalconfig",
          globalNpmrcPath,
          "--prefer-online",
        ]);
      let observedVersion: unknown;
      try {
        observedVersion = JSON.parse(observed.stdout.trim());
      } catch {
        observedVersion = observed.stdout.trim();
      }
      if (observedVersion !== candidate.candidateVersion) {
        throw new Error(
          `Local registry did not confirm ${artifact.name}@${candidate.candidateVersion}; observed ${String(observedVersion)}`,
        );
      }
      event("artifact-confirmed-locally", artifact.name);
    }

    if (candidate.matrixScope === "none") {
      // Everything above this line still ran: the registry was owned and
      // started, all 28 tarballs staged, and every member confirmed
      // installable from it. What is skipped is the matrix, and the handoff
      // says so -- it does not quietly resemble a run that executed it.
      event("generator-gate-skipped");
    } else {
      event("generator-gate-started");
      await dependencies.runZeroEditGeneratorGate({
        candidateVersion: candidate.candidateVersion,
        artifacts: candidate.artifacts,
        registryUrl,
        npmEnvironment: Object.freeze({ ...env }),
        workspaceDirectory,
        featureCatalogAdapterPath: candidate.featureCatalogAdapterPath,
        generatedOutputOraclePath: candidate.generatedOutputOraclePath,
        browserOracleAdapterPath: candidate.browserOracleAdapterPath,
        onlyFeatures: candidate.onlyFeatures,
      });
      event("generator-gate-passed");
    }
    gatePassed = true;
  } catch (error) {
    gateFailure = error;
  } finally {
    if (registry) {
      try {
        await stopRegistry(registry);
        event("registry-stopped");
      } catch (error) {
        cleanupFailures.push(error);
      }
      try {
        await proveRegistryClosed(registry);
        event("registry-server-proved-closed");
      } catch (error) {
        cleanupFailures.push(error);
      }
      try {
        await provePortDead(registry.port);
        event("port-proved-dead", String(registry.port));
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    try {
      await removeDirectory(workspaceDirectory);
    } catch (error) {
      cleanupFailures.push(error);
    }
  }

  if (gateFailure || cleanupFailures.length > 0) {
    const failures = [...(gateFailure ? [gateFailure] : []), ...cleanupFailures];
    throw failures.length === 1
      ? failures[0]
      : new AggregateError(failures, "Local-registry gate and/or cleanup failed");
  }
  if (!gatePassed) throw new Error("Local-registry gate ended without a handoff");

  // This is deliberately after generator execution and all registry cleanup:
  // the bytes handed to production must still be the bytes rehearsed locally.
  for (const artifact of candidate.artifacts) {
    const finalHash = (await sha256File(artifact.tarballPath)).toLowerCase();
    if (finalHash !== artifact.sha256) {
      throw new Error(
        `Tarball changed after local rehearsal for ${artifact.name}: expected ${artifact.sha256}, got ${finalHash}`,
      );
    }
    event("artifact-reverified", artifact.name);
  }

  const handoff = Object.freeze({
    kind: "warlock-family-publish-handoff" as const,
    candidateVersion: candidate.candidateVersion,
    artifacts: Object.freeze(
      candidate.artifacts.map((artifact) =>
        Object.freeze({
          name: artifact.name,
          tarballPath: artifact.tarballPath,
          sha256: artifact.sha256,
        }),
      ),
    ),
    verifiedAt: (dependencies.now?.() ?? new Date()).toISOString(),
    matrixScope: candidate.matrixScope,
    ...(candidate.onlyFeatures
      ? { matrixRows: Object.freeze([...candidate.onlyFeatures]) }
      : {}),
  });

  await dependencies.emitHandoff?.(handoff);
  event("handoff-emitted");
  return handoff;
}
