import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { assertArtifactContainsItsEntryPoints } from "./artifact-entry-points.mjs";

import type { FamilyPackage } from "@mongez/pkgist";
import pkgistConfig from "../pkgist.config.ts";

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
  WARLOCK_FAMILY_NAME,
  type WarlockFamily,
  type WarlockFamilyMember,
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
  /**
   * Turn one package.json script's command text into a directly-invocable
   * binary + args, resolved from that package's own (or an ancestor's)
   * `node_modules/.bin`. Never shells the script text verbatim — a script
   * that itself reads `npx tsc --noEmit` must not be handed to a shell,
   * because that re-enters the very `npx` failure mode canon forbids.
   */
  resolvePackageScript?(memberRoot: string, scriptCommand: string): ResolvedScriptInvocation;
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

export interface ResolvedScriptInvocation {
  command: string;
  args: readonly string[];
}

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
  const dirtyTreeRefusals: string[] = [];
  const qualityRefusals: string[] = [];

  for (const member of family.members) {
    // Adjacent to the pack, per-member, not a sweep somewhere upstream: a
    // clean check run once, earlier, in one repo says nothing about the other
    // 27 — and by the time this loop reaches a later member, a teammate could
    // have re-dirtied an earlier one. Checking immediately before that
    // member's own build+pack is the only place the check cannot go stale
    // between "checked" and "used".
    const cleanliness = await checkPackageTreeIsClean(member, runtime);
    if (!cleanliness.clean) {
      dirtyTreeRefusals.push(cleanliness.refusalMessage);
      // Do NOT build or pack this member — but keep going. A dirty package
      // must refuse alone; it must never take the other 27 down with it.
      continue;
    }

    // Same call site, same shape: the gate proves the family graph, the
    // pins, and a clean tree per member, but none of that says the
    // package's OWN test/typecheck scripts are green — a package can be red
    // in its own repository and still sail through everything above. Check
    // it here, immediately before this member's own build+pack, so a red
    // suite refuses ONLY this member and the other 27 keep going.
    const quality = await checkPackageOwnQuality(member, runtime);
    if (!quality.passed) {
      qualityRefusals.push(quality.refusalMessage);
      continue;
    }

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

  if (dirtyTreeRefusals.length > 0 || qualityRefusals.length > 0) {
    // Every clean, green member above still built and packed (see the two
    // `continue`s above) — this refuses the release as a whole only now,
    // after every member has had its own independent chance, never before.
    throw new Error([...dirtyTreeRefusals, ...qualityRefusals].join("\n\n"));
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

export interface DirtyPathEntry {
  /** Path relative to the package's own git repository root, forward-slash normalized. */
  path: string;
  /** Two-character `git status --porcelain` code, e.g. "M ", "??", " M". */
  status: string;
}

export interface PublishedSurfaceResolution {
  /** Root-relative (POSIX) paths/directories that the build actually ships. */
  roots: readonly string[];
  /** How the surface was determined; carried into the log for the explicit waiver. */
  source: "pkgist-config" | "no-pkgist-config-fallback-entire-tree";
}

export interface PackageCleanlinessResult {
  clean: boolean;
  refusalMessage: string;
  dirtyInSurface: readonly DirtyPathEntry[];
  waivedOutsideSurface: readonly DirtyPathEntry[];
  surface: PublishedSurfaceResolution;
}

/**
 * Resolve one Warlock family member's `FamilyPackage` entry straight out of
 * `pkgist.config.ts` — the SAME object pkgist itself builds from.
 *
 * This deliberately does not read npm's own `files` field or `.npmignore`:
 * none of the 28 family members declare either (verified across every
 * top-level package.json in the workspace). What actually controls each
 * tarball's contents here is pkgist's own per-package `srcDir` (default
 * `"src"`, whole subtree bundled with `preserveModulesRoot`) plus its `clone`
 * list (verbatim-copied files/directories) — see
 * `node_modules/@mongez/pkgist/esm/compile/tsdown-compiler.mjs:36-37` and
 * `.../build/package-builder.mjs:70`. Reading files/.npmignore here would
 * silently answer a question this repo's build never asks.
 */
export function resolveFamilyPackageConfig(name: string): FamilyPackage | undefined {
  const family = pkgistConfig.families?.find(candidate => candidate.name === WARLOCK_FAMILY_NAME);
  return family?.packages.find(candidate => candidate.name === name);
}

/**
 * Turn a package's pkgist config into the set of root-relative paths its
 * build actually ships.
 *
 * When a member has no pkgist entry at all (should not happen for any of the
 * 28 — `loadAuthoritativeWarlockFamily` already reconciles the family against
 * this same config — but defended anyway), this refuses to guess and treats
 * the ENTIRE package tree as published: fail closed, never fail open.
 */
export function resolvePublishedSurface(
  packageConfig: FamilyPackage | undefined,
): PublishedSurfaceResolution {
  if (!packageConfig) {
    return { roots: ["."], source: "no-pkgist-config-fallback-entire-tree" };
  }
  const roots = new Set<string>();
  roots.add(normalizeRelative(packageConfig.srcDir ?? "src"));
  roots.add("package.json");
  for (const entry of packageConfig.clone ?? []) {
    const source = Array.isArray(entry) ? entry[0] : entry;
    roots.add(normalizeRelative(source));
  }
  return { roots: [...roots].sort(), source: "pkgist-config" };
}

function normalizeRelative(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function isWithinSurface(relativePath: string, roots: readonly string[]): boolean {
  return roots.some(root => root === "." || relativePath === root || relativePath.startsWith(`${root}/`));
}

/** Parse `git status --porcelain=v1 --untracked-files=all` output. */
export function parseGitPorcelain(output: string): DirtyPathEntry[] {
  const entries: DirtyPathEntry[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (line.length === 0) continue;
    const status = line.slice(0, 2);
    let rest = line.slice(3);
    const renameArrow = rest.indexOf(" -> ");
    if (renameArrow !== -1) rest = rest.slice(renameArrow + 4);
    rest = unquoteGitPath(rest);
    entries.push({ path: normalizeRelative(rest), status });
  }
  return entries;
}

function unquoteGitPath(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * Assert one package's git working tree is clean before it is built and
 * packed — untracked files count exactly as dirty as modified ones. A dirty
 * path OUTSIDE the resolved published surface is waived, but the waiver is
 * always logged, never silent.
 */
export async function checkPackageTreeIsClean(
  member: WarlockFamilyMember,
  runtime: Runtime,
): Promise<PackageCleanlinessResult> {
  const status = await runtime.runCommand({
    command: "git",
    args: ["status", "--porcelain=v1", "--untracked-files=all"],
    cwd: member.root,
    env: { ...process.env },
  });
  const entries = parseGitPorcelain(status.stdout);
  const surface = resolvePublishedSurface(resolveFamilyPackageConfig(member.name));

  const dirtyInSurface: DirtyPathEntry[] = [];
  const waivedOutsideSurface: DirtyPathEntry[] = [];
  for (const entry of entries) {
    if (isWithinSurface(entry.path, surface.roots)) dirtyInSurface.push(entry);
    else waivedOutsideSurface.push(entry);
  }

  for (const waived of waivedOutsideSurface) {
    console.warn(
      `[release-family] WAIVED (outside published surface): ${member.name} has an uncommitted ` +
        `change at ${waived.path} (git "${waived.status}"). Published surface: ${surface.roots.join(", ")} ` +
        `(resolved via ${surface.source}). Not packed; not blocking the release.`,
    );
  }

  if (dirtyInSurface.length === 0) {
    return { clean: true, refusalMessage: "", dirtyInSurface, waivedOutsideSurface, surface };
  }

  const refusalMessage = [
    `Refusing to pack ${member.name}: its working tree has uncommitted changes inside the published surface.`,
    `Package root: ${member.root}`,
    `Published surface resolved via: ${
      surface.source === "pkgist-config"
        ? `pkgist.config.ts (srcDir + clone): ${surface.roots.join(", ")}`
        : "no pkgist.config.ts entry found for this package -- treating the ENTIRE package tree as published"
    }`,
    "Offending paths:",
    ...dirtyInSurface.map(entry => `  - ${entry.path} (git "${entry.status}")`),
    `Fix: commit or revert these paths in ${member.name}'s own git repository before releasing this ` +
      `family. If a path genuinely never ships, exclude it from the published surface (srcDir/clone in ` +
      `pkgist.config.ts) instead of releasing over it.`,
  ].join("\n");

  return { clean: false, refusalMessage, dirtyInSurface, waivedOutsideSurface, surface };
}

/** The scripts this gate holds every family member to, in check order. */
const OWN_QUALITY_SCRIPTS = ["test", "typecheck"] as const;

export interface PackageOwnQualityResult {
  passed: boolean;
  refusalMessage: string;
  /** Script names this package declares nothing for — reported, never silent. */
  skipped: readonly string[];
}

/**
 * Run one package's OWN `test` and `typecheck` scripts, immediately before
 * it is built and packed.
 *
 * The rest of this gate proves the family graph, exact pins, a clean single
 * -Core install, generated-app typecheck, boot, build, start, and browser
 * assertions against a staged local registry — a great deal. None of it runs
 * a member's own test suite or typechecks its own source: a package can be
 * red in its own repository, at HEAD, with a clean working tree, and still
 * reach every one of those checks unexamined. That happened for real (`web`
 * failed 3 test files / 9 tests and its typecheck exited 2, and both shipped
 * in 5.3.0 and 5.3.1) before this check existed.
 *
 * A missing script is not evidence of health — it is a claim this gate could
 * not verify, so it is reported by name and treated as a skip, never as a
 * silent pass (see the `skipped` field and the console line emitted for each
 * one).
 */
export async function checkPackageOwnQuality(
  member: WarlockFamilyMember,
  runtime: Runtime,
): Promise<PackageOwnQualityResult> {
  const manifestPath = path.join(member.root, "package.json");
  const manifest = parseManifest(await runtime.readTextFile(manifestPath), manifestPath);
  const scripts = isStringRecord(manifest.scripts) ? manifest.scripts : {};

  const failures: string[] = [];
  const skipped: string[] = [];

  for (const scriptName of OWN_QUALITY_SCRIPTS) {
    const command = scripts[scriptName];
    if (typeof command !== "string" || command.trim().length === 0) {
      skipped.push(scriptName);
      console.warn(
        `[release-family] SKIPPED (no "${scriptName}" script): ${member.name} declares no ` +
          `"${scriptName}" script in ${manifestPath}; this gate could not check it.`,
      );
      continue;
    }

    let invocation: ResolvedScriptInvocation;
    try {
      invocation = runtime.resolvePackageScript(member.root, command);
    } catch (error) {
      failures.push(`"${scriptName}" (resolving "${command}"): ${formatError(error)}`);
      continue;
    }

    try {
      await runtime.runCommand({
        command: invocation.command,
        args: invocation.args,
        cwd: member.root,
        env: qualityCheckEnvironment(process.env),
      });
    } catch (error) {
      failures.push(
        `"${scriptName}" (${invocation.command} ${invocation.args.join(" ")}): ${formatError(error)}`,
      );
    }
  }

  if (failures.length === 0) {
    return { passed: true, refusalMessage: "", skipped };
  }

  const refusalMessage = [
    `Refusing to pack ${member.name}: its own quality gate is red.`,
    `Package root: ${member.root}`,
    "Failing scripts:",
    ...failures.map(failure => `  - ${failure}`),
    `Fix: make ${member.name}'s own failing script(s) pass in its own repository before ` +
      `releasing this family.`,
  ].join("\n");

  return { passed: false, refusalMessage, skipped };
}

/**
 * Strip `HTTP_PORT` and `NODE_ENV` from the environment handed to a
 * package's own `test`/`typecheck` child process.
 *
 * This machine exports both. An inherited `NODE_ENV=production` silently
 * exercises production branches in what is meant to be a plain quality
 * check, and an inherited `HTTP_PORT` can collide with whatever port a
 * package's own tests bind. Deleting rather than overriding: a script that
 * needs its own value still sets it itself.
 */
export function qualityCheckEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source };
  delete env.HTTP_PORT;
  delete env.NODE_ENV;
  return env;
}

/**
 * Resolve one package.json script's command text to a directly-invocable
 * binary, walking `node_modules/.bin` from the package's own root up through
 * its ancestors (npm's own hoisting resolution order) — mirroring how
 * `resolvePkgistCli`/`resolveNpmCli` already resolve a real file path instead
 * of trusting a shell to find one.
 *
 * A script may itself read `npx <bin> ...` (or `npx -y <bin> ...`): that
 * `npx` token is dropped rather than shelled, because handing that text to a
 * shell verbatim re-enters the exact `npx` resolution failure this workspace
 * forbids invoking directly (see AGENTS.md / the card). Any other leading
 * flags/tokens before the binary name are not supported — the scripts this
 * gate checks (`test`, `typecheck`) are simple `<bin> [...args]` or
 * `npx <bin> [...args]` forms across the family.
 *
 * npm installs a binary at `node_modules/.bin/<name>` as a plain,
 * extension-less JS file (a shebang line node ignores when the file itself
 * is passed to `node`), so invoking `process.execPath <thatPath> ...args`
 * runs the real binary without a shell and without `npx`.
 */
export function resolveLocalPackageScript(
  memberRoot: string,
  scriptCommand: string,
): ResolvedScriptInvocation {
  const tokens = scriptCommand.trim().split(/\s+/).filter(token => token.length > 0);
  let index = 0;
  if (tokens[index] === "npx") {
    index += 1;
    while (tokens[index]?.startsWith("-")) index += 1;
  }
  const head = tokens[index];
  if (!head) {
    throw new Error(`Cannot resolve a binary from script command "${scriptCommand}".`);
  }

  // A script that ALREADY invokes node — `node node_modules/vitest/vitest.mjs run`
  // — needs no resolution: it named its entry file itself, which is precisely
  // what this workspace asks scripts to do. Trying to resolve "node" as a local
  // binary is how the first version of this refused every such package.
  if (head === "node" || head === "node.exe") {
    const entry = tokens[index + 1];
    if (!entry) {
      throw new Error(`Script command "${scriptCommand}" invokes node with no entry file.`);
    }
    return {
      command: process.execPath,
      args: [path.resolve(memberRoot, entry), ...tokens.slice(index + 2)],
    };
  }

  return {
    command: process.execPath,
    args: [resolveLocalBinaryEntry(memberRoot, head), ...tokens.slice(index + 1)],
  };
}

/**
 * Resolve a bare binary name to a JS entry file node can execute.
 *
 * NOT `node_modules/.bin/<name>` — that is a shell shim. On Windows it is a
 * POSIX `sh` script (the `.CMD` and `.ps1` siblings are the executable ones),
 * so handing it to `node` fails with `SyntaxError: Invalid or unexpected token`
 * on its first comment line. The first version of this did exactly that and
 * refused 27 of 28 packages.
 *
 * So resolve through the package's own manifest instead: `bin` is either a
 * string (one entry) or a map of names to entries, and either way it points at
 * real JavaScript. That is also the only form that is portable — the shim
 * layout differs per platform and per package manager, the manifest does not.
 */
function resolveLocalBinaryEntry(startDirectory: string, binaryName: string): string {
  let directory = path.resolve(startDirectory);

  for (;;) {
    const modules = path.join(directory, "node_modules");
    const fromManifest = binaryEntryFromManifest(modules, binaryName);

    if (fromManifest) return fromManifest;

    // The binary name need not match the package name — `tsc` lives in
    // `typescript`. The shim knows the answer, so read it out of the shim
    // rather than guessing or scanning every installed package.
    const fromShim = binaryEntryFromShim(modules, binaryName);

    if (fromShim) return fromShim;

    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  throw new Error(
    `Cannot resolve local binary "${binaryName}" from ${startDirectory}: neither ` +
      `node_modules/${binaryName}/package.json nor the node_modules/.bin/${binaryName} shim ` +
      "named an entry, in it or any ancestor. Note this deliberately does NOT hand the shim " +
      "itself to node: the shim is a shell script, and node fails on its first comment line.",
  );
}

/** The common case: the binary name IS the package name (`vitest`, `eslint`). */
function binaryEntryFromManifest(modulesDirectory: string, binaryName: string): string | undefined {
  const manifestPath = path.join(modulesDirectory, binaryName, "package.json");

  if (!existsSync(manifestPath)) return undefined;

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const entry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[binaryName];

  return entry ? path.join(modulesDirectory, binaryName, entry) : undefined;
}

/**
 * The other case: the binary name differs from its package (`tsc` ->
 * `typescript`). Every shim npm and pnpm generate embeds the relative path to
 * the real entry — `../typescript/bin/tsc` — so extract that rather than
 * scanning every installed manifest for a matching `bin` key.
 */
function binaryEntryFromShim(modulesDirectory: string, binaryName: string): string | undefined {
  const shimPath = path.join(modulesDirectory, ".bin", binaryName);

  if (!existsSync(shimPath)) return undefined;

  const target = readFileSync(shimPath, "utf8").match(/\.\.\/[A-Za-z0-9@/_.-]+/)?.[0];

  if (!target) return undefined;

  const resolved = path.resolve(path.join(modulesDirectory, ".bin"), target);

  return existsSync(resolved) ? resolved : undefined;
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
    resolvePackageScript: dependencies.resolvePackageScript ?? resolveLocalPackageScript,
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

/**
 * Locate pkgist's CLI entry.
 *
 * `@mongez/pkgist` is ESM-only: its `exports` map declares an `import`
 * condition and nothing else, and it publishes no `./package.json` subpath.
 * `require.resolve` performs CommonJS export resolution, finds no usable
 * condition, and throws `ERR_PACKAGE_PATH_NOT_EXPORTED` — before a single
 * family member is built, so the whole release gate died on its first
 * statement. `import.meta.resolve` honours the `import` condition, which is
 * the only one this package offers.
 *
 * The subpath is `./cli`, resolving to `esm/cli.mjs`. The previous form
 * appended `cli.js` to the package root, which does not exist under any
 * resolver — so this function had two independent faults and could never have
 * returned a real path.
 */
export function resolvePkgistCli(): string {
  return fileURLToPath(import.meta.resolve("@mongez/pkgist/cli"));
}

export function resolveNpmCli(): string {
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
