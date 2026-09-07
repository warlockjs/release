import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ALLOWLIST, findViolationsInText } from "../no-pnpm-in-shipped-docs.ts";

describe("findViolationsInText", () => {
  it("flags a bare pnpm invocation", () => {
    const violations = findViolationsInText("core/skills/example/SKILL.md", "pnpm add x\n");
    assert.equal(violations.length, 1);
    assert.equal(violations[0].manager, "pnpm");
    assert.equal(violations[0].line, 1);
    assert.equal(violations[0].text, "pnpm add x");
  });

  it("flags a bare yarn invocation", () => {
    const violations = findViolationsInText("core/skills/example/SKILL.md", "yarn add x\n");
    assert.equal(violations.length, 1);
    assert.equal(violations[0].manager, "yarn");
  });

  it("does NOT flag npm install", () => {
    const violations = findViolationsInText("core/skills/example/SKILL.md", "npm install x\n");
    assert.equal(violations.length, 0);
  });

  it("does NOT flag npx warlock dev", () => {
    const violations = findViolationsInText("core/skills/example/SKILL.md", "npx warlock dev\n");
    assert.equal(violations.length, 0);
  });

  it("reports the correct 1-based line number across multiple lines", () => {
    const text = "line one\nline two\npnpm warlock dev\nline four\n";
    const violations = findViolationsInText("core/skills/example/SKILL.md", text);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].line, 3);
  });

  it("does not flag pnpm/yarn when not followed by an invocation-shaped word", () => {
    const violations = findViolationsInText(
      "core/skills/example/SKILL.md",
      "See pnpm-workspace.yaml and yarn.lock for detection details.\n",
    );
    assert.equal(violations.length, 0);
  });

  it("honours a scoped ALLOWLIST entry, matching file AND line exactly", () => {
    const relPath = "core/skills/allowlisted-example/SKILL.md";
    const text = "intro\npnpm needs esbuild's install script allowed\nmore text\n";
    // Line 2 is the offending line in this fixture.
    assert.equal(findViolationsInText(relPath, text).length, 1);

    // Same text at a DIFFERENT (unregistered) path must still be flagged —
    // an allowlist entry is scoped to one exact file, never a pattern.
    const violationsElsewhere = findViolationsInText("core/skills/not-allowlisted/SKILL.md", text);
    assert.equal(violationsElsewhere.length, 1);
  });

  it("real ALLOWLIST entries suppress their exact recorded file:line", () => {
    assert.ok(ALLOWLIST.length > 0, "expected the real gate to carry at least one recorded exception");
    const entry = ALLOWLIST[0];
    const lines = Array.from({ length: entry.line }, (_, i) => (i + 1 === entry.line ? "pnpm add something" : "x"));
    const violations = findViolationsInText(entry.relPath, lines.join("\n"));
    assert.equal(violations.length, 0, "an allowlisted file:line must not be reported as a violation");
  });

  it("still flags a pnpm line elsewhere in a file that has an allowlisted line", () => {
    const entry = ALLOWLIST[0];
    // Chosen far past every real ALLOWLIST line recorded for this file, so
    // it cannot collide with another genuine exception on the same path.
    const farLine = Math.max(...ALLOWLIST.filter((e) => e.relPath === entry.relPath).map((e) => e.line)) + 1000;
    const lines = Array.from({ length: farLine }, () => "x");
    lines[entry.line - 1] = "pnpm add allowlisted-line"; // the allowlisted line itself
    lines[farLine - 1] = "pnpm add not-allowlisted-line"; // far from any recorded exception
    const violations = findViolationsInText(entry.relPath, lines.join("\n"));
    assert.equal(violations.length, 1);
    assert.equal(violations[0].line, farLine);
  });
});
