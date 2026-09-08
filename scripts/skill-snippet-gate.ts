/**
 * Skill-snippet compile gate.
 *
 * ## Why this exists
 *
 * Our published skills taught the *previous major version's* handler
 * signature. Fixing that let TypeScript see those examples for the first
 * time, and four further defects fell out that no grep would have found —
 * including every validated file upload typing as `unknown` and
 * `warlock create.controller` generating code that does not compile.
 *
 * A snippet that cannot be compiled cannot be proven wrong in public. So this
 * gate's bar is NOT "the signature looks current" — it is **extractable and
 * compilable as written**. It:
 *
 *   1. Derives its subject list from the filesystem — every `skills/**\/SKILL.md`
 *      under a workspace package (a directory with both `package.json` and a
 *      `skills/` folder), never a hardcoded list.
 *   2. Extracts every fenced ```ts / ```tsx block from each skill.
 *   3. Compiles the ones that look like real files against the REAL
 *      declarations — each package's own `src/index.ts`, resolved through an
 *      absolute-path `paths` map, the same mechanism `core/tsconfig.typecheck.json`,
 *      `web/tsconfig.typecheck.json`, and the reference app `v5/app/tsconfig.json`
 *      already use in this repo.
 *   4. Reports pass/fail per snippet with the compiler's own error text.
 *   5. Exits non-zero on any failure.
 *
 * ## Partial vs. broken — the design decision this file must not hide
 *
 * Not every fenced block is a complete file. A three-line body fragment
 * ("here's what goes inside the handler") has no imports by design and was
 * never meant to compile alone. But a block that DOES claim to be a real file
 * — it carries a docs `title="path/to/file.ts"` — has no such excuse: if it
 * can't compile, the reader can't paste it and get working code.
 *
 * So the rule is:
 *
 *   - A block with a path-shaped `title="..."` attribute is a claimed real
 *     file. It is ALWAYS compiled, imports or not. This is what catches "no
 *     import lines at all, its types and helpers all undefined" — a titled
 *     handler snippet with no imports is exactly the shape of that defect,
 *     and this rule does not exempt it.
 *   - An untitled block IS compiled if it contains at least one `import`
 *     statement — the author chose to show a self-contained unit.
 *   - An untitled block with no `import` at all is treated as a deliberate
 *     fragment and SKIPPED (counted, but not pass/failed).
 *
 * What this lets through uncaught: an untitled, import-free fragment that
 * happens to reference an undefined helper (e.g. a snippet showing three
 * lines of a controller body that calls `someHelper()` never imported
 * anywhere). That fragment shape is common and deliberate throughout these
 * skills (see e.g. `core/skills/upload-file/SKILL.md`'s "Image processing
 * pipeline" example), so compiling it would fail almost every skill on
 * content that was never meant to stand alone. The line drawn here is
 * "claims to be a file (titled) or claims to be self-sufficient (has
 * imports)" — anything short of that claim is not held to the compile bar.
 *
 * ## Where compilation happens
 *
 * Each compiled skill gets an ISOLATED directory under
 * `<repoRoot>/.skill-snippet-gate-tmp/<package>/<skill-slug>/`, populated with
 * one real file per compiled block at its `title=` path (or a synthetic
 * `__untitled/block-N.ts` for untitled-but-import-bearing blocks). This
 * directory sits under the repo root so `@mongez/*` third-party types resolve
 * through the ROOT `node_modules` (pnpm's `publicHoistPattern` hoists
 * `@mongez/*` and `@types/*` there — see `pnpm-workspace.yaml`).
 *
 * A generated `tsconfig.json` is written into that directory (not merely held
 * in memory) and is what gets compiled — see the "known-freshness" note in
 * `runSkillSnippetGate`'s return value. It does NOT use `extends`: TypeScript
 * re-resolves an extended config's relative `paths`/`baseUrl` against the
 * BASE file's own directory in ways that are easy to get subtly wrong when
 * the extending file lives somewhere else entirely. Instead every
 * `@warlock.js/*` package is mapped by an ABSOLUTE path straight at that
 * package's `src/index.ts` — computed from the SAME filesystem discovery this
 * gate uses for its subject list, so it can never drift from what packages
 * actually exist. `app/*` and `web/*` — the app-scaffold aliases every
 * controller/schema example is written against — map to that skill's own
 * isolated `src/app/*` and `src/web/*`, exactly mirroring the real
 * `v5/app/tsconfig.json` alias shape. This is what catches defect #1 from the
 * card: a controller titled to live at `src/app/uploads/controllers/x.ts`
 * importing `"../schema/upload-avatar.schema"` fails to resolve — a real
 * "Cannot find module" — when no sibling block in that same skill was titled
 * that path.
 *
 * Deliberately NOT covered by compilation: the same type documented at two
 * different app paths across DIFFERENT skills (defect #3 from the card).
 * Compiling each skill in its own isolated directory cannot see across
 * skills. `findCrossSkillTypePathConflicts` below is a separate, explicitly
 * heuristic, non-compiler check for exactly that case — it walks every
 * COMPILED block's title path, looks for `export type X` / `export interface
 * X`, and flags any name whose title path is not the same across every skill
 * that documents it. It is intentionally simple (no import resolution, no
 * structural comparison) and reported separately from compiler diagnostics.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** builder/scripts -> builder -> repo root. */
