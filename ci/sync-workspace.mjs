// Refreshes ci/workspace/ from the local workspace root, for the CI release.
//
//   node ci/sync-workspace.mjs            (run from builder/, on the release machine)
//
// The workspace root is a local-only repo (it also holds internal notes), so CI
// gets a vendored copy of just the files a family install needs. Two changes
// are made on the way in, and the lockfile is regenerated to match them in a
// scratch copy (manifests only), never in the live workspace:
//   1. `v5/app` is dropped from the workspace: it is local-only, not a member.
//   2. `linkWorkspacePackages: true`: while a version is being gated it is not
//      on npm, so literal pins like "5.25.0" must resolve to the siblings.
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const builderRoot = path.resolve(import.meta.dirname, "..");
const workspaceRoot = path.resolve(builderRoot, "..");
const target = path.join(builderRoot, "ci", "workspace");
const copied = [".npmrc", ".prettierrc.json", ".prettierignore", "package.json", "tsconfig.base.json"];
const localOnlyProjects = new Set(["v5/app"]);

const workspaceYaml = readFileSync(path.join(workspaceRoot, "pnpm-workspace.yaml"), "utf8");
const packagesSection = workspaceYaml.split(/^packages:\s*$/m)[1].split(/\n(?=\S)/)[0];
const projects = [...packagesSection.matchAll(/^  - (\S+)\s*$/gm)]
  .map((match) => match[1])
  .filter((project) => !localOnlyProjects.has(project));

const ciYaml =
  workspaceYaml
    .split("\n")
    .filter((line) => !localOnlyProjects.has(line.replace(/^  - /, "").trim()) || !line.startsWith("  - "))
    .join("\n")
    .trimEnd() +
  "\n\n# CI only: resolve @warlock.js/* specs against the checked-out siblings. The\n" +
  "# candidate is unpublished while it is gated, so the registry cannot serve it.\n" +
  "linkWorkspacePackages: true\n";

const scratch = mkdtempSync(path.join(tmpdir(), "warlock-ci-workspace-"));
try {
  for (const file of ["package.json", ".npmrc", "pnpm-lock.yaml"]) {
    copyFileSync(path.join(workspaceRoot, file), path.join(scratch, file));
  }
  writeFileSync(path.join(scratch, "pnpm-workspace.yaml"), ciYaml);
  for (const project of projects) {
    mkdirSync(path.join(scratch, project), { recursive: true });
    copyFileSync(path.join(workspaceRoot, project, "package.json"), path.join(scratch, project, "package.json"));
  }
  const pnpm = { cwd: scratch, stdio: "inherit", shell: process.platform === "win32" };
  execFileSync("pnpm", ["install", "--lockfile-only", "--ignore-scripts"], pnpm);
  execFileSync("pnpm", ["install", "--lockfile-only", "--frozen-lockfile", "--ignore-scripts"], pnpm);

  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  for (const file of copied) cpSync(path.join(workspaceRoot, file), path.join(target, file));
  copyFileSync(path.join(scratch, "pnpm-lock.yaml"), path.join(target, "pnpm-lock.yaml"));
  writeFileSync(path.join(target, "pnpm-workspace.yaml"), ciYaml);
  console.log(`ci/workspace refreshed: ${projects.length} projects`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
