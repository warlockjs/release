import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import pkgistConfig from "../pkgist.config.ts";

export const WARLOCK_FAMILY_NAME = "warlock";
export const WARLOCK_FAMILY_SIZE = 28;

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export type ConfiguredFamilyMember = {
  name: string;
  root: string;
};

export type WarlockFamilyDeclaration = {
  name: string;
  packages: readonly ConfiguredFamilyMember[];
};

export type PublishableManifest = {
  name: string;
  root: string;
  version: string;
};

export type WarlockFamilyMember = PublishableManifest & {
  configuredRoot: string;
};

export type WarlockFamily = {
  name: typeof WARLOCK_FAMILY_NAME;
  version: string;
  members: readonly WarlockFamilyMember[];
};

export type DeriveWarlockFamilyOptions = {
  workspaceRoot: string;
  configDir: string;
  declaration: WarlockFamilyDeclaration;
};

type PackageManifest = {
  name?: unknown;
  private?: unknown;
  version?: unknown;
};

/**
 * Discover the release family independently of pkgist.
 *
 * Only direct children of the workspace are inspected. The public scoped
 * packages and the unscoped scaffolder are members; private docs/builder
 * packages and nested fixtures are not.
 */
export async function scanTopLevelPublishableManifests(
  workspaceRoot: string,
): Promise<PublishableManifest[]> {
  const entries = await readdir(workspaceRoot, { withFileTypes: true });
  const manifests: PublishableManifest[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const root = path.resolve(workspaceRoot, entry.name);
    const manifestPath = path.join(root, "package.json");
    let source: string;

    try {
      source = await readFile(manifestPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }

    let manifest: PackageManifest;
    try {
      manifest = JSON.parse(source) as PackageManifest;
    } catch (error) {
      throw new Error(
        `Cannot parse top-level manifest ${manifestPath}: ${formatError(error)}`,
      );
    }

    if (manifest.private === true || !isWarlockPackageName(manifest.name)) {
      continue;
    }

    if (typeof manifest.version !== "string" || !EXACT_VERSION.test(manifest.version)) {
      throw new Error(
        `Publishable manifest ${manifestPath} must declare an exact semver version; ` +
          `found ${JSON.stringify(manifest.version)}.`,
      );
    }

    manifests.push({ name: manifest.name, root, version: manifest.version });
  }

  return manifests.sort((left, right) => compareText(left.name, right.name));
}

/**
 * Reconcile the filesystem-derived family with pkgist's authoritative release
 * declaration, then return the one deterministic publish order.
 *
 * The name/root/version checks deliberately precede the size assertion. A
 * matching count is not evidence that the two sources describe the same set.
 */
export async function deriveWarlockFamily({
  workspaceRoot,
  configDir,
  declaration,
}: DeriveWarlockFamilyOptions): Promise<WarlockFamily> {
  if (declaration.name !== WARLOCK_FAMILY_NAME) {
    throw new Error(
      `Expected pkgist family ${JSON.stringify(WARLOCK_FAMILY_NAME)}, ` +
        `found ${JSON.stringify(declaration.name)}.`,
    );
  }

  const discovered = await scanTopLevelPublishableManifests(workspaceRoot);
  const discoveredByName = uniqueByName(discovered, "filesystem");
  const configuredByName = uniqueByName(declaration.packages, "pkgist config");
  const semanticProblems: string[] = [];

  const missingFromConfig = [...discoveredByName.keys()]
    .filter(name => !configuredByName.has(name))
    .sort(compareText);
  const missingFromFilesystem = [...configuredByName.keys()]
    .filter(name => !discoveredByName.has(name))
    .sort(compareText);

  if (missingFromConfig.length > 0 || missingFromFilesystem.length > 0) {
    semanticProblems.push(
      `name-set mismatch (missing from pkgist: ${showNames(missingFromConfig)}; ` +
        `missing from filesystem: ${showNames(missingFromFilesystem)})`,
    );
  }

  for (const [name, manifest] of discoveredByName) {
    const configured = configuredByName.get(name);
    if (!configured) continue;

    const configuredRoot = path.resolve(configDir, configured.root);
    if (canonicalPath(configuredRoot) !== canonicalPath(manifest.root)) {
      semanticProblems.push(
        `root mismatch for ${name} (pkgist: ${configuredRoot}; filesystem: ${manifest.root})`,
      );
    }
  }

  const versions = new Map<string, string[]>();
  for (const manifest of discovered) {
    const names = versions.get(manifest.version) ?? [];
    names.push(manifest.name);
    versions.set(manifest.version, names);
  }
  if (versions.size !== 1) {
    semanticProblems.push(
      `lockstep version mismatch (${[...versions]
        .sort(([left], [right]) => compareText(left, right))
        .map(([version, names]) => `${version}: ${names.sort(compareText).join(", ")}`)
        .join("; ")})`,
    );
  }

  if (semanticProblems.length > 0) {
    throw new Error(`Warlock family reconciliation failed:\n- ${semanticProblems.join("\n- ")}`);
  }

  if (discovered.length !== WARLOCK_FAMILY_SIZE) {
    throw new Error(
      `Warlock family size invariant failed after name/root/version reconciliation: ` +
        `expected ${WARLOCK_FAMILY_SIZE}, found ${discovered.length}.`,
    );
  }

  const version = discovered[0]?.version;
  if (!version) throw new Error("Warlock family discovery returned no publishable manifests.");

  const members = discovered
    .map(manifest => ({
      ...manifest,
      configuredRoot: path.resolve(configDir, configuredByName.get(manifest.name)!.root),
    }))
    .sort(comparePublishOrder);

  return { name: WARLOCK_FAMILY_NAME, version, members };
}

/** Load and reconcile the real `warlock` declaration from pkgist.config.ts. */
export async function loadAuthoritativeWarlockFamily(
  workspaceRoot: string = path.resolve(import.meta.dirname, "../.."),
): Promise<WarlockFamily> {
  const configDir = path.resolve(import.meta.dirname, "..");
  const declaration = pkgistConfig.families?.find(
    family => family.name === WARLOCK_FAMILY_NAME,
  );

  if (!declaration) {
    throw new Error(`pkgist.config.ts has no ${JSON.stringify(WARLOCK_FAMILY_NAME)} family.`);
  }

  return deriveWarlockFamily({ workspaceRoot, configDir, declaration });
}

function isWarlockPackageName(name: unknown): name is string {
  return (
    name === "create-warlock" ||
    (typeof name === "string" && /^@warlock\.js\/[^/]+$/.test(name))
  );
}

function uniqueByName<T extends { name: string }>(
  values: readonly T[],
  source: string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    if (result.has(value.name)) {
      throw new Error(`Duplicate Warlock family name in ${source}: ${value.name}.`);
    }
    result.set(value.name, value);
  }
  return result;
}

function comparePublishOrder(left: WarlockFamilyMember, right: WarlockFamilyMember): number {
  const rankDifference = publishRank(left.name) - publishRank(right.name);
  if (rankDifference !== 0) return rankDifference;

  // Web depends on Core, so leaf-first ordering puts Web before Core in the
  // deliberately late pair. The scaffolder is always the final handoff.
  if (left.name === "@warlock.js/web" && right.name === "@warlock.js/core") return -1;
  if (left.name === "@warlock.js/core" && right.name === "@warlock.js/web") return 1;

  return compareText(left.name, right.name);
}

function publishRank(name: string): number {
  if (name === "create-warlock") return 2;
  if (name === "@warlock.js/core" || name === "@warlock.js/web") return 1;
  return 0;
}

function canonicalPath(value: string): string {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function showNames(names: readonly string[]): string {
  return names.length === 0 ? "none" : names.join(", ");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