export const REPO_ROOT = path.resolve(__dirname, "..", "..");
export const GATE_TMP_DIR_NAME = ".skill-snippet-gate-tmp";

export interface WorkspacePackage {
  /** Directory name at the repo root, e.g. "core". */
  dir: string;
  /** Absolute path to the package directory. */
  absPath: string;
  /** package.json "name" field, e.g. "@warlock.js/core" or "create-warlock". */
  name: string;
}

export interface DiscoveredSkill {
  package: WorkspacePackage;
  /** Absolute path to SKILL.md. */
  filePath: string;
  /** Slug: the skills/-relative directory path, e.g. "upload-file". */
  slug: string;
}

export type BlockLang = "ts" | "tsx";

export interface ExtractedBlock {
  skill: DiscoveredSkill;
  /** 0-based index of this fenced block within its SKILL.md. */
  index: number;
  lang: BlockLang;
  /** Raw info string after the language tag on the opening fence line. */
  info: string;
  body: string;
  /** 1-based line number of the opening fence, for locating the block by hand. */
  line: number;
  /** Path-shaped `title="..."` attribute, if present and valid. */
  titlePath?: string;
}

export type ClassifiedBlock =
  | { kind: "compile"; block: ExtractedBlock; virtualPath: string; reason: "titled" | "untitled-with-import" }
  | { kind: "skip"; block: ExtractedBlock; reason: string };

export interface CompiledFileResult {
  virtualPath: string;
  absolutePath: string;
  block: ExtractedBlock;
  diagnostics: string[];
}

export interface SkillCompileResult {
  skill: DiscoveredSkill;
  skillRoot: string;
  tsconfigPath: string;
  files: CompiledFileResult[];
  skipped: Array<{ block: ExtractedBlock; reason: string }>;
  duplicateTitles: Array<{ block: ExtractedBlock; titlePath: string; syntheticPath: string }>;
}

export interface TypePathConflict {
  typeName: string;
  occurrences: Array<{ skill: DiscoveredSkill; titlePath: string }>;
}

export interface GateReport {
  packages: WorkspacePackage[];
  skills: DiscoveredSkill[];
  results: SkillCompileResult[];
  typePathConflicts: TypePathConflict[];
}

/** A `title="..."` value that plausibly names a real file, not prose. */
const PATH_LIKE_TITLE = /^[A-Za-z0-9_.\-/]+\.tsx?$/;

// "tsx" before "ts" in the alternation — "ts" alone would match the first two
// characters of a ```tsx fence and leave a stray "x" glued onto the info
// string, silently corrupting every tsx block's language tag.
const FENCE_RE = /```(tsx|ts)\b([^\n]*)\n([\s\S]*?)```/g;
const TITLE_ATTR_RE = /title\s*=\s*(?:"([^"]*)"|'([^']*)')/;

/**
 * Every top-level workspace directory that is a real package (has its own
 * `package.json`) AND ships skills (has a `skills/` directory). Filesystem
 * derived — nothing here is a hardcoded package list. Directories such as
 * `.claude`, `.codex`, `builder`, and the top-level `./skills` (the
 * workspace's own dev-only skill, not a shipped package skill) are excluded
 * automatically because they fail one half of that test.
 */
