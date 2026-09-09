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
  type LocalRegistryGateDependencies,
  type LocalRegistryGateInput,
  assertMatrixScopeAgreesWithRows,
  type MatrixScope,
  type PublishHandoff,
} from "./local-registry-gate.ts";
import {
  loadAuthoritativeWarlockFamily,
  WARLOCK_FAMILY_NAME,
  type WarlockFamily,
  type WarlockFamilyMember,
} from "./warlock-family.ts";
import {
  runZeroEditGeneratorGate,
  type GeneratorGateContext,
} from "./zero-edit-generator-gate.ts";

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

/**
 * The confirmation budget: how many times each still-unconfirmed subject is
 * re-polled, and how long between polls, before it is declared MISSING
 * rather than PENDING. Kept small deliberately -- see `confirmAtOrigin`.
 */
const CONFIRMATION_MAX_ATTEMPTS = 5;
const CONFIRMATION_RETRY_DELAY_MS = 3_000;

export type ReleaseMode = "gate" | "publish" | "confirm";

export interface ReleaseOptions {
  mode: ReleaseMode;
  version: string;
  handoffPath?: string;
  /**
   * Opt-in: reuse previously built tarballs for the SAME version instead of
   * rebuilding, but only when every one of them re-hashes to its recorded
   * SHA-256 AND every package's git HEAD and working tree match what was
   * recorded at build time. Any failed check falls back to a full rebuild,
   * naming the offending package -- never a silent half-reuse. Ignored
   * outside gate mode.
   */
  reuseArtifacts?: boolean;
  /**
   * How much of the zero-edit generator matrix this gate run executes.
   *
   * REQUIRED in gate mode, with no default. Canon `e00fb7b8` (owner ruling,
   * 2026-09-07, rev. 3) made the matrix OFF by default and let all three
   * scopes publish -- deliberately reversing rev. 2, which had said a
   * skipped matrix may never ship. What replaced the mandatory gate is the
   * RECORD: every release states its scope, and a release whose scope is not
   * stated must not ship. So this is asked for rather than defaulted; a
   * default is how an unstated scope becomes a stated one by accident.
   */
  matrixScope?: MatrixScope;
  /**
   * Opt-in: run only the baseline row plus the named feature rows (and the
   * composed row when "composed" is explicitly included) instead of the full
   * matrix. Required by, and only valid with, `matrixScope: "subset"`.
   * Ignored outside gate mode.
   */
  only?: readonly string[];
  /**
   * The owner's authorisation for running the matrix at all, quoted.
   *
   * Required for `"subset"` and `"full"`, refused for `"none"` (the
   * default scope needs no permission -- it is the one nobody has to ask
   * for). The runner CANNOT synthesise this: it is words the owner said, on
   * a date, and it is carried into the release summary verbatim because a
   * reference that only resolves inside Bureau is a dangling pointer
   * everywhere else (canon `09374678`).
   */
  matrixAuthorisation?: MatrixAuthorisation;
}

/**
 * An owner authorisation to run the matrix, as it must appear in the release
 * summary: who, when, and what they actually said.
 */
export interface MatrixAuthorisation {
  authorisedBy: string;
  /** ISO date (YYYY-MM-DD) the authorisation was given. */
  date: string;
  /** The owner's own words, quoted -- never a paraphrase or a bare pointer. */
  quote: string;
}

/** One family member's recorded build, kept alongside its tarball so a later run can prove reuse is still valid. */
export interface BuildProvenanceEntry {
  name: string;
  version: string;
  tarballPath: string;
  sha256: string;
  /** Full 40-char lowercase git commit hash, from that package's own repo, captured BEFORE the version bump. */
  gitHead: string;
  /**
   * Full 40-char lowercase git commit hash of the commit this member's tarball
   * was actually built from: the version bump and (when regenerated) the
   * lockfile, committed in that member's own repo immediately before packing.
   * `gitHead` above is its parent -- kept because something downstream may
   * still want it -- but THIS is what a later phase tags.
   */
  releaseCommitSha: string;
  /** Full `git status --porcelain` for that package's repo, captured at build time -- not scoped to the published surface. */
  gitDirtyEntries: readonly DirtyPathEntry[];
  builtAt: string;
}

export interface BuildProvenance {
  schemaVersion: 1;
  family: typeof WARLOCK_FAMILY_NAME;
  version: string;
  members: readonly BuildProvenanceEntry[];
}

export interface ReleaseHandoff extends PublishHandoff {
  subjects: readonly string[];
  /** Present exactly when the scope is not `"none"`; see {@link MatrixAuthorisation}. */
  matrixAuthorisation?: MatrixAuthorisation;
  /** Set only when this handoff's artifacts came from `--reuse-artifacts` instead of a fresh build. */
  reusedArtifacts?: boolean;
  /** The exact provenance proving each reused artifact is still valid -- carried into the handoff so the fact is never lost. */
  reuseProvenance?: readonly BuildProvenanceEntry[];
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
  /** Used only by `--reuse-artifacts` to prove a recorded tarball still exists before re-hashing it. */
  fileExists?(filePath: string): Promise<boolean>;
  writeHandoff?(filePath: string, handoff: ReleaseHandoff): Promise<void>;
  sha256File?(filePath: string): Promise<string>;
  resolvePkgistCli?(): string;
  resolveNpmCli?(): string;
  resolvePnpmCli?(): string;
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
  /** Every operator-facing progress/summary line goes through this, never a bare `console.log`. */
  report?(line: string): void;
  /** The one place a retry delay may come from -- never a bare `setTimeout` a spec cannot control. */
  sleep?(milliseconds: number): Promise<void>;
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
    return await prepareAndGate(family, options.version, handoffPath, runtime, {
      reuseArtifacts: options.reuseArtifacts,
      matrixScope: assertMatrixScopeIsStated(options),
      only: options.only,
      matrixAuthorisation: options.matrixAuthorisation,
    });
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

  // Tagging and pushing happen ONLY after origin confirmation has fully
  // succeeded (see `tagAndPushAllMembers`) -- a tag or push that exists
  // before the registry confirms is a claim the release has not earned.
  await confirmAtOrigin(handoff, runtime);
  await tagAndPushAllMembers(family, handoff, options.version, runtime);
}

