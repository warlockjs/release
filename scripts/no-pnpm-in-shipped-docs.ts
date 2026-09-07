/**
 * Shipped-docs package-manager gate.
 *
 * ## Why this exists
 *
 * `skills/**` and `llms.txt` / `llms-full.txt` ship INSIDE the published
 * tarballs — they are documentation users receive, not internal notes. This
 * workspace's own tooling is pnpm-only, but shipped docs must work for an
 * npm (or yarn) consumer too: `create-warlock` even offers a `--pm=npm`
 * flag. A doc that tells that user to run `pnpm warlock routes --json`
 * doesn't just look wrong — pnpm-specific invocation syntax (`pnpm
 * <binary>`) has no npm equivalent, so the command FAILS on their machine.
 *
 * Owner ruling: pnpm is for INTERNAL framework development. Shipped
 * documentation must not assume it.
 *
 * ## Why this is mechanical, not prose
 *
 * A rule that lives only in prose comes back — see the 5.4.0 release
 * postmortem: the JSONC rule was documented in `shadcn.feature.ts` and
 * ignored by `react-email.feature.ts`; the stdout/stderr rule was documented
 * for three functions and missed on a fourth. So this gate scans every
 * shipped doc file directly and fails, naming file and line, on any bare
 * `pnpm <anything>` / `yarn <anything>` invocation it finds — no matter how
 * carefully the prose elsewhere says "use npx".
 *
 * ## The allowlist is a decision, not an escape hatch
 *
 * Some doc line may show a genuine pnpm-workspace-only operation with no npm
 * equivalent (e.g. documenting THIS repo's own internal release tooling,
 * rather than something a consumer of the published package runs). Silently
 * excluding a whole file would hide future additions to it. Instead each
 * exception is a single `{ file, line, reason }` entry below — recorded,
 * reviewable, and pinned to an exact line so an unrelated edit to that file
 * does not silently inherit the exemption.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** builder/scripts -> builder -> repo root. */
export const REPO_ROOT = path.resolve(__dirname, "..", "..");

export interface DocFile {
  /** Absolute path to the file. */
  absPath: string;
  /** Repo-root-relative path, posix-separated, for stable reporting. */
  relPath: string;
}

export interface Violation {
  relPath: string;
  /** 1-based line number. */
  line: number;
  /** The offending line, trimmed. */
  text: string;
  /** Which manager the line invoked ("pnpm" or "yarn"). */
  manager: "pnpm" | "yarn";
}

/**
 * Deliberate exceptions: a genuine pnpm/yarn-workspace-only operation with no
 * npm equivalent, documented as such. Each entry is scoped to one exact file
 * + line, so it never silently exempts a whole file from future scrutiny.
 *
 * Empty today — every occurrence found at authoring time had a valid npm
 * translation (see the four shapes in the fix-up card). Add here, with a
 * reason, the day a real exception appears.
 */