export function discoverPackages(repoRoot: string): WorkspacePackage[] {
  const packages: WorkspacePackage[] = [];
  for (const dir of readdirSync(repoRoot)) {
    const absPath = path.join(repoRoot, dir);
    if (!isDirectory(absPath)) continue;
    const packageJsonPath = path.join(absPath, "package.json");
    const skillsPath = path.join(absPath, "skills");
    if (!existsSync(packageJsonPath) || !isDirectory(skillsPath)) continue;
    const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: string };
    if (!manifest.name) continue;
    packages.push({ dir, absPath, name: manifest.name });
  }
  return packages.sort((a, b) => a.dir.localeCompare(b.dir));
}

/** Every `skills/**\/SKILL.md` under one package, filesystem derived. */
export function discoverSkillFiles(pkg: WorkspacePackage): DiscoveredSkill[] {
  const skillsRoot = path.join(pkg.absPath, "skills");
  const found: DiscoveredSkill[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const child = path.join(dir, name);
      if (isDirectory(child)) {
        walk(child);
      } else if (name === "SKILL.md") {
        const slug = path.relative(skillsRoot, dir).split(path.sep).join("/");
        found.push({ package: pkg, filePath: child, slug: slug || "." });
      }
    }
  };
  if (isDirectory(skillsRoot)) walk(skillsRoot);
  return found.sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Every fenced ```ts / ```tsx block in one SKILL.md. */
export function extractFencedBlocks(markdown: string, skill: DiscoveredSkill): ExtractedBlock[] {
  const blocks: ExtractedBlock[] = [];
  let index = 0;
  let match: RegExpExecArray | null;
  FENCE_RE.lastIndex = 0;
  while ((match = FENCE_RE.exec(markdown))) {
    const [, lang, info, body] = match;
    const line = markdown.slice(0, match.index).split("\n").length;
    const titleMatch = TITLE_ATTR_RE.exec(info);
    const rawTitle = titleMatch ? titleMatch[1] ?? titleMatch[2] ?? "" : undefined;
    const titlePath = rawTitle && PATH_LIKE_TITLE.test(rawTitle) ? rawTitle : undefined;
    blocks.push({ skill, index, lang: lang as BlockLang, info, body, line, titlePath });
    index += 1;
  }
  return blocks;
}

const HAS_IMPORT_RE = /^\s*import\s/m;

/**
 * "Partial vs. broken" heuristic — see the file header for the full
 * rationale. A titled block is always compiled (it claims to BE a file). An
 * untitled block is compiled only if it contains an import (it claims to
 * stand alone). Everything else is a fragment and is skipped, not failed.
 */
export function classifyBlock(block: ExtractedBlock): ClassifiedBlock {
  if (block.titlePath) {
    return { kind: "compile", block, virtualPath: normalizeVirtualPath(block.titlePath), reason: "titled" };
  }
  if (HAS_IMPORT_RE.test(block.body)) {
    const ext = block.lang === "tsx" ? "tsx" : "ts";
    return {
      kind: "compile",
      block,
      virtualPath: `__untitled/block-${block.index}.${ext}`,
      reason: "untitled-with-import",
    };
  }
  return { kind: "skip", block, reason: "untitled fragment with no import statement" };
}

