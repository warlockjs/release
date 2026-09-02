import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { assertArtifactContainsItsEntryPoints } from "./artifact-entry-points.mjs";

import {
  runLocalRegistryPreGate,
  type CandidateArtifact,
  type GeneratorGateContext,
  type LocalRegistryGateDependencies,
  type LocalRegistryGateInput,
  type PublishHandoff,
} from "./local-registry-gate.ts";
import {
  loadAuthoritativeWarlockFamily,
  type WarlockFamily,
} from "./warlock-family.ts";
import { runZeroEditGeneratorGate } from "./zero-edit-generator-gate.ts";

export const NPM_ORIGIN = "https://registry.npmjs.org";
export const EXACT_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const BUILDER_ROOT = path.resolve(import.meta.dirname, "..");
const WORKSPACE_ROOT = path.resolve(BUILDER_ROOT, "..");
const BUILD_ROOT = path.join(BUILDER_ROOT, "builds");
const ARTIFACT_ROOT = path.join(BUILDER_ROOT, "release-artifacts");
const HANDOFF_ROOT = path.join(BUILDER_ROOT, "release-handoffs");
const CONFIG_PATH = path.join(BUILDER_ROOT, "pkgist.config.ts");
const DEPENDENCY_FIELDS = [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

export type ReleaseMode = "gate" | "publish" | "confirm";

export interface ReleaseOptions {
  mode: ReleaseMode;
  version: string;
  handoffPath?: string;
}

export interface ReleaseHandoff extends PublishHandoff {
  subjects: readonly string[];
}

export interface CommandRequest {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface ReleaseFamilyDependencies {
  loadFamily?(): Promise<WarlockFamily>;
  runCommand?(request: CommandRequest): Promise<CommandResult>;
  readTextFile?(filePath: string): Promise<string>;
  writeTextFile?(filePath: string, contents: string): Promise<void>;
  inspectArtifact?(tarballPath: string): Promise<ArtifactInspection>;
  makeDirectory?(directory: string): Promise<void>;
  makeTemporaryDirectory?(prefix: string): Promise<string>;
  removeDirectory?(directory: string): Promise<void>;
  removeFile?(filePath: string): Promise<void>;
  writeHandoff?(filePath: string, handoff: ReleaseHandoff): Promise<void>;
  sha256File?(filePath: string): Promise<string>;
  resolvePkgistCli?(): string;
  resolveNpmCli?(): string;
  runLocalGate?(
    input: LocalRegistryGateInput,
    dependencies: LocalRegistryGateDependencies,
  ): Promise<PublishHandoff>;
  now?(): Date;
}

export type BuiltManifest = Record<string, unknown> & {
  name?: unknown;
  version?: unknown;
};

export interface ArtifactInspection {
  manifest: BuiltManifest;
  /** POSIX paths as stored in the tarball, including the `package/` prefix. */
  entries: readonly string[];
}

type Runtime = Required<ReleaseFamilyDependencies>;

/**
 * The only public entry into the release state machine. Production publication
 * is reachable solely through the explicit `publish` mode.
 */
export async function runReleaseFamily(
  options: ReleaseOptions,
  dependencies: ReleaseFamilyDependencies = {},
): Promise<ReleaseHandoff | void> {
  assertExactVersion(options.version);
  const runtime = withDefaults(dependencies);
  const family = await runtime.loadFamily();
  if (family.version !== options.version) {
    throw new Error(
      `Requested release version ${options.version} does not equal the reconciled family version ${family.version}.`,
    );
  }
  const handoffPath = path.resolve(
    options.handoffPath ?? path.join(HANDOFF_ROOT, `warlock-${options.version}.json`),
  );

  if (options.mode === "gate") {
    return await prepareAndGate(family, options.version, handoffPath, runtime);
  }

  const handoff = parseAndValidateHandoff(
    await runtime.readTextFile(handoffPath),
    family,
    options.version,
  );
  await verifyAllArtifactHashes(handoff.artifacts, runtime.sha256File);

  if (options.mode === "publish") {
    await publishHandoff(handoff, runtime);
    return;
  }

  await confirmAtOrigin(handoff, runtime);
}

async function prepareAndGate(
  family: WarlockFamily,
  version: string,
  handoffPath: string,
  runtime: Runtime,
): Promise<ReleaseHandoff> {
  // A failed retry must not leave an older same-version handoff looking green.
  await runtime.removeFile(handoffPath);

  const artifactDirectory = path.join(ARTIFACT_ROOT, version);
  await runtime.makeDirectory(artifactDirectory);
  const artifacts: CandidateArtifact[] = [];

  for (const member of family.members) {
    await runtime.runCommand({
      command: process.execPath,
      args: [
        runtime.resolvePkgistCli(),
        "build",
        member.name,
        "--bump",
        version,
        "--no-publish",
        "--no-git",
        "--config",
        CONFIG_PATH,
      ],
      cwd: BUILDER_ROOT,
      env: { ...process.env },
    });

    const buildDirectory = path.join(BUILD_ROOT, ...member.name.split("/"), version);
    const packed = await runtime.runCommand({
      command: process.execPath,
      args: [
        runtime.resolveNpmCli(),
        "pack",
        buildDirectory,
        "--json",
        "--pack-destination",
        artifactDirectory,
        "--ignore-scripts",
      ],
      cwd: BUILDER_ROOT,
      env: { ...process.env },
    });
    const tarballPath = parsePackedTarball(packed.stdout, artifactDirectory, member.name);
    const inspection = await runtime.inspectArtifact(tarballPath);
    assertBuiltManifest(inspection.manifest, member.name, version);
    assertArtifactContainsItsEntryPoints(inspection.manifest, inspection.entries, member.name);
    artifacts.push({
      name: member.name,
      tarballPath,
      sha256: await runtime.sha256File(tarballPath),
    });
  }

  const gated = await runtime.runLocalGate(
    {
      candidateVersion: version,
      expectedFamilyNames: family.members.map(member => member.name),
      artifacts,
    },
    {
      runZeroEditGeneratorGate: (context: GeneratorGateContext) =>
        runZeroEditGeneratorGate(context),
      now: runtime.now,
    },
  );
  const handoff: ReleaseHandoff = {
    ...gated,
    artifacts: gated.artifacts.map(artifact => ({ ...artifact })),
    subjects: family.members.map(member => member.name),
  };
  assertHandoffMatchesArtifacts(handoff, artifacts, version);
  await runtime.writeHandoff(handoffPath, handoff);
  return handoff;
}

/** Parse and enforce the only package metadata that can cross the gate. */
export function assertBuiltManifest(
  manifest: BuiltManifest,
  expectedName: string,
  expectedVersion: string,
): void {
  if (manifest.name !== expectedName) {
    throw new Error(
      `Built manifest name mismatch: expected ${expectedName}, found ${String(manifest.name)}.`,
    );
  }
  if (manifest.version !== expectedVersion) {
    throw new Error(
      `Built manifest version mismatch for ${expectedName}: expected ${expectedVersion}, ` +
        `found ${String(manifest.version)}.`,
    );
  }

  for (const field of DEPENDENCY_FIELDS) {
    const value = manifest[field];
    if (value === undefined) continue;
    if (!isStringRecord(value)) {
      throw new Error(`${expectedName} ${field} must be an object.`);
    }
    for (const [name, specification] of Object.entries(value)) {
      if (specification.startsWith("workspace:")) {
        throw new Error(`${expectedName} ${field}.${name} retained ${specification}.`);
      }
      if (name.startsWith("@warlock.js/") && specification !== expectedVersion) {
        throw new Error(
          `${expectedName} ${field}.${name} must equal ${expectedVersion}; found ${specification}.`,
        );
      }
    }
  }
}

async function publishHandoff(handoff: ReleaseHandoff, runtime: Runtime): Promise<void> {
  const root = await runtime.makeTemporaryDirectory("warlock-origin-publish-");
  const cache = path.join(root, "npm-cache");
  const userconfig = path.join(root, "user.npmrc");
  const globalconfig = path.join(root, "global.npmrc");
  await runtime.makeDirectory(cache);
  const tokenLine = process.env.NPM_TOKEN
    ? `//registry.npmjs.org/:_authToken=${process.env.NPM_TOKEN}\n`
    : "";
  await runtime.writeTextFile(userconfig, `registry=${NPM_ORIGIN}\nalways-auth=true\n${tokenLine}`);
  await runtime.writeTextFile(globalconfig, "");
  const env = originEnvironment(process.env, cache, userconfig, globalconfig);

  try {
    const effective = await runtime.runCommand({
      command: process.execPath,
      args: [runtime.resolveNpmCli(), "config", "get", "registry"],
      cwd: root,
      env,
    });
    assertEffectiveOrigin(effective.stdout, env, cache, userconfig, globalconfig);

    for (const artifact of handoff.artifacts) {
      await assertArtifactHash(artifact, runtime.sha256File);
      await runtime.runCommand({
        command: process.execPath,
        args: [runtime.resolveNpmCli(), "publish", artifact.tarballPath, "--registry", NPM_ORIGIN, "--access", "public", "--ignore-scripts", "--cache", cache, "--userconfig", userconfig, "--globalconfig", globalconfig],
        cwd: root,
        env,
      });
    }
  } finally {
    await runtime.removeDirectory(root);
  }
}

async function confirmAtOrigin(handoff: ReleaseHandoff, runtime: Runtime): Promise<void> {
  const root = await runtime.makeTemporaryDirectory("warlock-origin-confirm-");
  const cache = path.join(root, "npm-cache");
  const npmrc = path.join(root, ".npmrc");
  const globalNpmrc = path.join(root, "global.npmrc");
  const consumer = path.join(root, "consumer");
  const scaffoldParent = path.join(root, "scaffold");
  await runtime.makeDirectory(cache);
  await runtime.makeDirectory(consumer);
  await runtime.makeDirectory(scaffoldParent);
  await runtime.writeTextFile(npmrc, `registry=${NPM_ORIGIN}\ncache=${cache}\nalways-auth=false\n`);
  await runtime.writeTextFile(globalNpmrc, "");
  const env = originEnvironment(process.env, cache, npmrc, globalNpmrc);

  try {
    for (const name of handoff.subjects) {
      const result = await runtime.runCommand({
        command: process.execPath,
        args: [
          runtime.resolveNpmCli(),
          "view",
          `${name}@${handoff.candidateVersion}`,
          "version",
          "--json",
          "--registry",
          NPM_ORIGIN,
          "--prefer-online",
          "--cache",
          cache,
          "--userconfig",
          npmrc,
          "--globalconfig",
          globalNpmrc,
        ],
        cwd: root,
        env,
      });
      const observed = parseJsonOrText(result.stdout);
      if (observed !== handoff.candidateVersion) {
        throw new Error(
          `npm origin did not confirm ${name}@${handoff.candidateVersion}; observed ${String(observed)}.`,
        );
      }
    }

    await runtime.writeTextFile(
      path.join(consumer, "package.json"),
      `${JSON.stringify({ name: "warlock-origin-confirm", private: true, type: "module" }, null, 2)}\n`,
    );
    await runtime.runCommand({
      command: process.execPath,
      args: [
        runtime.resolveNpmCli(),
        "install",
        `@warlock.js/core@${handoff.candidateVersion}`,
        `@warlock.js/notifications@${handoff.candidateVersion}`,
        "--save-exact",
        "--strict-peer-deps",
        "--registry",
        NPM_ORIGIN,
        "--prefer-online",
        "--cache",
        cache,
        "--userconfig",
        npmrc,
        "--globalconfig",
        globalNpmrc,
      ],
      cwd: consumer,
      env,
    });
    await npmLsAndExecute(consumer, cache, npmrc, globalNpmrc, env, runtime, true);

    await runtime.runCommand({
      command: process.execPath,
      args: [
        runtime.resolveNpmCli(),
        "create",
        `warlock@${handoff.candidateVersion}`,
        "--registry",
        NPM_ORIGIN,
        "--prefer-online",
        "--cache",
        cache,
        "--userconfig",
        npmrc,
        "--globalconfig",
        globalNpmrc,
        "--",
        "origin-app",
        "--yes",
        "--no-db",
        "--no-git",
        "--no-jwt",
        "--pm=npm",
      ],
      cwd: scaffoldParent,
      env,
    });
    const scaffold = path.join(scaffoldParent, "origin-app");
    assertGeneratedPins(
      parseManifest(await runtime.readTextFile(path.join(scaffold, "package.json")), "origin-app"),
      handoff.candidateVersion,
    );
    await npmLsAndExecute(scaffold, cache, npmrc, globalNpmrc, env, runtime, false);
  } finally {
    await runtime.removeDirectory(root);
  }
}

function assertGeneratedPins(manifest: BuiltManifest, version: string): void {
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

async function npmLsAndExecute(
  cwd: string,
  cache: string,
  npmrc: string,
  globalNpmrc: string,
  env: NodeJS.ProcessEnv,
  runtime: Runtime,
  importNotifications: boolean,
): Promise<void> {
  await runtime.runCommand({
    command: process.execPath,
    args: [runtime.resolveNpmCli(), "ls", "--all", "--registry", NPM_ORIGIN, "--cache", cache, "--userconfig", npmrc, "--globalconfig", globalNpmrc],
    cwd,
    env,
  });
  const physical = await runtime.runCommand({
    command: process.execPath,
    args: [runtime.resolveNpmCli(), "ls", "@warlock.js/core", "--all", "--parseable", "--registry", NPM_ORIGIN, "--cache", cache, "--userconfig", npmrc, "--globalconfig", globalNpmrc],
    cwd,
    env,
  });
  const corePaths = physical.stdout
    .split(/\r?\n/)
    .map(value => value.trim())
    .filter(value => /[\\/]node_modules[\\/]@warlock\.js[\\/]core$/i.test(value));
  assertSinglePhysicalCore(corePaths);
  await runtime.runCommand({
    command: process.execPath,
    args: [
      "--input-type=module",
      "--eval",
      importNotifications
        ? "await import('@warlock.js/core'); await import('@warlock.js/notifications')"
        : "await import('@warlock.js/core')",
    ],
    cwd,
    env,
  });
}

export function assertSinglePhysicalCore(corePaths: readonly string[]): void {
  const unique = new Set(corePaths.map(value => path.resolve(value).toLowerCase()));
  if (corePaths.length !== 1 || unique.size !== 1) {
    throw new Error(`Expected exactly one physical @warlock.js/core install; found ${corePaths.length}.`);
  }
}

function parseAndValidateHandoff(
  source: string,
  family: WarlockFamily,
  version: string,
): ReleaseHandoff {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`Cannot parse publish handoff: ${formatError(error)}.`);
  }
  if (!value || typeof value !== "object") throw new Error("Publish handoff must be an object.");
  const record = value as Record<string, unknown>;
  if (record.kind !== "warlock-family-publish-handoff") {
    throw new Error(`Unexpected publish handoff kind: ${String(record.kind)}.`);
  }
  if (record.candidateVersion !== version) {
    throw new Error(
      `Publish handoff version mismatch: expected ${version}, found ${String(record.candidateVersion)}.`,
    );
  }
  if (!Array.isArray(record.subjects) || !record.subjects.every(item => typeof item === "string")) {
    throw new Error("Publish handoff subjects must be a string array.");
  }
  if (!Array.isArray(record.artifacts)) throw new Error("Publish handoff artifacts must be an array.");
  const artifacts = record.artifacts.map(parseHandoffArtifact);
  const handoff = {
    kind: record.kind,
    candidateVersion: version,
    subjects: record.subjects,
    artifacts,
    verifiedAt: String(record.verifiedAt ?? ""),
  } satisfies ReleaseHandoff;
  const expected = family.members.map(member => member.name);
  if (!equalStrings(handoff.subjects, expected)) {
    throw new Error("Publish handoff subject list is missing, added, or out of order.");
  }
  if (!equalStrings(handoff.artifacts.map(artifact => artifact.name), expected)) {
    throw new Error("Publish handoff artifact list is missing, added, or out of order.");
  }
  return handoff;
}

function parseHandoffArtifact(value: unknown): CandidateArtifact {
  if (!value || typeof value !== "object") throw new Error("Invalid artifact in publish handoff.");
  const record = value as Record<string, unknown>;
  if (
    typeof record.name !== "string" ||
    typeof record.tarballPath !== "string" ||
    !path.isAbsolute(record.tarballPath) ||
    typeof record.sha256 !== "string" ||
    !/^[a-fA-F0-9]{64}$/.test(record.sha256)
  ) {
    throw new Error(`Invalid artifact in publish handoff for ${String(record.name)}.`);
  }
  return { name: record.name, tarballPath: record.tarballPath, sha256: record.sha256.toLowerCase() };
}

async function verifyAllArtifactHashes(
  artifacts: readonly CandidateArtifact[],
  sha256File: (filePath: string) => Promise<string>,
): Promise<void> {
  // Complete this pass before the first irreversible production publish.
  for (const artifact of artifacts) await assertArtifactHash(artifact, sha256File);
}

async function assertArtifactHash(
  artifact: CandidateArtifact,
  sha256File: (filePath: string) => Promise<string>,
): Promise<void> {
  const actual = (await sha256File(artifact.tarballPath)).toLowerCase();
  if (actual !== artifact.sha256.toLowerCase()) {
    throw new Error(
      `SHA-256 mismatch for ${artifact.name}: expected ${artifact.sha256}, got ${actual}.`,
    );
  }
}

function assertHandoffMatchesArtifacts(
  handoff: ReleaseHandoff,
  artifacts: readonly CandidateArtifact[],
  version: string,
): void {
  if (handoff.candidateVersion !== version) throw new Error("Local gate changed candidate version.");
  if (!equalStrings(handoff.artifacts.map(item => item.name), artifacts.map(item => item.name))) {
    throw new Error("Local gate changed the ordered artifact subject list.");
  }
  for (const [index, artifact] of artifacts.entries()) {
    const returned = handoff.artifacts[index];
    if (
      returned.tarballPath !== artifact.tarballPath ||
      returned.sha256.toLowerCase() !== artifact.sha256.toLowerCase()
    ) {
      throw new Error(`Local gate changed artifact identity for ${artifact.name}.`);
    }
  }
}

function parseManifest(source: string, label: string): BuiltManifest {
  try {
    const parsed = JSON.parse(source);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as BuiltManifest;
  } catch (error) {
    throw new Error(`Cannot parse manifest for ${label}: ${formatError(error)}.`);
  }
}

function parsePackedTarball(stdout: string, directory: string, name: string): string {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch (error) {
    throw new Error(`npm pack returned non-JSON output for ${name}: ${formatError(error)}.`);
  }
  const filename = Array.isArray(value)
    ? (value[0] as { filename?: unknown } | undefined)?.filename
    : undefined;
  if (typeof filename !== "string" || path.basename(filename) !== filename) {
    throw new Error(`npm pack did not return one safe tarball filename for ${name}.`);
  }
  return path.resolve(directory, filename);
}

function withDefaults(dependencies: ReleaseFamilyDependencies): Runtime {
  return {
    loadFamily: dependencies.loadFamily ?? (() => loadAuthoritativeWarlockFamily(WORKSPACE_ROOT)),
    runCommand: dependencies.runCommand ?? defaultRunCommand,
    readTextFile: dependencies.readTextFile ?? (filePath => readFile(filePath, "utf8")),
    writeTextFile:
      dependencies.writeTextFile ?? ((filePath, contents) => writeFile(filePath, contents, "utf8")),
    inspectArtifact: dependencies.inspectArtifact ?? inspectArtifact,
    makeDirectory:
      dependencies.makeDirectory ?? (directory => mkdir(directory, { recursive: true }).then(() => undefined)),
    makeTemporaryDirectory:
      dependencies.makeTemporaryDirectory ?? (prefix => mkdtemp(path.join(tmpdir(), prefix))),
    removeDirectory:
      dependencies.removeDirectory ?? (directory => rm(directory, { recursive: true, force: true })),
    removeFile: dependencies.removeFile ?? removeFileIfPresent,
    writeHandoff: dependencies.writeHandoff ?? writeHandoffAtomically,
    sha256File: dependencies.sha256File ?? defaultSha256File,
    resolvePkgistCli: dependencies.resolvePkgistCli ?? resolvePkgistCli,
    resolveNpmCli: dependencies.resolveNpmCli ?? resolveNpmCli,
    runLocalGate: dependencies.runLocalGate ?? runLocalRegistryPreGate,
    now: dependencies.now ?? (() => new Date()),
  };
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
    child.stdout.setEncoding("utf8").on("data", chunk => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", chunk => (stderr += chunk));
    child.once("error", reject);
    child.once("close", code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${request.command} exited ${String(code)}: ${stderr || stdout}`));
    });
  });
}

async function defaultSha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function inspectArtifact(tarballPath: string): Promise<ArtifactInspection> {
  const archive = gunzipSync(await readFile(tarballPath));
  const entries: string[] = [];
  let manifest: BuiltManifest | undefined;
  for (let offset = 0; offset + 512 <= archive.length; ) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const name = tarText(header.subarray(0, 100));
    const prefix = tarText(header.subarray(345, 500));
    const entryPath = prefix ? `${prefix}/${name}` : name;
    entries.push(normalizeTarEntry(entryPath));
    const sizeText = tarText(header.subarray(124, 136)).trim();
    const size = Number.parseInt(sizeText || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`Invalid tar entry size in ${tarballPath}.`);
    }
    const bodyStart = offset + 512;
    if (entryPath === "package/package.json") {
      manifest = parseManifest(
        archive.subarray(bodyStart, bodyStart + size).toString("utf8"),
        tarballPath,
      );
    }
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  if (!manifest) throw new Error(`Packed artifact has no package/package.json: ${tarballPath}.`);
  return { manifest, entries };
}

function normalizeTarEntry(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function tarText(value: Uint8Array): string {
  const nul = value.indexOf(0);
  return Buffer.from(nul === -1 ? value : value.subarray(0, nul)).toString("utf8");
}

async function writeHandoffAtomically(filePath: string, handoff: ReleaseHandoff): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(handoff, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporaryPath, filePath);
}

async function removeFileIfPresent(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function resolvePkgistCli(): string {
  const require = createRequire(import.meta.url);
  const entry = require.resolve("@mongez/pkgist");
  return path.join(path.dirname(entry), "cli.js");
}

function resolveNpmCli(): string {
  const invokedByNpm = process.env.npm_execpath;
  if (invokedByNpm && path.isAbsolute(invokedByNpm) && /npm-cli\.js$/i.test(invokedByNpm)) {
    return invokedByNpm;
  }
  const adjacent = path.resolve(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
  return adjacent;
}

function originEnvironment(
  source: NodeJS.ProcessEnv,
  cache?: string,
  userconfig?: string,
  globalconfig?: string,
): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (/^npm_config_/i.test(key)) delete env[key];
  }
  env.npm_config_registry = NPM_ORIGIN;
  env.NPM_CONFIG_REGISTRY = NPM_ORIGIN;
  if (cache) env.npm_config_cache = env.NPM_CONFIG_CACHE = cache;
  if (userconfig) env.npm_config_userconfig = env.NPM_CONFIG_USERCONFIG = userconfig;
  if (globalconfig) env.npm_config_globalconfig = env.NPM_CONFIG_GLOBALCONFIG = globalconfig;
  env.npm_config_audit = env.NPM_CONFIG_AUDIT = "false";
  env.npm_config_fund = env.NPM_CONFIG_FUND = "false";
  env.npm_config_update_notifier = env.NPM_CONFIG_UPDATE_NOTIFIER = "false";
  return env;
}

function assertEffectiveOrigin(
  stdout: string,
  env: NodeJS.ProcessEnv,
  cache: string,
  userconfig: string,
  globalconfig: string,
): void {
  if (stdout.trim().replace(/\/$/, "") !== NPM_ORIGIN) {
    throw new Error(`Refusing production publish: effective npm registry is ${stdout.trim()}.`);
  }
  for (const [key, expected] of Object.entries({
    npm_config_registry: NPM_ORIGIN,
    NPM_CONFIG_REGISTRY: NPM_ORIGIN,
    npm_config_cache: cache,
    NPM_CONFIG_CACHE: cache,
    npm_config_userconfig: userconfig,
    NPM_CONFIG_USERCONFIG: userconfig,
    npm_config_globalconfig: globalconfig,
    NPM_CONFIG_GLOBALCONFIG: globalconfig,
  })) {
    if (env[key] !== expected) {
      throw new Error(`Refusing production publish: npm environment mismatch for ${key}.`);
    }
  }
}

function assertExactVersion(version: string): void {
  if (!EXACT_VERSION.test(version)) {
    throw new Error(`--version is required and must be an exact semver; found ${JSON.stringify(version)}.`);
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every(item => typeof item === "string")
  );
}

function equalStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parseJsonOrText(source: string): unknown {
  const trimmed = source.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parseArguments(argv: readonly string[]): ReleaseOptions {
  const values = [...argv];
  const first = values[0];
  const mode: ReleaseMode = first === "publish" || first === "confirm" || first === "gate"
    ? (values.shift() as ReleaseMode)
    : "gate";
  let version = "";
  let handoffPath: string | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    if (argument === "--version") version = values[++index] ?? "";
    else if (argument.startsWith("--version=")) version = argument.slice("--version=".length);
    else if (argument === "--handoff") handoffPath = values[++index];
    else if (argument.startsWith("--handoff=")) handoffPath = argument.slice("--handoff=".length);
    else throw new Error(`Unknown release-family argument: ${argument}.`);
  }
  assertExactVersion(version);
  return { mode, version, handoffPath };
}

async function main(): Promise<void> {
  await runReleaseFamily(parseArguments(process.argv.slice(2)));
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch(error => {
    console.error(formatError(error));
    process.exitCode = 1;
  });
}
