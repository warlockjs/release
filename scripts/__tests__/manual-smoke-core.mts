import {
  REPO_ROOT,
  discoverPackages,
  discoverSkillFiles,
  compileManySkills,
} from "../skill-snippet-gate.ts";

const start = Date.now();
const packages = discoverPackages(REPO_ROOT);
const core = packages.find((p) => p.dir === "core")!;
const skills = discoverSkillFiles(core);
const gateTmpRoot = REPO_ROOT + "/.skill-snippet-gate-tmp";
const results = compileManySkills(skills, packages, gateTmpRoot);
let compiled = 0;
let failed = 0;
for (const result of results) {
  for (const f of result.files) {
    compiled++;
    if (f.diagnostics.length) failed++;
  }
}
console.log("skills", skills.length, "compiled", compiled, "failed", failed, "ms", Date.now() - start);