function normalizeVirtualPath(titlePath: string): string {
  return titlePath.replace(/^\.\//, "");
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Builds the isolated compile unit for one skill: which files get written
 * where, resolving duplicate `title=` paths within the SAME skill (two
 * blocks that both claim to be `src/config/http.ts`, for example — real
 * cases exist, e.g. `core/skills/health-checks/SKILL.md`) by keeping the
 * first occurrence at its real path and routing the rest to a synthetic
 * path so neither is silently dropped nor allowed to overwrite the other.
 */
export function planSkillCompileUnit(
  skill: DiscoveredSkill,
  blocks: ExtractedBlock[],
): {
  files: Map<string, ExtractedBlock>;
  skipped: Array<{ block: ExtractedBlock; reason: string }>;
  duplicateTitles: Array<{ block: ExtractedBlock; titlePath: string; syntheticPath: string }>;
} {
  const files = new Map<string, ExtractedBlock>();
  const skipped: Array<{ block: ExtractedBlock; reason: string }> = [];
  const duplicateTitles: Array<{ block: ExtractedBlock; titlePath: string; syntheticPath: string }> = [];

  for (const block of blocks) {
    const classified = classifyBlock(block);
    if (classified.kind === "skip") {
      skipped.push({ block, reason: classified.reason });
      continue;
    }
    let virtualPath = classified.virtualPath;
    if (files.has(virtualPath)) {
      const ext = block.lang === "tsx" ? "tsx" : "ts";
      const synthetic = `__duplicate-title/block-${block.index}.${ext}`;
      duplicateTitles.push({ block, titlePath: virtualPath, syntheticPath: synthetic });
      virtualPath = synthetic;
    }
    files.set(virtualPath, block);
  }
  return { files, skipped, duplicateTitles };
}

/**
 * Absolute-path `@warlock.js/*` map, derived from the SAME package discovery
 * the subject list uses — never hand-listed, so it cannot drift from what
 * packages actually exist.
 */
function buildPackagePaths(packages: WorkspacePackage[]): Record<string, string[]> {
  const paths: Record<string, string[]> = {};
  for (const pkg of packages) {
    const entry = path.join(pkg.absPath, "src", "index.ts");
    if (existsSync(entry)) {
      paths[pkg.name] = [toPosix(entry)];
    }
  }
  return paths;
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/**
 * Only `@warlock.js/*` gets a `paths` entry — absolute, derived from the same
 * package discovery the subject list uses. `app/*` and `web/*` are NOT a
 * `paths` wildcard here: a wildcard target is one fixed directory for the
 * whole program, and this gate compiles every skill's files in ONE shared
 * program (see `compileManySkills`), so a single `app/*` target would let
 * skill A's `app/…` import silently resolve to skill B's file of the same
 * relative name — masking exactly the "file does not exist" defect this gate
 * exists to catch. Instead `createCombinedHost` below resolves `app/*` /
 * `web/*` per FILE, scoped to that file's own isolated skill directory.
 */
function buildTsconfig(packages: WorkspacePackage[]): object {
  return {
    compilerOptions: {
      target: "ES2022",
      lib: ["ES2022", "DOM", "DOM.Iterable"],
      module: "ESNext",
      moduleResolution: "Bundler",
      jsx: "react-jsx",
      strict: true,
      esModuleInterop: true,
      resolveJsonModule: true,
      skipLibCheck: true,
      noEmit: true,
      types: ["node"],
      baseUrl: ".",
      paths: buildPackagePaths(packages),
    },
    include: ["**/*.ts", "**/*.tsx"],
  };
}

interface WrittenSkillUnit {
  skill: DiscoveredSkill;
  skillRoot: string;
  tsconfigPath: string;
  written: Array<{ virtualPath: string; absolutePath: string; block: ExtractedBlock }>;
  skipped: Array<{ block: ExtractedBlock; reason: string }>;
  duplicateTitles: Array<{ block: ExtractedBlock; titlePath: string; syntheticPath: string }>;
}

/**
 * Writes one skill's isolated compile unit to disk: every compiled block at
 * its virtual path, plus a `tsconfig.json` — kept per-skill purely as
 * evidence a human (or a future `--only` per-skill CLI run) can point `tsc`
 * at directly; the actual gate run compiles from `compileManySkills` below,
 * which reads its OWN shared config, not this one.
 */
function writeSkillUnit(skill: DiscoveredSkill, packages: WorkspacePackage[], gateTmpRoot: string): WrittenSkillUnit {
  const markdown = readFileSync(skill.filePath, "utf8");
  const blocks = extractFencedBlocks(markdown, skill);
  const { files, skipped, duplicateTitles } = planSkillCompileUnit(skill, blocks);

  const skillRoot = path.join(gateTmpRoot, skill.package.dir, skill.slug.replace(/[\\/]/g, "__"));
  rmSync(skillRoot, { recursive: true, force: true });
  mkdirSync(skillRoot, { recursive: true });

  const written: Array<{ virtualPath: string; absolutePath: string; block: ExtractedBlock }> = [];
  for (const [virtualPath, block] of files) {
    const absolutePath = path.join(skillRoot, ...virtualPath.split("/"));
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, block.body, "utf8");
    written.push({ virtualPath, absolutePath, block });
  }

  const tsconfigPath = path.join(skillRoot, "tsconfig.json");
  writeFileSync(tsconfigPath, `${JSON.stringify(buildTsconfig(packages), null, 2)}\n`, "utf8");

  return { skill, skillRoot, tsconfigPath, written, skipped, duplicateTitles };
}

function normalizeForCompare(p: string): string {
  return path.resolve(p).toLowerCase();
}

/**
 * Given a file somewhere under `<gateTmpRoot>/<package>/<skillDir>/…`,
 * returns `<gateTmpRoot>/<package>/<skillDir>` — that file's own isolated
 * skill directory, and the root `app/*` / `web/*` resolve against.
 */
function skillRootForFile(gateTmpRoot: string, fileName: string): string | undefined {
  const relative = path.relative(gateTmpRoot, fileName);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  const [pkgDir, skillDir] = relative.split(path.sep);
  if (!pkgDir || !skillDir) return undefined;
  return path.join(gateTmpRoot, pkgDir, skillDir);
}

const APP_ALIAS_CANDIDATES: ReadonlyArray<readonly [string, ts.Extension]> = [
  [".ts", ts.Extension.Ts],
  [".tsx", ts.Extension.Tsx],
  ["/index.ts", ts.Extension.Ts],
  ["/index.tsx", ts.Extension.Tsx],
];

function resolveAppAlias(moduleName: string, containingFile: string, gateTmpRoot: string): ts.ResolvedModuleFull | undefined {
  if (!moduleName.startsWith("app/") && !moduleName.startsWith("web/")) return undefined;
  const skillRoot = skillRootForFile(gateTmpRoot, containingFile);
  if (!skillRoot) return undefined;
  const candidateBase = path.join(skillRoot, "src", moduleName);
  for (const [suffix, extension] of APP_ALIAS_CANDIDATES) {
    const candidate = candidateBase + suffix;
    if (existsSync(candidate)) {
      return { resolvedFileName: candidate, extension, isExternalLibraryImport: false };
    }
  }
  return undefined;
}

/**
 * A process-lifetime `SourceFile` cache keyed by absolute file path. Every
 * compiled skill shares the same handful of `@warlock.js/*` package trees
 * (and the same lib.d.ts / node_modules type packages) — reusing their
 * parsed ASTs across repeated `compileManySkills` calls (e.g. across the
 * unit tests, which each build a small isolated fixture) avoids re-parsing
 * them from scratch every time. Files under `gateTmpRoot` are NEVER
 * cached — those are exactly the files a run just (re)wrote, and a stale
 * cache entry there would mean re-running the gate could report a pass that
 * was never re-derived from what is actually on disk, which is the
 * "type-checked stale copies" failure mode this gate exists to avoid.
 */
const sharedSourceFileCache = new Map<string, ts.SourceFile>();

function createCombinedHost(options: ts.CompilerOptions, gateTmpRoot: string): ts.CompilerHost {
  const host = ts.createCompilerHost(options, true);
  const gateTmpNormalized = normalizeForCompare(gateTmpRoot);

  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
    const cacheable = !normalizeForCompare(fileName).startsWith(gateTmpNormalized);
    if (cacheable && !shouldCreateNewSourceFile) {
      const cached = sharedSourceFileCache.get(fileName);
      if (cached) return cached;
    }
    const sourceFile = originalGetSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile);
    if (cacheable && sourceFile) sharedSourceFileCache.set(fileName, sourceFile);
    return sourceFile;
  };

  host.resolveModuleNames = (moduleNames, containingFile) =>
    moduleNames.map((moduleName) => {
      const alias = resolveAppAlias(moduleName, containingFile, gateTmpRoot);
      if (alias) return alias;
      return ts.resolveModuleName(moduleName, containingFile, options, host).resolvedModule;
    });

  return host;
}