export const ALLOWLIST: ReadonlyArray<{ relPath: string; line: number; reason: string }> = [
  // Example shape (not a real exception):
  // { relPath: "core/skills/example/SKILL.md", line: 42, reason: "documents this repo's own internal pnpm workspace release step, not something a consumer of the published package runs" },

  // core/skills/run-app/SKILL.md — a historical bugfix note and a live
  // troubleshooting section that are BOTH genuinely pnpm-specific: the
  // hoisting difference that caused a 4.9.2 bug, and pnpm 10+'s own
  // install-script gating quirk. Neither is an instruction to use pnpm —
  // they only fire for a reader who already is. No npm translation exists
  // because npm never had either behavior. llms-full.txt mirrors these at
  // different line numbers because it's a generated concatenation of every
  // skill in the package (see generate-llms.mjs) — allowlisted at its own
  // lines too, not exempted as a whole file.
  { relPath: "core/skills/run-app/SKILL.md", line: 108, reason: "historical bugfix note scoped to pnpm's hoisting behavior; no npm equivalent because npm never had the bug" },
  { relPath: "core/skills/run-app/SKILL.md", line: 109, reason: "same note — mentions yarn/pnpm hoisting behavior as history, not an instruction" },
  { relPath: "core/skills/run-app/SKILL.md", line: 259, reason: "pnpm 10+'s own install-script gating is pnpm-specific troubleshooting; npm has no equivalent gate to document" },
  { relPath: "core/skills/run-app/SKILL.md", line: 274, reason: "same pnpm-specific troubleshooting section, explaining where pnpm reads the allowlist from" },
  { relPath: "core/llms-full.txt", line: 3385, reason: "generated mirror of core/skills/run-app/SKILL.md:108 — see that entry" },
  { relPath: "core/llms-full.txt", line: 3386, reason: "generated mirror of core/skills/run-app/SKILL.md:109 — see that entry" },
  { relPath: "core/llms-full.txt", line: 3536, reason: "generated mirror of core/skills/run-app/SKILL.md:259 — see that entry" },
  { relPath: "core/llms-full.txt", line: 3551, reason: "generated mirror of core/skills/run-app/SKILL.md:274 — see that entry" },

  // core/skills/update-packages/SKILL.md — a reference table documenting
  // `warlock update`'s REAL lockfile-detection behavior across every
  // package manager it actually supports (bun/npm/yarn/pnpm). The pnpm and
  // yarn rows are what the tool does, not an instruction to adopt either —
  // collapsing them to npm would misdescribe the feature.
  { relPath: "core/skills/update-packages/SKILL.md", line: 46, reason: "reference table row describing warlock update's real yarn.lock handling, not an instruction to use yarn" },
  { relPath: "core/skills/update-packages/SKILL.md", line: 47, reason: "reference table row describing warlock update's real pnpm-lock.yaml handling, not an instruction to use pnpm" },
  { relPath: "core/skills/update-packages/SKILL.md", line: 50, reason: "prose explaining the same lockfile-detection precedence; mentions yarn as a noun, not a command to run" },
  { relPath: "core/llms-full.txt", line: 5583, reason: "generated mirror of core/skills/update-packages/SKILL.md:46 — see that entry" },
  { relPath: "core/llms-full.txt", line: 5584, reason: "generated mirror of core/skills/update-packages/SKILL.md:47 — see that entry" },
  { relPath: "core/llms-full.txt", line: 5587, reason: "generated mirror of core/skills/update-packages/SKILL.md:50 — see that entry" },

  // create-warlock/skills/create-a-warlock-project/SKILL.md — describes the
  // wizard's REAL interactive step 2, which genuinely offers yarn/pnpm as
  // choices when they're detected on the system. Not an instruction; a
  // description of what the tool asks.
  { relPath: "create-warlock/skills/create-a-warlock-project/SKILL.md", line: 31, reason: "describes the scaffolder's real interactive package-manager picker, which genuinely offers yarn/pnpm when detected" },
  { relPath: "create-warlock/llms-full.txt", line: 39, reason: "generated mirror of create-warlock/skills/create-a-warlock-project/SKILL.md:31 — see that entry" },
];

function isAllowlisted(relPath: string, line: number): boolean {
  return ALLOWLIST.some((entry) => entry.relPath === relPath && entry.line === line);
}

/** `pnpm <word>` or `yarn <word>` — a real invocation, not just the bare word "pnpm"/"yarn" appearing in prose. */
const INVOCATION_RE = /\b(pnpm|yarn)\s+[A-Za-z@.\-]/;

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/**
 * Discovers every shipped-doc file under the workspace root: each package's
 * `skills/**\/*.md` and its `llms.txt` / `llms-full.txt` — one directory
 * level down from the root, mirroring how each package ships its own
 * `skills/` folder and `llms*.txt` at its own package root.
 */
