/**
 * Skill cross-reference gate.
 *
 * ## Why this exists
 *
 * An app's `postinstall` runs `agent-kit sync`, which copies every installed
 * package's skills into `.claude/skills/warlock-js-<pkg>/` and FLATTENS them:
 * `skills/<topic>/SKILL.md` becomes `<topic>.md`. A skill that points at
 * another one by path (`../send-response/SKILL.md`,
 * `@warlock.js/web/create-a-page/SKILL.md`, `../../../cache/skills/x/SKILL.md`)
 * therefore points at nothing inside the app, and the agent reading it is
 * sent to node_modules instead. The 2026-10-01 skills audit found ~900 such
 * references across six packages.
 *
 * The convention is to name the topic: "the `send-response` topic", and across
 * packages "the `pick-cache-driver` topic of the `warlock-js-cache` skill".
 * This gate fails, naming file and line, on any `<something>/SKILL.md` path
 * inside a package's `skills/**\/*.md`. The bare word `SKILL.md` (as in "each
 * folder holds one `SKILL.md`") is not a path and is not flagged.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** builder/scripts -> builder -> workspace root. */
export const REPO_ROOT = path.resolve(__dirname, "..", "..");

export type SkillPathRef = {
  /** Workspace-relative, posix-separated. */
  relPath: string;
  /** 1-based. */
  line: number;
  /** The matched path. */
  ref: string;
};

/** A path segment followed by `/SKILL.md`: `../x/SKILL.md`, `x/SKILL.md`, `@warlock.js/web/x/SKILL.md`. */
const PATH_REF_RE = /[\w.@-]+\/SKILL\.md/g;

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

function walkMarkdown(dir: string, repoRoot: string, into: string[]): void {
  for (const name of readdirSync(dir)) {
    const child = path.join(dir, name);

    if (isDirectory(child)) {
      walkMarkdown(child, repoRoot, into);
    } else if (name.endsWith(".md")) {
      into.push(child);
    }
  }
}

/** Every `skills/**\/*.md` one directory below the workspace root. */
export function discoverSkillFiles(repoRoot: string): string[] {
  const files: string[] = [];

  for (const dir of readdirSync(repoRoot)) {
    if (dir === "node_modules" || dir.startsWith(".")) continue;

    const skillsRoot = path.join(repoRoot, dir, "skills");

    if (isDirectory(skillsRoot) && isDirectory(path.join(repoRoot, dir))) {
      walkMarkdown(skillsRoot, repoRoot, files);
    }
  }

  return files.sort();
}

/** Pure matcher over one file's text. */
export function findSkillPathRefs(relPath: string, text: string): SkillPathRef[] {
  const refs: SkillPathRef[] = [];
  const lines = text.split(/\r\n|\n/);

  for (let index = 0; index < lines.length; index++) {
    for (const match of (lines[index] ?? "").matchAll(PATH_REF_RE)) {
      refs.push({ relPath, line: index + 1, ref: match[0] });
    }
  }

  return refs;
}

export function runSkillPathRefsGate(repoRoot: string): SkillPathRef[] {
  return discoverSkillFiles(repoRoot).flatMap((file) =>
    findSkillPathRefs(toPosix(path.relative(repoRoot, file)), readFileSync(file, "utf8")),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const refs = runSkillPathRefsGate(REPO_ROOT);

  if (refs.length === 0) {
    console.log("skill-path-refs: no path-style SKILL.md references in any package's skills");
  } else {
    for (const ref of refs) {
      console.error(`${ref.relPath}:${ref.line}  ${ref.ref}`);
    }

    console.error(
      `\nskill-path-refs: ${refs.length} path-style reference(s). agent-kit flattens skills on install, so ` +
        'refer by topic name instead: "the `x` topic" or "the `x` topic of the `warlock-js-<pkg>` skill".',
    );
    process.exitCode = 1;
  }
}