function formatDiagnostic(diagnostic: ts.Diagnostic): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  const file = diagnostic.file;
  const position = file && diagnostic.start !== undefined ? file.getLineAndCharacterOfPosition(diagnostic.start) : undefined;
  const location = position ? `(${position.line + 1},${position.character + 1})` : "";
  const fileLabel = file ? path.basename(file.fileName) : "";
  return `${fileLabel}${location}: error TS${diagnostic.code}: ${message}`;
}

/**
 * Compiles every given skill's isolated files in ONE shared TypeScript
 * program — see the header comment and `createCombinedHost` for why this is
 * both correct (each skill still only sees its own `app/*` / `web/*` files)
 * and far cheaper than one `ts.createProgram` per skill (each of which would
 * otherwise re-bind and re-check the entire `@warlock.js/*` dependency graph
 * from scratch). Writing to disk first — and reading that write back with
 * `ts.parseJsonConfigFileContent` before compiling — is deliberate: it is
 * what makes "compiled what it extracted" checkable after the fact, not
 * merely asserted. Every written path is returned on every result so a stale
 * run is detectable by inspecting them.
 */
export function compileManySkills(skills: DiscoveredSkill[], packages: WorkspacePackage[], gateTmpRoot: string): SkillCompileResult[] {
  const units = skills.map((skill) => writeSkillUnit(skill, packages, gateTmpRoot));
  const allWritten = units.flatMap((u) => u.written);

  let diagnosticsByFile = new Map<string, string[]>();
  if (allWritten.length > 0) {
    const sharedTsconfigPath = path.join(gateTmpRoot, "tsconfig.json");
    writeFileSync(sharedTsconfigPath, `${JSON.stringify(buildTsconfig(packages), null, 2)}\n`, "utf8");
    const configFile = ts.readConfigFile(sharedTsconfigPath, ts.sys.readFile);
    if (configFile.error) {
      throw new Error(
        `Cannot read generated tsconfig at ${sharedTsconfigPath}: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n")}`,
      );
    }
    const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, gateTmpRoot);
    const host = createCombinedHost(parsed.options, gateTmpRoot);
    const program = ts.createProgram({ rootNames: allWritten.map((w) => w.absolutePath), options: parsed.options, host });
    const diagnostics = ts.getPreEmitDiagnostics(program);

    const gateTmpNormalized = normalizeForCompare(gateTmpRoot);
    for (const diagnostic of diagnostics) {
      if (!diagnostic.file) continue;
      const fileName = normalizeForCompare(diagnostic.file.fileName);
      // Only diagnostics against files INSIDE the gate's own tmp tree are
      // ours to report — a cascading error surfaced against a real
      // package's own source (e.g. a snippet passed it a wrong argument
      // type) is still attributed to the snippet that misused it, never to
      // the package source itself.
      if (!fileName.startsWith(gateTmpNormalized)) continue;
      const list = diagnosticsByFile.get(fileName) ?? [];
      list.push(formatDiagnostic(diagnostic));
      diagnosticsByFile.set(fileName, list);
    }
  }

  return units.map((unit) => ({
    skill: unit.skill,
    skillRoot: unit.skillRoot,
    tsconfigPath: unit.tsconfigPath,
    files: unit.written.map(({ virtualPath, absolutePath, block }) => ({
      virtualPath,
      absolutePath,
      block,
      diagnostics: diagnosticsByFile.get(normalizeForCompare(absolutePath)) ?? [],
    })),
    skipped: unit.skipped,
    duplicateTitles: unit.duplicateTitles,
  }));
}