export function discoverDocFiles(repoRoot: string): DocFile[] {
  const found: DocFile[] = [];

  for (const dir of readdirSync(repoRoot)) {
    const pkgAbsPath = path.join(repoRoot, dir);
    if (!isDirectory(pkgAbsPath)) continue;
    if (dir === "node_modules" || dir.startsWith(".")) continue;

    for (const llmsName of ["llms.txt", "llms-full.txt"]) {
      const llmsPath = path.join(pkgAbsPath, llmsName);
      if (fileExists(llmsPath)) {
        found.push({ absPath: llmsPath, relPath: toPosix(path.relative(repoRoot, llmsPath)) });
      }
    }

    const skillsRoot = path.join(pkgAbsPath, "skills");
    if (!isDirectory(skillsRoot)) continue;
    walkMarkdown(skillsRoot, repoRoot, found);
  }

  return found.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function fileExists(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function walkMarkdown(dir: string, repoRoot: string, into: DocFile[]): void {
  for (const name of readdirSync(dir)) {
    const child = path.join(dir, name);
    if (isDirectory(child)) {
      walkMarkdown(child, repoRoot, into);
    } else if (name.endsWith(".md")) {
      into.push({ absPath: child, relPath: toPosix(path.relative(repoRoot, child)) });
    }
  }
}

/**
 * Pure matcher: scans one file's text for `pnpm <anything>` / `yarn
 * <anything>` invocations, returning file:line violations minus anything on
 * the ALLOWLIST. Exported standalone so unit tests can exercise it directly
 * on in-memory fixtures without touching the filesystem.
 */
export function findViolationsInText(relPath: string, text: string): Violation[] {
  const violations: Violation[] = [];
  const lines = text.split(/\r\n|\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = INVOCATION_RE.exec(line);
    if (!match) continue;

    const lineNumber = i + 1;
    if (isAllowlisted(relPath, lineNumber)) continue;

    violations.push({
      relPath,
      line: lineNumber,
      text: line.trim(),
      manager: match[1] as "pnpm" | "yarn",
    });
  }

  return violations;
}

export function findViolationsInFile(file: DocFile): Violation[] {
  const text = readFileSync(file.absPath, "utf8");
  return findViolationsInText(file.relPath, text);
}

export interface GateReport {
  files: DocFile[];
  violations: Violation[];
}

export function runNoPnpmInShippedDocsGate(repoRoot: string): GateReport {
  const files = discoverDocFiles(repoRoot);
  const violations = files.flatMap((file) => findViolationsInFile(file));
  return { files, violations };
}

function formatReport(report: GateReport): { text: string; failed: boolean } {
  const lines: string[] = [];
  lines.push(`no-pnpm-in-shipped-docs: scanned ${report.files.length} file(s) (skills/**/*.md, llms.txt, llms-full.txt).`);
  lines.push("");

  if (report.violations.length === 0) {
    lines.push("Clean — no pnpm/yarn invocations found in shipped docs.");
    return { text: lines.join("\n"), failed: false };
  }

  lines.push(`FAILED — ${report.violations.length} pnpm/yarn invocation(s) found in shipped docs:`);
  lines.push("");
  for (const v of report.violations) {
    lines.push(`  ${v.relPath}:${v.line}: [${v.manager}] ${v.text}`);
  }
  lines.push("");
  lines.push(
    "Shipped docs must not assume pnpm. Translate per the four shapes: " +
      "`pnpm warlock <cmd>` / `pnpm cascade <cmd>` -> `npx warlock <cmd>` / `npx cascade <cmd>`; " +
      "`pnpm add <pkg>` -> `npm install <pkg>`; `pnpm install` -> `npm install`; " +
      "`pnpm create warlock` -> `npm create warlock@latest`. " +
      "If a line is a genuine pnpm-workspace-only operation with no npm equivalent, " +
      "add a scoped { relPath, line, reason } entry to ALLOWLIST in this file.",
  );

  return { text: lines.join("\n"), failed: true };
}

async function main(): Promise<number> {
  const report = runNoPnpmInShippedDocsGate(REPO_ROOT);
  const { text, failed } = formatReport(report);
  console.log(text);
  return failed ? 1 : 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  main().then((code) => process.exit(code));
}
