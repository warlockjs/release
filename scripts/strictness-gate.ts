/**
 * Workspace strictness ratchet.
 *
 * Measurement: compile every discovered package with its own `tsconfig.json`,
 * while enforcing the shared strictness contract from `tsconfig.base.json`,
 * attribute diagnostics to the package that owns their source file, and
 * de-duplicate those diagnostics across the package compiles. This is the
 * single measurement used for both the report and allowances: it covers every
 * package a maintainer can compile alone, including docs. A package whose own
 * config did not list an owned source file is UNMEASURED and fails the gate.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, "..", "..");
const ALLOWANCES_PATH = path.join(__dirname, "strictness-allowances.jsonc");
const STRICTNESS_CONTRACT_PATH = path.join(REPO_ROOT, "tsconfig.base.json");
const TSC_PATH = path.join(REPO_ROOT, "node_modules", ".pnpm", "typescript@5.9.3", "node_modules", "typescript", "bin", "tsc");
const STRICTNESS_OPTIONS = ["strict", "noUncheckedIndexedAccess", "forceConsistentCasingInFileNames"] as const;

export type WorkspacePackage = { dir: string; path: string };
export type OwnedDiagnostic = { file: string; line: number; code: number };
export type Measurement = { diagnostics: Map<string, OwnedDiagnostic[]>; covered: Set<string> };

function isDirectory(filePath: string): boolean {
  try { return statSync(filePath).isDirectory(); } catch { return false; }
}

/** Every source package with a TypeScript config; builder is deliberately absent. */
export function discoverPackages(repoRoot = REPO_ROOT): WorkspacePackage[] {
  return readdirSync(repoRoot)
    .map((dir) => ({ dir, path: path.join(repoRoot, dir) }))
    .filter((pkg) => isDirectory(pkg.path) && existsSync(path.join(pkg.path, "src")) && existsSync(path.join(pkg.path, "tsconfig.json")))
    .sort((a, b) => a.dir.localeCompare(b.dir));
}

export function readAllowances(filePath = ALLOWANCES_PATH): Record<string, number> {
  const parsed = ts.parseConfigFileTextToJson(filePath, readFileSync(filePath, "utf8"));
  if (parsed.error || !parsed.config || typeof parsed.config !== "object") throw new Error(`Cannot read strictness allowances at ${filePath}.`);
  return parsed.config as Record<string, number>;
}

/** The common strictness contract overrides only these options on every package compile. */
export function sharedStrictnessArgs(filePath = STRICTNESS_CONTRACT_PATH): string[] {
  const parsed = ts.parseConfigFileTextToJson(filePath, readFileSync(filePath, "utf8"));
  const options = parsed.config?.compilerOptions;
  if (parsed.error || !options || typeof options !== "object") throw new Error(`Cannot read strictness contract at ${filePath}.`);
  return STRICTNESS_OPTIONS.flatMap((option) => {
    if (options[option] !== true) throw new Error(`Strictness contract must enable '${option}'.`);
    return [`--${option}`, "true"];
  });
}

function normalizeFile(filePath: string, base = REPO_ROOT): string {
  return path.resolve(base, filePath.replace(/\\/g, "/")).replace(/\\/g, "/");
}

function ownerOf(filePath: string, packages: WorkspacePackage[], base?: string): WorkspacePackage | undefined {
  const normalized = normalizeFile(filePath, base);
  return packages.find((pkg) => normalized === normalizeFile(pkg.path) || normalized.startsWith(`${normalizeFile(pkg.path)}/`));
}

function extractDiagnostic(line: string): { file: string; line: number; code: number } | undefined {
  const match = /^(.*)\((\d+),(\d+)\): error TS(\d+):/.exec(line.replace(/\\/g, "/"));
  if (!match) return undefined;
  return { file: match[1], line: Number(match[2]), code: Number(match[4]) };
}

/** Runs each package's own config with the shared strictness contract, proving coverage with TypeScript's file list. */
export function collectOwnedDiagnostics(packages: WorkspacePackage[]): Measurement {
  if (!existsSync(TSC_PATH)) throw new Error(`Pinned TypeScript binary is missing: ${TSC_PATH}`);
  const diagnostics = new Map(packages.map((pkg) => [pkg.dir, new Map<string, OwnedDiagnostic>()]));
  const covered = new Set<string>();
  const compiles = packages.map((pkg) => ({ path: pkg.path, coverage: pkg }));
  const strictnessArgs = sharedStrictnessArgs();
  for (const compile of compiles) {
    const result = spawnSync(process.execPath, [TSC_PATH, "-p", "tsconfig.json", "--noEmit", "--pretty", "false", "--listFiles", ...strictnessArgs], { cwd: compile.path, encoding: "utf8" });
    if (result.error) throw result.error;
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    for (const rawLine of output.split(/\r?\n/)) {
      const candidate = rawLine.trim();
      if (compile.coverage && ownerOf(candidate, [compile.coverage], compile.path)) covered.add(compile.coverage.dir);
      const parsed = extractDiagnostic(candidate);
      if (!parsed) continue;
      const owner = ownerOf(parsed.file, packages, compile.path);
      if (!owner) continue;
      const diagnostic: OwnedDiagnostic = { file: path.relative(REPO_ROOT, normalizeFile(parsed.file, compile.path)).replace(/\\/g, "/"), line: parsed.line, code: parsed.code };
      diagnostics.get(owner.dir)?.set(`${diagnostic.file}:${diagnostic.line}:${diagnostic.code}`, diagnostic);
    }
  }
  return { diagnostics: new Map([...diagnostics].map(([dir, entries]) => [dir, [...entries.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.code - b.code)])), covered };
}

export function formatReport(packages: WorkspacePackage[], allowances: Record<string, number>, measurement: Measurement): { text: string; failed: boolean } {
  const lines = ["strictness-gate: owned diagnostics / allowance"];
  let failed = false;
  for (const pkg of packages) {
    if (!measurement.covered.has(pkg.dir)) { lines.push(`  ${pkg.dir}: UNMEASURED`); failed = true; continue; }
    const allowance = allowances[pkg.dir];
    if (allowance === undefined) throw new Error(`No allowance recorded for measured package '${pkg.dir}'.`);
    const count = measurement.diagnostics.get(pkg.dir)?.length ?? 0;
    const over = count - allowance;
    lines.push(`  ${pkg.dir}: ${count} / ${allowance}${over > 0 ? ` OVER by ${over}` : " OK"}`);
    if (over > 0) failed = true;
  }
  return { text: lines.join("\n"), failed };
}

function selectedPackages(packages: WorkspacePackage[], args: string[]): WorkspacePackage[] {
  if (args.length === 0) return packages;
  if (args.length !== 2 || args[0] !== "--package") throw new Error("Usage: strictness-gate.ts [--package <package>]");
  const pkg = packages.find(({ dir }) => dir === args[1]);
  if (!pkg) throw new Error(`'${args[1]}' is not a measured package.`);
  return [pkg];
}

async function main(): Promise<number> {
  const allPackages = discoverPackages();
  const packages = selectedPackages(allPackages, process.argv.slice(2));
  const report = formatReport(packages, readAllowances(), collectOwnedDiagnostics(packages));
  console.log(report.text);
  return report.failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) main().then((code) => process.exit(code)).catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