/** Compiles a single skill. A thin wrapper over `compileManySkills` used by tests and any future per-skill CLI filter. */
export function compileSkill(skill: DiscoveredSkill, packages: WorkspacePackage[], gateTmpRoot: string): SkillCompileResult {
  return compileManySkills([skill], packages, gateTmpRoot)[0];
}

const EXPORTED_TYPE_RE = /export\s+(?:type|interface)\s+([A-Za-z_$][\w$]*)/g;

/**
 * Explicitly heuristic, non-compiler check for defect #3: the same type
 * documented at two different app paths across DIFFERENT skills. Walks every
 * COMPILED, TITLED block, collects `export type X` / `export interface X`
 * declarations, and flags any name whose title path is not identical across
 * every skill that declares it. No import graph, no structural comparison —
 * a same-named type at the same path in two skills is assumed to be the same
 * documented type; a same-named type at two different paths is flagged.
 */
export function findCrossSkillTypePathConflicts(results: SkillCompileResult[]): TypePathConflict[] {
  const byType = new Map<string, Array<{ skill: DiscoveredSkill; titlePath: string }>>();
  for (const result of results) {
    for (const file of result.files) {
      if (file.block.titlePath === undefined) continue;
      EXPORTED_TYPE_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = EXPORTED_TYPE_RE.exec(file.block.body))) {
        const list = byType.get(match[1]) ?? [];
        list.push({ skill: result.skill, titlePath: file.virtualPath });
        byType.set(match[1], list);
      }
    }
  }
  const conflicts: TypePathConflict[] = [];
  for (const [typeName, occurrences] of byType) {
    const distinctSkills = new Set(occurrences.map((o) => o.skill.filePath));
    const distinctPaths = new Set(occurrences.map((o) => o.titlePath));
    if (distinctSkills.size > 1 && distinctPaths.size > 1) {
      conflicts.push({ typeName, occurrences });
    }
  }
  return conflicts.sort((a, b) => a.typeName.localeCompare(b.typeName));
}