export interface PrepareAndGateOptions {
  reuseArtifacts?: boolean;
  matrixScope?: MatrixScope;
  only?: readonly string[];
  matrixAuthorisation?: MatrixAuthorisation;
}

/**
 * Refuse a gate run that has not said how much of the matrix it runs, and
 * refuse a scope whose supporting arguments do not match it.
 *
 * Split out and exported so the rules can be exercised without building 28
 * packages first. The three refusals, and why each is a refusal rather than a
 * default:
 *
 * - **No scope at all.** Canon `e00fb7b8`: "a release whose scope is not
 *   stated must not ship". The scope reaches the public record through the
 *   handoff, so the handoff is where the requirement has to bite.
 * - **`subset` without rows, or `full`/`none` with them.** A handoff that
 *   misdescribes what ran is worse than one that admits it ran nothing.
 * - **`subset`/`full` without an authorisation.** The matrix is opt-in and
 *   only the owner opts in. The runner cannot read Bureau (the ruling says so
 *   itself), so the authorisation is supplied as the owner's quoted words and
 *   date; what the runner CAN do is refuse to invent them.
 *
 * `none` deliberately needs no authorisation. It is the default the ruling
 * chose, and requiring permission for the default would be requiring
 * permission to do nothing.
 */
export function assertMatrixScopeIsStated(options: {
  matrixScope?: MatrixScope;
  only?: readonly string[];
  matrixAuthorisation?: MatrixAuthorisation;
}): MatrixScope {
  const scope = options.matrixScope;

  if (!scope) {
    throw new Error(
      [
        "Refusing to gate: this run has not stated its generator-matrix scope.",
        "Pass --matrix none | subset | full.",
        "",
        "The matrix is OFF by default and a release may ship without it (canon e00fb7b8),",
        "but EVERY release states the scope it ran -- in the handoff, the release summary and",
        "docs/src/data/releases.json. That record is the entire safeguard that replaced the",
        "mandatory gate, so an unstated scope is refused here rather than defaulted.",
      ].join("\n"),
    );
  }

  assertMatrixScopeAgreesWithRows(scope, options.only);

  if (scope === "none") {
    if (options.matrixAuthorisation) {
      throw new Error(
        'matrixScope "none" needs no authorisation -- it is the default. Drop --authorised-by/--authorisation.',
      );
    }
    return scope;
  }

  const authorisation = options.matrixAuthorisation;
  if (!authorisation) {
    throw new Error(
      [
        `Refusing to run the matrix at scope "${scope}" with no recorded owner authorisation.`,
        "Pass --authorised-by <name> --authorisation-date <YYYY-MM-DD> --authorisation \"<their words>\".",
        "",
        "The matrix is opt-in and only the owner opts in. This runner cannot read Bureau, so it",
        "cannot check that the authorisation is real -- what it can do is refuse to invent one.",
        "The quote is carried into the release summary verbatim (canon 09374678).",
      ].join("\n"),
    );
  }

  if (!authorisation.authorisedBy.trim()) {
    throw new Error("--authorised-by must name a person.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(authorisation.date)) {
    throw new Error(`--authorisation-date must be an ISO date (YYYY-MM-DD); got "${authorisation.date}".`);
  }
  if (!authorisation.quote.trim()) {
    throw new Error("--authorisation must carry the owner's actual words, not an empty string.");
  }

  return scope;
}

async function prepareAndGate(
  family: WarlockFamily,
  version: string,
  handoffPath: string,
  runtime: Runtime,
  options: PrepareAndGateOptions = {},
): Promise<ReleaseHandoff> {
  // A failed retry must not leave an older same-version handoff looking green.
  await runtime.removeFile(handoffPath);

  const artifactDirectory = path.join(ARTIFACT_ROOT, version);
  await runtime.makeDirectory(artifactDirectory);

  const matrixScope = options.matrixScope ?? "none";
  const only = options.only;

  // Loud at the START, and now TRUE at the end too. This warning used to say a
  // subset run "CANNOT produce a publish handoff, under any circumstance" —
  // which was accurate about the code and, after canon `e00fb7b8`, wrong about
  // the ruling: the owner reversed rev. 2 on purpose and all three scopes may
  // publish. A refusal the owner has explicitly lifted is not a safeguard, it
  // is a trap someone hits mid-release and routes around. What replaced it is
  // the record: the scope rides in the handoff and must reach the release
  // summary and `releases.json`.
  if (matrixScope === "subset") {
    console.warn(
      `[release-family] SUBSET GATE RUN (--only ${(only ?? []).join(",")}): baseline always runs; composed row ` +
        `${(only ?? []).includes("composed") ? "WILL run (explicitly requested)" : "is SKIPPED (pass --only composed to include it)"}. ` +
        "The handoff will record matrixScope=subset and the exact rows.",
    );
  } else if (matrixScope === "none") {
    console.warn(
      "[release-family] MATRIX NOT RUN (--matrix none): the local registry is still owned, all 28 tarballs " +
        "are still staged and every member is still confirmed installable — but the zero-edit generator " +
        "matrix, the only check that answers \"does what we publish actually work?\", does not run. " +
        "The handoff will record matrixScope=none, and that MUST reach the release summary and releases.json.",
    );
  }

  let artifacts: CandidateArtifact[] | undefined;
  let reusedArtifacts = false;
  let reuseProvenance: BuildProvenanceEntry[] | undefined;

  if (options.reuseArtifacts) {
    const attempt = await attemptArtifactReuse(family, version, artifactDirectory, runtime);
    if (attempt.reusable) {
      artifacts = attempt.artifacts;
      reusedArtifacts = true;
      reuseProvenance = attempt.provenance;
      console.warn(
        `[release-family] REUSING previously built artifacts for ${version} (--reuse-artifacts): all ` +
          `${artifacts.length} tarballs re-hashed clean and every package's git HEAD/tree matched its recorded build.`,
      );
    } else {
      console.warn(
        `[release-family] --reuse-artifacts requested but invalid: ${attempt.reason} Doing a FULL REBUILD.`,
      );
    }
  }

  if (!artifacts) {
    const built = await buildAndPackAllMembers(family, version, artifactDirectory, runtime);
    artifacts = built.artifacts;
    if (built.provenance.length > 0) {
      await writeProvenance(artifactDirectory, version, built.provenance, runtime);
    }
  }

  const gated = await runtime.runLocalGate(
    {
      candidateVersion: version,
      expectedFamilyNames: family.members.map(member => member.name),
      artifacts,
      // The generator gate's three adapter paths are read from the
      // environment exactly once, here, at the outermost entry point, and
      // threaded through the local-registry gate as plain context data.
      featureCatalogAdapterPath: process.env.WARLOCK_FEATURE_CATALOG_ADAPTER,
      generatedOutputOraclePath: process.env.WARLOCK_GENERATED_OUTPUT_ORACLE,
      browserOracleAdapterPath: process.env.WARLOCK_GENERATED_BROWSER_ORACLE,
      matrixScope,
      onlyFeatures: only,
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
    ...(options.matrixAuthorisation ? { matrixAuthorisation: options.matrixAuthorisation } : {}),
    ...(reusedArtifacts ? { reusedArtifacts: true, reuseProvenance } : {}),
  };
  assertHandoffMatchesArtifacts(handoff, artifacts, version);

  await runtime.writeHandoff(handoffPath, handoff);
  return handoff;
}

async function buildAndPackAllMembers(
  family: WarlockFamily,
  version: string,
  artifactDirectory: string,
  runtime: Runtime,
): Promise<{ artifacts: CandidateArtifact[]; provenance: BuildProvenanceEntry[] }> {
  const artifacts: CandidateArtifact[] = [];
  const provenance: BuildProvenanceEntry[] = [];
  const dirtyTreeRefusals: string[] = [];
  const qualityRefusals: string[] = [];
  const lockfileRefusals: string[] = [];
  const commitRefusals: string[] = [];

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

    // Captured BEFORE `pkgist build` touches this member's tree, so it stays
    // the pre-bump commit even though the commit step below moves HEAD.
    const gitHead = await getGitHead(member, runtime);

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

    // Same call site, same shape again: `pkgist build` just rewrote THIS
    // member's package.json in the working tree -- its version and its exact
    // intra-family pins -- and any lockfile that member carries now describes
    // a manifest that no longer exists. Checked here, immediately after the
    // rewrite and before this member is packed, so a stale lockfile refuses
    // ONLY this member; a sweep afterwards could regenerate a lockfile that
    // then goes stale again before it is ever packed.
    const lockfile = await regenerateMemberLockfile(member, runtime);
    if (!lockfile.passed) {
      lockfileRefusals.push(lockfile.refusalMessage);
      continue;
    }

    // Commit THIS member's release edits -- the bumped manifest and, when
    // regenerated, its lockfile -- in its own repo, immediately before it is
    // packed. Same call site as the checks above, same reason: the tarball is
    // built from this member's working tree, and until this commit exists
    // nothing in git describes what was actually packed.
    const commit = await commitMemberReleaseEdits(member, version, lockfile.regenerated, runtime);
    if (!commit.committed) {
      commitRefusals.push(commit.refusalMessage);
      continue;
    }

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
    const sha256 = await runtime.sha256File(tarballPath);
    artifacts.push({ name: member.name, tarballPath, sha256 });

    // Provenance is recorded for EVERY build, whether or not this run used
    // --reuse-artifacts: it is what lets a LATER run reuse these tarballs.
    provenance.push({
      name: member.name,
      version,
      tarballPath,
      sha256,
      gitHead,
      releaseCommitSha: commit.sha,
      gitDirtyEntries: [...cleanliness.dirtyInSurface, ...cleanliness.waivedOutsideSurface],
      builtAt: runtime.now().toISOString(),
    });
  }

  if (
    dirtyTreeRefusals.length > 0 ||
    qualityRefusals.length > 0 ||
    lockfileRefusals.length > 0 ||
    commitRefusals.length > 0
  ) {
    // Every clean, green member above still built and packed (see the
    // `continue`s above) — this refuses the release as a whole only now,
    // after every member has had its own independent chance, never before.
    throw new Error(
      [...dirtyTreeRefusals, ...qualityRefusals, ...lockfileRefusals, ...commitRefusals].join("\n\n"),
    );
  }

  return { artifacts, provenance };
}

function provenancePath(artifactDirectory: string): string {
  return path.join(artifactDirectory, "build-provenance.json");
}

async function readProvenance(
  artifactDirectory: string,
  version: string,
  runtime: Runtime,
): Promise<BuildProvenance | undefined> {
  let source: string;
  try {
    source = await runtime.readTextFile(provenancePath(artifactDirectory));
  } catch {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<BuildProvenance>;
  if (record.schemaVersion !== 1 || record.version !== version || !Array.isArray(record.members)) {
    return undefined;
  }
  return record as BuildProvenance;
}

async function writeProvenance(
  artifactDirectory: string,
  version: string,
  members: readonly BuildProvenanceEntry[],
  runtime: Runtime,
): Promise<void> {
  const provenance: BuildProvenance = {
    schemaVersion: 1,
    family: WARLOCK_FAMILY_NAME,
    version,
    members,
  };
  await runtime.writeTextFile(provenancePath(artifactDirectory), `${JSON.stringify(provenance, null, 2)}\n`);
}

interface ArtifactReuseAttempt {
  reusable: boolean;
  /** Human-readable, names the offending package -- empty when reusable. */
  reason: string;
  artifacts: CandidateArtifact[];
  provenance: BuildProvenanceEntry[];
}

/**
 * Prove (never merely assume) that every family member's previously built
 * tarball for THIS version is still exactly what it was when it was built:
 * the recorded artifact exists, its tarball still exists and re-hashes to the
 * recorded SHA-256, and the package's git HEAD and full working-tree status
 * are byte-for-byte identical to what was captured at build time.
 *
 * Any single failure invalidates reuse for the WHOLE run -- never a silent
 * half-reuse of some members and a rebuild of others.
 */
export async function attemptArtifactReuse(
  family: WarlockFamily,
  version: string,
  artifactDirectory: string,
  runtime: Runtime,
): Promise<ArtifactReuseAttempt> {
  const provenance = await readProvenance(artifactDirectory, version, runtime);
  if (!provenance) {
    return {
      reusable: false,
      reason: `no recorded build-provenance.json for version ${version} in ${artifactDirectory}.`,
      artifacts: [],
      provenance: [],
    };
  }

  const byName = new Map(provenance.members.map(entry => [entry.name, entry]));
  const artifacts: CandidateArtifact[] = [];
  const kept: BuildProvenanceEntry[] = [];

  for (const member of family.members) {
    const entry = byName.get(member.name);
    if (!entry || entry.version !== version) {
      return {
        reusable: false,
        reason: `no recorded artifact for ${member.name} at version ${version}.`,
        artifacts: [],
        provenance: [],
      };
    }
    if (!(await runtime.fileExists(entry.tarballPath))) {
      return {
        reusable: false,
        reason: `recorded tarball for ${member.name} no longer exists at ${entry.tarballPath}.`,
        artifacts: [],
        provenance: [],
      };
    }

    const actualHash = (await runtime.sha256File(entry.tarballPath)).toLowerCase();
    if (actualHash !== entry.sha256.toLowerCase()) {
      return {
        reusable: false,
        reason:
          `recorded tarball for ${member.name} re-hashed to ${actualHash}, expected ${entry.sha256}.`,
        artifacts: [],
        provenance: [],
      };
    }

    const currentHead = await getGitHead(member, runtime);
    if (currentHead !== entry.gitHead.toLowerCase()) {
      return {
        reusable: false,
        reason: `git HEAD for ${member.name} moved (recorded ${entry.gitHead}, now ${currentHead}).`,
        artifacts: [],
        provenance: [],
      };
    }

    const currentDirtyEntries = await getRawGitStatus(member, runtime);
    if (!sameDirtyEntries(currentDirtyEntries, entry.gitDirtyEntries)) {
      return {
        reusable: false,
        reason: `git working tree for ${member.name} changed since its recorded build.`,
        artifacts: [],
        provenance: [],
      };
    }

    artifacts.push({ name: entry.name, tarballPath: entry.tarballPath, sha256: entry.sha256 });
    kept.push(entry);
  }

  return { reusable: true, reason: "", artifacts, provenance: kept };
}

async function getGitHead(member: WarlockFamilyMember, runtime: Runtime): Promise<string> {
  const result = await runtime.runCommand({
    command: "git",
    args: ["rev-parse", "HEAD"],
    cwd: member.root,
    env: { ...process.env },
  });
  const head = result.stdout.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(head)) {
    throw new Error(`Cannot resolve git HEAD for ${member.name}: unexpected output "${result.stdout.trim()}".`);
  }
  return head;
}

async function getRawGitStatus(member: WarlockFamilyMember, runtime: Runtime): Promise<DirtyPathEntry[]> {
  const result = await runtime.runCommand({
    command: "git",
    args: ["status", "--porcelain=v1", "--untracked-files=all"],
    cwd: member.root,
    env: { ...process.env },
  });
  return parseGitPorcelain(result.stdout);
}

function sameDirtyEntries(left: readonly DirtyPathEntry[], right: readonly DirtyPathEntry[]): boolean {
  if (left.length !== right.length) return false;
  const key = (entry: DirtyPathEntry) => `${entry.status} ${entry.path}`;
  const sortedLeft = left.map(key).sort();
  const sortedRight = right.map(key).sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
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

/** The one lockfile name this checks for; a member with no file by this name is left untouched. */
const PNPM_LOCKFILE_NAME = "pnpm-lock.yaml";

export interface LockfileRegenerationResult {
  /** False when the member has no lockfile at all -- nothing to do, and not a failure. */
  regenerated: boolean;
  passed: boolean;
  refusalMessage: string;
}

/**
 * Regenerate a family member's own lockfile immediately after `pkgist build`
 * rewrites that member's `package.json`, and prove the two agree before this
 * member is packed.
 *
 * Keyed off whether a `pnpm-lock.yaml` exists at the member's own root, never
 * off the member's name: `pkgist build` rewrites every member's manifest --
 * its version and its exact intra-family pins -- and ANY member that also
 * carries its own lockfile has just had that lockfile's promises broken by a
 * rewrite it never saw. `create-warlock` is the one member with a lockfile
 * today (it doubles as an independently CI'd repository), but a rule that
 * named it by name would miss the next one exactly the way this defect
 * shipped in 5.6.0: `@warlock.js/fs` was rewritten to an exact `5.6.0` while
 * `create-warlock`'s lockfile still resolved `^5.1.0`, and
 * `pnpm install --frozen-lockfile` -- what its CI actually runs -- refused
 * every run from the moment 5.6.0 published, for a reason no source change
 * could explain.
 *
 * The proof is that same real command, `pnpm install --frozen-lockfile`,
 * never a structural diff of lockfile against manifest -- a check that
 * cannot execute its subject is not a check.
 */
export async function regenerateMemberLockfile(
  member: WarlockFamilyMember,
  runtime: Runtime,
): Promise<LockfileRegenerationResult> {
  const lockfilePath = path.join(member.root, PNPM_LOCKFILE_NAME);
  if (!(await runtime.fileExists(lockfilePath))) {
    return { regenerated: false, passed: true, refusalMessage: "" };
  }

  try {
    await runtime.runCommand({
      command: process.execPath,
      args: [runtime.resolvePnpmCli(), "install", "--lockfile-only"],
      cwd: member.root,
      env: { ...process.env },
    });
  } catch (error) {
    return {
      regenerated: false,
      passed: false,
      refusalMessage: [
        `Refusing to pack ${member.name}: its lockfile could not be regenerated after pkgist rewrote its manifest.`,
        `Package root: ${member.root}`,
        `pnpm install --lockfile-only: ${formatError(error)}`,
      ].join("\n"),
    };
  }

  try {
    await runtime.runCommand({
      command: process.execPath,
      args: [runtime.resolvePnpmCli(), "install", "--frozen-lockfile"],
      cwd: member.root,
      env: { ...process.env },
    });
  } catch (error) {
    return {
      regenerated: true,
      passed: false,
      refusalMessage: [
        `Refusing to pack ${member.name}: its regenerated lockfile does not agree with its rewritten manifest.`,
        `Package root: ${member.root}`,
        `pnpm install --frozen-lockfile: ${formatError(error)}`,
        "Fix: this is the exact command that member's own CI runs -- if it refuses here, CI would refuse too.",
      ].join("\n"),
    };
  }

  return { regenerated: true, passed: true, refusalMessage: "" };
}

export interface MemberCommitResult {
  committed: boolean;
  refusalMessage: string;
  /** Full 40-char lowercase sha of the new commit -- empty when `committed` is false. */
  sha: string;
}

/**
 * Commit one family member's release edits -- its bumped `package.json` and,
 * when this run regenerated one, its `pnpm-lock.yaml` -- in that member's own
 * repo, immediately before it is packed.
 *
 * Path-scoped, explicit paths only. Never `git commit -a`, `git add -A` or
 * `git add .`: `checkPackageTreeIsClean` WAIVES (and merely logs) an
 * uncommitted change OUTSIDE this member's published surface, so a
 * teammate's unrelated in-progress file can legitimately be sitting in this
 * tree right now. A sweep would pull it into a release commit; naming exactly
 * the paths this release wrote is what keeps that impossible.
 */
export async function commitMemberReleaseEdits(
  member: WarlockFamilyMember,
  version: string,
  includeLockfile: boolean,
  runtime: Runtime,
): Promise<MemberCommitResult> {
  const paths = includeLockfile ? ["package.json", PNPM_LOCKFILE_NAME] : ["package.json"];

  try {
    await runtime.runCommand({
      command: "git",
      args: ["add", "--", ...paths],
      cwd: member.root,
      env: { ...process.env },
    });
    await runtime.runCommand({
      command: "git",
      args: ["commit", "-m", `release: ${member.name}@${version}`, "--", ...paths],
      cwd: member.root,
      env: { ...process.env },
    });
  } catch (error) {
    return {
      committed: false,
      refusalMessage: [
        `Refusing to pack ${member.name}: its release edits could not be committed.`,
        `Package root: ${member.root}`,
        `Paths: ${paths.join(", ")}`,
        `git commit: ${formatError(error)}`,
      ].join("\n"),
      sha: "",
    };
  }

  const sha = await getGitHead(member, runtime);
  return { committed: true, refusalMessage: "", sha };
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

    const total = handoff.artifacts.length;
    for (const [index, artifact] of handoff.artifacts.entries()) {
      await assertArtifactHash(artifact, runtime.sha256File);
      await runtime.runCommand({
        command: process.execPath,
        args: [runtime.resolveNpmCli(), "publish", artifact.tarballPath, "--registry", NPM_ORIGIN, "--access", "public", "--ignore-scripts", "--cache", cache, "--userconfig", userconfig, "--globalconfig", globalconfig],
        cwd: root,
        env,
      });
      runtime.report(`[${index + 1}/${total}] ${artifact.name}: published`);
    }
  } finally {
    await runtime.removeDirectory(root);
  }
}

type SubjectConfirmationStatus = "live" | "pending" | "missing";

/**
 * Poll every subject, never throwing on the first miss. A subject
 * unconfirmed on one attempt is PENDING and is retried; one still
 * unconfirmed when `CONFIRMATION_MAX_ATTEMPTS` is spent is MISSING.
 *
 * The terminal summary -- which of the N subjects are live -- prints on
 * BOTH the success and the failure path, because it is what replaces the
 * dry-run publish an operator used to reach for on a bad day.
 */
export async function confirmSubjectsAtOrigin(
  handoff: ReleaseHandoff,
  runtime: Pick<Runtime, "resolveNpmCli" | "runCommand" | "report" | "sleep">,
  root: string,
  cache: string,
  npmrc: string,
  globalNpmrc: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const statuses = new Map<string, SubjectConfirmationStatus>(
    handoff.subjects.map(name => [name, "pending"]),
  );

  runtime.report(
    `Confirming ${handoff.subjects.length} package(s) at ${handoff.candidateVersion} ` +
      `(up to ${CONFIRMATION_MAX_ATTEMPTS} attempt(s), ${CONFIRMATION_RETRY_DELAY_MS}ms apart)...`,
  );

  for (let attempt = 1; attempt <= CONFIRMATION_MAX_ATTEMPTS; attempt++) {
    const outstanding = [...statuses.entries()]
      .filter(([, status]) => status === "pending")
      .map(([name]) => name);
    if (outstanding.length === 0) break;

    for (const name of outstanding) {
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
      if (observed === handoff.candidateVersion) {
        statuses.set(name, "live");
        runtime.report(`${name}: live (confirmed on attempt ${attempt}/${CONFIRMATION_MAX_ATTEMPTS})`);
      } else if (attempt === CONFIRMATION_MAX_ATTEMPTS) {
        statuses.set(name, "missing");
        runtime.report(`${name}: MISSING after ${CONFIRMATION_MAX_ATTEMPTS} attempt(s)`);
      } else {
        runtime.report(`${name}: PENDING (attempt ${attempt}/${CONFIRMATION_MAX_ATTEMPTS})`);
      }
    }

    const stillPending = [...statuses.values()].some(status => status === "pending");
    if (stillPending && attempt < CONFIRMATION_MAX_ATTEMPTS) {
      await runtime.sleep(CONFIRMATION_RETRY_DELAY_MS);
    }
  }

  const live = [...statuses.entries()].filter(([, status]) => status === "live").map(([name]) => name);
  const missing = [...statuses.entries()].filter(([, status]) => status === "missing").map(([name]) => name);

  runtime.report(
    `Origin confirmation summary: ${live.length}/${handoff.subjects.length} live` +
      (missing.length > 0 ? `; MISSING: ${missing.join(", ")}` : ""),
  );

  if (missing.length > 0) {
    throw new Error(
      `npm origin did not confirm ${missing.length} of ${handoff.subjects.length} package(s) at ` +
        `${handoff.candidateVersion} within budget (${CONFIRMATION_MAX_ATTEMPTS} attempts): ${missing.join(", ")}.`,
    );
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
    await confirmSubjectsAtOrigin(handoff, runtime, root, cache, npmrc, globalNpmrc, env);

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

/** `v<version>` -- the format every family member's own repo already uses for its release tags (verified against each member's existing `git tag` output, e.g. `v5.6.0`). */
export function releaseTagName(version: string): string {
  return `v${version}`;
}

export interface MemberTagPushOutcome {
  name: string;
  tag: string;
  /** Undefined only when the branch itself could not be resolved (refused). */
  branch?: string;
  /** True when a NEW local tag was created this run. */
  tagged: boolean;
  /** True when the local tag already existed, at the recorded sha -- a no-op success. */
  alreadyTagged: boolean;
  /** True when the tag was pushed to origin this run. */
  tagPushed: boolean;
  /** True when origin already carried this tag at the recorded sha -- a no-op success. */
  tagAlreadyPushed: boolean;
  /** True when the branch ref was pushed to the recorded sha this run. */
  pushed: boolean;
  /** True when origin's branch ref was already at the recorded sha -- a no-op success. */
  alreadyPushed: boolean;
  refused: boolean;
  /** Names this member, the branch, and the offending commits/shas -- empty when not refused. */
  refusalMessage: string;
}

function refusedTagPushOutcome(
  name: string,
  tag: string,
  refusalMessage: string,
  branch?: string,
): MemberTagPushOutcome {
  return {
    name,
    tag,
    branch,
    tagged: false,
    alreadyTagged: false,
    tagPushed: false,
    tagAlreadyPushed: false,
    pushed: false,
    alreadyPushed: false,
    refused: true,
    refusalMessage,
  };
}

/**
 * Resolve the branch currently checked out in one member's OWN repo.
 *
 * These are 28 independent repositories -- nothing here may assume a branch
 * name (e.g. "main"). `create-warlock` today is checked out on a feature
 * branch, not "main", which is exactly the case a hard-coded name would miss.
 */
async function resolveMemberBranch(member: WarlockFamilyMember, runtime: Runtime): Promise<string> {
  const result = await runtime.runCommand({
    command: "git",
    args: ["rev-parse", "--abbrev-ref", "HEAD"],
    cwd: member.root,
    env: { ...process.env },
  });
  const branch = result.stdout.trim();
  if (!branch || branch === "HEAD") {
    throw new Error(`Cannot resolve a branch for ${member.name}: HEAD is detached (got "${branch}").`);
  }
  return branch;
}

/** The commit a remote ref (a branch or a tag) currently points at, or undefined when the ref does not exist at origin. Never requires a local fetch. */
async function resolveOriginRefSha(
  member: WarlockFamilyMember,
  ref: string,
  runtime: Runtime,
): Promise<string | undefined> {
  const result = await runtime.runCommand({
    command: "git",
    args: ["ls-remote", "origin", ref],
    cwd: member.root,
    env: { ...process.env },
  });
  const line = result.stdout.split(/\r?\n/).find(value => value.trim().length > 0);
  if (!line) return undefined;
  const sha = line.split(/\s+/)[0]?.toLowerCase();
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`Cannot parse "git ls-remote origin ${ref}" output for ${member.name}: "${line}".`);
  }
  return sha;
}

async function isAncestorCommit(
  member: WarlockFamilyMember,
  ancestorSha: string,
  descendantSha: string,
  runtime: Runtime,
): Promise<boolean> {
  try {
    await runtime.runCommand({
      command: "git",
      args: ["merge-base", "--is-ancestor", ancestorSha, descendantSha],
      cwd: member.root,
      env: { ...process.env },
    });
    return true;
  } catch {
    return false;
  }
}

/** Best-effort: the offending commits are for the refusal message, never load-bearing to the refusal itself. */
async function listCommitsBetween(
  member: WarlockFamilyMember,
  fromExclusiveSha: string,
  toInclusiveSha: string,
  runtime: Runtime,
): Promise<readonly string[]> {
  try {
    const result = await runtime.runCommand({
      command: "git",
      args: ["log", "--oneline", `${fromExclusiveSha}..${toInclusiveSha}`],
      cwd: member.root,
      env: { ...process.env },
    });
    return result.stdout.split(/\r?\n/).filter(line => line.trim().length > 0);
  } catch {
    return [];
  }
}

/** The local tag's sha, or undefined when no such tag exists locally yet. */
async function resolveLocalTagSha(
  member: WarlockFamilyMember,
  tag: string,
  runtime: Runtime,
): Promise<string | undefined> {
  try {
    const result = await runtime.runCommand({
      command: "git",
      args: ["rev-parse", "--verify", `refs/tags/${tag}^{commit}`],
      cwd: member.root,
      env: { ...process.env },
    });
    return result.stdout.trim().toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Tag and push ONE family member at its recorded `releaseCommitSha` -- never
 * at HEAD, which may have moved since the build.
 *
 * Idempotent by construction: a tag that already exists at the SAME sha, or
 * a branch/tag ref already at the recorded sha at origin, is reported as a
 * no-op success, never redone. A tag or ref that exists at a DIFFERENT sha is
 * a refusal -- this never passes `--force`.
 */
export async function tagAndPushMember(
  member: WarlockFamilyMember,
  version: string,
  releaseCommitSha: string,
  runtime: Runtime,
): Promise<MemberTagPushOutcome> {
  const sha = releaseCommitSha.toLowerCase();
  const tag = releaseTagName(version);

  let branch: string;
  try {
    branch = await resolveMemberBranch(member, runtime);
  } catch (error) {
    return refusedTagPushOutcome(member.name, tag, formatError(error));
  }

  // Refuse rather than push something unexpected: origin's current branch
  // tip must be an ancestor of (or equal to) the recorded release commit. If
  // it is not, origin carries commits this release does not account for.
  const originBranchTip = await resolveOriginRefSha(member, `refs/heads/${branch}`, runtime);
  if (originBranchTip && originBranchTip !== sha) {
    const isAncestor = await isAncestorCommit(member, originBranchTip, sha, runtime);
    if (!isAncestor) {
      const offending = await listCommitsBetween(member, sha, originBranchTip, runtime);
      return refusedTagPushOutcome(
        member.name,
        tag,
        [
          `Refusing to push ${member.name}: origin/${branch} (${originBranchTip}) is not an ` +
            `ancestor of the recorded release commit ${sha}.`,
          `Branch: ${branch}`,
          offending.length > 0
            ? `Commits on origin/${branch} beyond ${sha}:`
            : `origin/${branch} could not be explained relative to ${sha}.`,
          ...offending.map(line => `  - ${line}`),
        ].join("\n"),
        branch,
      );
    }
  }

  let tagged = false;
  let alreadyTagged = false;
  const localTagSha = await resolveLocalTagSha(member, tag, runtime);
  if (localTagSha) {
    if (localTagSha !== sha) {
      return refusedTagPushOutcome(
        member.name,
        tag,
        `Refusing to move tag ${tag} for ${member.name}: it already exists locally at ` +
          `${localTagSha}, not the recorded release commit ${sha}. Never moved with --force.`,
        branch,
      );
    }
    alreadyTagged = true;
  } else {
    await runtime.runCommand({
      command: "git",
      args: ["tag", tag, sha],
      cwd: member.root,
      env: { ...process.env },
    });
    tagged = true;
  }

  let tagPushed = false;
  let tagAlreadyPushed = false;
  const originTagSha = await resolveOriginRefSha(member, `refs/tags/${tag}`, runtime);
  if (originTagSha) {
    if (originTagSha !== sha) {
      return refusedTagPushOutcome(
        member.name,
        tag,
        `Refusing to move tag ${tag} for ${member.name} at origin: it already exists there at ` +
          `${originTagSha}, not the recorded release commit ${sha}. Never moved with --force.`,
        branch,
      );
    }
    tagAlreadyPushed = true;
  } else {
    await runtime.runCommand({
      command: "git",
      args: ["push", "origin", `refs/tags/${tag}`],
      cwd: member.root,
      env: { ...process.env },
    });
    tagPushed = true;
  }

  let pushed = false;
  let alreadyPushed = false;
  if (originBranchTip === sha) {
    alreadyPushed = true;
  } else {
    // The recorded sha, never the branch tip: anything committed after the
    // build is structurally excluded from what reaches origin here.
    await runtime.runCommand({
      command: "git",
      args: ["push", "origin", `${sha}:refs/heads/${branch}`],
      cwd: member.root,
      env: { ...process.env },
    });
    pushed = true;
  }

  return {
    name: member.name,
    tag,
    branch,
    tagged,
    alreadyTagged,
    tagPushed,
    tagAlreadyPushed,
    pushed,
    alreadyPushed,
    refused: false,
    refusalMessage: "",
  };
}

/**
 * Tag and push every family member named in the handoff, at each member's
 * own `releaseCommitSha` recorded in `build-provenance.json` -- read back
 * here rather than threaded through the handoff, exactly as `confirmAtOrigin`
 * reads the handoff rather than re-deriving it.
 *
 * One member's refusal never stops the other 27: every member gets its own
 * independent attempt, and this throws once at the end with every refusal
 * joined -- the same shape as the gate's own per-member refusals.
 */
export async function tagAndPushAllMembers(
  family: WarlockFamily,
  handoff: ReleaseHandoff,
  version: string,
  runtime: Runtime,
): Promise<readonly MemberTagPushOutcome[]> {
  const artifactDirectory = path.join(ARTIFACT_ROOT, version);
  const provenance = await readProvenance(artifactDirectory, version, runtime);
  if (!provenance) {
    throw new Error(
      `Refusing to tag/push: no build-provenance.json for version ${version} in ` +
        `${artifactDirectory} -- cannot recover each member's recorded release commit.`,
    );
  }
  const provenanceByName = new Map(provenance.members.map(entry => [entry.name, entry]));
  const membersByName = new Map(family.members.map(member => [member.name, member]));

  const results: MemberTagPushOutcome[] = [];
  const refusals: string[] = [];

  for (const name of handoff.subjects) {
    const member = membersByName.get(name);
    const entry = provenanceByName.get(name);
    if (!member || !entry) {
      const message =
        `Refusing to tag/push ${name}: no recorded release-commit sha in build-provenance.json ` +
        `for version ${version}.`;
      console.warn(`[release-family] REFUSED (tag/push) ${name}: ${message}`);
      refusals.push(message);
      continue;
    }

    const outcome = await tagAndPushMember(member, version, entry.releaseCommitSha, runtime);
    results.push(outcome);

    if (outcome.refused) {
      console.warn(`[release-family] REFUSED (tag/push) ${name}: ${outcome.refusalMessage}`);
      refusals.push(outcome.refusalMessage);
    } else {
      console.warn(
        `[release-family] ${name} @ ${entry.releaseCommitSha}: tag ${outcome.tag} ` +
          `${outcome.alreadyTagged ? "already existed locally" : "created"}, ` +
          `${outcome.tagAlreadyPushed ? "already at origin" : "pushed to origin"}; ` +
          `branch ${outcome.branch} ${outcome.alreadyPushed ? "already at that commit" : "pushed"}.`,
      );
    }
  }

  if (refusals.length > 0) {
    throw new Error(refusals.join("\n\n"));
  }

  return results;
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
  const matrixScope = parseHandoffMatrixScope(record.matrixScope);
  const matrixRows = parseHandoffMatrixRows(record.matrixRows);
  assertMatrixScopeAgreesWithRows(matrixScope, matrixRows);
  const handoff = {
    kind: record.kind,
    candidateVersion: version,
    subjects: record.subjects,
    artifacts,
    verifiedAt: String(record.verifiedAt ?? ""),
    matrixScope,
    ...(matrixRows ? { matrixRows } : {}),
    ...(record.matrixAuthorisation
      ? { matrixAuthorisation: record.matrixAuthorisation as MatrixAuthorisation }
      : {}),
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

/**
 * A handoff with no `matrixScope` is REFUSED, not treated as `"none"`.
 *
 * It is either a handoff written before this field existed, or one written by
 * something that does not know the field is required — and both mean the same
 * thing: nobody can say how this candidate was verified. Canon `e00fb7b8`:
 * "a release whose scope is not stated must not ship". Defaulting it here
 * would state a scope on the release's behalf, which is precisely the silent
 * degradation the ruling exists to prevent.
 */
function parseHandoffMatrixScope(value: unknown): MatrixScope {
  if (value === "full" || value === "subset" || value === "none") return value;

  throw new Error(
    [
      `Publish handoff carries no usable matrixScope (found ${JSON.stringify(value)}).`,
      "Re-run the gate with --matrix none | subset | full.",
      "",
      "This is not defaulted on purpose: an unstated scope must not ship (canon e00fb7b8),",
      "and a handoff is the artifact that carries the scope to the release summary and",
      "docs/src/data/releases.json.",
    ].join("\n"),
  );
}

function parseHandoffMatrixRows(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every(item => typeof item === "string")) {
    throw new Error("Publish handoff matrixRows must be a string array when present.");
  }
  return value as readonly string[];
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
    fileExists: dependencies.fileExists ?? (async filePath => existsSync(filePath)),
    writeHandoff: dependencies.writeHandoff ?? writeHandoffAtomically,
    sha256File: dependencies.sha256File ?? defaultSha256File,
    resolvePkgistCli: dependencies.resolvePkgistCli ?? resolvePkgistCli,
    resolveNpmCli: dependencies.resolveNpmCli ?? resolveNpmCli,
    resolvePnpmCli: dependencies.resolvePnpmCli ?? resolvePnpmCli,
    resolvePackageScript: dependencies.resolvePackageScript ?? resolveLocalPackageScript,
    runLocalGate: dependencies.runLocalGate ?? runLocalRegistryPreGate,
    now: dependencies.now ?? (() => new Date()),
    report: dependencies.report ?? (line => console.log(line)),
    sleep: dependencies.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))),
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

/**
 * Locate pnpm's own CLI entry, the same way `resolveNpmCli` locates npm's:
 * a real JS entry file, invoked directly with `process.execPath`, never
 * through `npx`/`pnpm exec` (that resolution failure mode is exactly what
 * this workspace forbids invoking directly).
 *
 * pnpm ships alongside node via corepack/the version manager as
 * `node_modules/pnpm/bin/pnpm.mjs`, sibling to `process.execPath` itself --
 * mirroring where `node_modules/npm` sits next to it.
 */
export function resolvePnpmCli(): string {
  const invokedByPnpm = process.env.npm_execpath;
  if (invokedByPnpm && path.isAbsolute(invokedByPnpm) && /pnpm(?:\.c?js|\.mjs)$/i.test(invokedByPnpm)) {
    return invokedByPnpm;
  }
  return path.resolve(path.dirname(process.execPath), "node_modules/pnpm/bin/pnpm.mjs");
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
  let reuseArtifacts = false;
  let only: readonly string[] | undefined;
  let matrixScope: MatrixScope | undefined;
  let authorisedBy: string | undefined;
  let authorisationDate: string | undefined;
  let authorisationQuote: string | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    if (argument === "--version") version = values[++index] ?? "";
    else if (argument.startsWith("--version=")) version = argument.slice("--version=".length);
    else if (argument === "--handoff") handoffPath = values[++index];
    else if (argument.startsWith("--handoff=")) handoffPath = argument.slice("--handoff=".length);
    else if (argument === "--reuse-artifacts") reuseArtifacts = true;
    else if (argument === "--only") only = parseOnlyArgument(values[++index]);
    else if (argument.startsWith("--only=")) only = parseOnlyArgument(argument.slice("--only=".length));
    else if (argument === "--matrix") matrixScope = parseMatrixScope(values[++index]);
    else if (argument.startsWith("--matrix=")) matrixScope = parseMatrixScope(argument.slice("--matrix=".length));
    else if (argument === "--authorised-by") authorisedBy = values[++index];
    else if (argument.startsWith("--authorised-by=")) authorisedBy = argument.slice("--authorised-by=".length);
    else if (argument === "--authorisation-date") authorisationDate = values[++index];
    else if (argument.startsWith("--authorisation-date=")) authorisationDate = argument.slice("--authorisation-date=".length);
    else if (argument === "--authorisation") authorisationQuote = values[++index];
    else if (argument.startsWith("--authorisation=")) authorisationQuote = argument.slice("--authorisation=".length);
    else throw new Error(`Unknown release-family argument: ${argument}.`);
  }
  assertExactVersion(version);

  // Assembled only when SOMETHING was given: a half-filled authorisation is
  // reported by `assertMatrixScopeIsStated` naming the missing piece, rather
  // than silently becoming "no authorisation" and producing the wrong refusal.
  const matrixAuthorisation =
    authorisedBy !== undefined || authorisationDate !== undefined || authorisationQuote !== undefined
      ? {
          authorisedBy: authorisedBy ?? "",
          date: authorisationDate ?? "",
          quote: authorisationQuote ?? "",
        }
      : undefined;

  return {
    mode,
    version,
    handoffPath,
    reuseArtifacts: reuseArtifacts || undefined,
    matrixScope,
    only,
    matrixAuthorisation,
  };
}

function parseMatrixScope(raw: string | undefined): MatrixScope {
  if (raw === "full" || raw === "subset" || raw === "none") return raw;
  throw new Error(`--matrix must be one of none | subset | full; got "${raw ?? ""}".`);
}

function parseOnlyArgument(raw: string | undefined): string[] {
  const names = (raw ?? "")
    .split(",")
    .map(name => name.trim())
    .filter(name => name.length > 0);
  if (names.length === 0) {
    throw new Error("--only requires at least one feature name (comma-separated).");
  }
  return names;
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
