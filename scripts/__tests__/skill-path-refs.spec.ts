import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { findSkillPathRefs } from "../skill-path-refs.ts";

describe("findSkillPathRefs", () => {
  it("flags a relative sibling link", () => {
    const refs = findSkillPathRefs("core/skills/a/SKILL.md", "See [x](../send-response/SKILL.md).\n");
    assert.deepEqual(
      refs.map((ref) => [ref.line, ref.ref]),
      [[1, "send-response/SKILL.md"]],
    );
  });

  it("flags a package-qualified path and a cross-package relative path", () => {
    const text = "see `@warlock.js/web/create-a-page/SKILL.md`\nand ../../../cache/skills/pick-cache-driver/SKILL.md\n";
    const refs = findSkillPathRefs("core/skills/a/SKILL.md", text);
    assert.deepEqual(
      refs.map((ref) => ref.line),
      [1, 2],
    );
  });

  it("does not flag the bare filename or a topic-name reference", () => {
    const text = "Each folder holds one `SKILL.md`.\nSee the `send-response` topic of the `warlock-js-core` skill.\n";
    assert.equal(findSkillPathRefs("core/skills/README.md", text).length, 0);
  });

  it("reports 1-based lines with CRLF input", () => {
    const refs = findSkillPathRefs("seal/skills/a/SKILL.md", "one\r\ntwo\r\nsee x/SKILL.md\r\n");
    assert.equal(refs[0]?.line, 3);
  });
});