export function runSkillSnippetGate(repoRoot: string): GateReport {
  const gateTmpRoot = path.join(repoRoot, GATE_TMP_DIR_NAME);
  rmSync(gateTmpRoot, { recursive: true, force: true });
  mkdirSync(gateTmpRoot, { recursive: true });

  const packages = discoverPackages(repoRoot);
  const skills = packages.flatMap((pkg) => discoverSkillFiles(pkg));
  const results = compileManySkills(skills, packages, gateTmpRoot);
  const typePathConflicts = findCrossSkillTypePathConflicts(results);

  return { packages, skills, results, typePathConflicts };
}

function formatReport(report: GateReport): { text: string; failed: boolean } {
  const lines: string[] = [];
  let totalBlocks = 0;
  let totalCompiled = 0;
  let totalSkipped = 0;
  let totalPassed = 0;
  let totalFailed = 0;
  const failures: string[] = [];

  lines.push(`skill-snippet-gate: ${report.packages.length} package(s) with skills, ${report.skills.length} SKILL.md file(s).`);
  lines.push(`packages: ${report.packages.map((p) => p.dir).join(", ")}`);
  lines.push("");

  for (const result of report.results) {
    const skillLabel = `${result.skill.package.dir}/skills/${result.skill.slug}`;
    totalSkipped += result.skipped.length;
    for (const file of result.files) {
      totalBlocks += 1;
      totalCompiled += 1;
      if (file.diagnostics.length === 0) {
        totalPassed += 1;
      } else {
        totalFailed += 1;
        failures.push(`FAIL ${skillLabel} :: ${file.virtualPath} (written to ${file.absolutePath})`);
        for (const d of file.diagnostics) failures.push(`    ${d}`);
      }
    }
    totalBlocks += result.skipped.length;
  }

  for (const conflict of report.typePathConflicts) {
    failures.push(
      `FAIL cross-skill-type-path :: "${conflict.typeName}" documented at ${new Set(conflict.occurrences.map((o) => o.titlePath)).size} different paths:`,
    );
    for (const occ of conflict.occurrences) {
      failures.push(`    ${occ.skill.package.dir}/skills/${occ.skill.slug} -> ${occ.titlePath}`);
    }
  }

  lines.push(
    `blocks found: ${totalBlocks} (ts/tsx fences only; see file header re. "typescript"-language fences being out of the literal scope this gate was asked for)`,
  );
  lines.push(`  compiled: ${totalCompiled} (passed ${totalPassed}, failed ${totalFailed})`);
  lines.push(`  skipped as deliberate fragments (no title, no import): ${totalSkipped}`);
  lines.push(`  cross-skill type/path conflicts: ${report.typePathConflicts.length}`);
  lines.push("");

  if (failures.length > 0) {
    lines.push("--- failures ---");
    lines.push(...failures);
  } else {
    lines.push("All compiled snippets passed.");
  }

  return { text: lines.join("\n"), failed: totalFailed > 0 || report.typePathConflicts.length > 0 };
}

async function main(): Promise<number> {
  const report = runSkillSnippetGate(REPO_ROOT);
  const { text, failed } = formatReport(report);
  console.log(text);
  return failed ? 1 : 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  main().then((code) => process.exit(code));
}
