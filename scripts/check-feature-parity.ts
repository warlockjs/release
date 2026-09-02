/**
 * Release guard: `create-warlock`'s feature keys and `@warlock.js/core`'s
 * `allowedFeatures` must agree.
 *
 * ## Why this exists
 *
 * `create-warlock` offers a feature in its prompt; the user selects it; the
 * scaffolder delegates the install to `warlock add <key>`. If the key is not
 * one core knows, that fails **at the user's terminal, on first contact with
 * the framework**. Nothing checked it. `create-warlock/specs/features-map-contract.spec.ts`
 * pins the scaffolder-side invariants and says in its own header that the
 * cross-package half "belongs in a CI guard" — this is that guard.
 *
 * ## Why it runs BOTH directions
 *
 * A subset check alone has already let a bug ship: `--features=web,tailwind`
 * was rejected with "Unknown feature(s): tailwind" because `tailwind` and
 * `shadcn` existed in core and were missing from the scaffolder — a direction
 * `scaffolder ⊆ core` cannot see.
 *
 *   1. scaffolder ⊆ core — a typo, or a key core renamed.
 *   2. core ⊆ scaffolder + DELIBERATE_OMISSIONS — a feature core gained that
 *      never became scaffoldable.
 *
 * ## Why it lives in `builder` and imports by relative path
 *
 * `create-warlock` deliberately does not depend on `@warlock.js/core` — an
 * isolation boundary. A guard in either package would invert or create that
 * edge. `builder` is the release runner: it sits above both, depends on
 * neither, and is the only automated gate this repo actually has (there is no
 * CI — see card `c8064a0d`). Importing by relative path adds no entry to any
 * package.json, so **no dependency edge is created in either direction**.
 *
 * ## Why the scaffolder's lists are DISCOVERED, not named
 *
 * Its keys are spread across several exported arrays (`features`,
 * `aiProviders`, `aiPackages`). Naming them here would mean a fourth list added
 * later is silently skipped — and this guard would then report a gap that is
 * not real, or miss one that is. I hit exactly that while writing this: a first
 * pass named two of the three lists and reported three phantom missing keys. So
 * every exported array of `{ key }` objects counts, whatever it is called.
 */
import { featuresMap } from "../../core/src/generations/features/index";
import * as scaffolderMap from "../../create-warlock/src/features/features-map";

/**
 * Core keys that are deliberately NOT offered by the scaffolder.
 *
 * Adding to this list is a decision and should be argued for in review — the
 * default for a new core feature is that it becomes scaffoldable. Anything
 * missing that is NOT listed here is a gap, not a decision.
 */
const DELIBERATE_OMISSIONS: Record<string, string> = {
  mongodb: "the database driver has its own dedicated select step",
  postgres: "the database driver has its own dedicated select step",
  mysql: "the database driver has its own dedicated select step",
  ai: "pulled automatically by every ai-* key's `requires` in core's feature map",
};

type KeyedOption = { key: string };

function isKeyedList(value: unknown): value is KeyedOption[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof (entry as KeyedOption)?.key === "string")
  );
}

function scaffolderKeys(): { keys: string[]; lists: string[] } {
  const lists: string[] = [];
  const keys = new Set<string>();

  for (const [name, value] of Object.entries(scaffolderMap)) {
    if (!isKeyedList(value)) continue;

    lists.push(`${name}(${value.length})`);

    for (const entry of value) keys.add(entry.key);
  }

  return { keys: [...keys], lists: lists.sort() };
}

function main(): number {
  const core = Object.keys(featuresMap);
  const { keys: scaffolder, lists } = scaffolderKeys();

  if (lists.length === 0) {
    console.error(
      "feature parity: found NO keyed lists in create-warlock's features-map.\n" +
        "That is not a clean result — it means this guard can no longer see the\n" +
        "scaffolder's keys and would pass no matter what drifted. Fix the guard.",
    );

    return 1;
  }

  const unknown = scaffolder.filter((key) => !core.includes(key)).sort();
  const missing = core
    .filter((key) => !scaffolder.includes(key) && !(key in DELIBERATE_OMISSIONS))
    .sort();

  if (unknown.length === 0 && missing.length === 0) {
    console.log(
      `feature parity OK — core ${core.length}, scaffolder ${scaffolder.length} ` +
        `from ${lists.join(" + ")}, ${Object.keys(DELIBERATE_OMISSIONS).length} deliberate omissions.`,
    );

    return 0;
  }

  console.error("feature parity FAILED\n");

  if (unknown.length > 0) {
    console.error(
      `  create-warlock offers ${unknown.length} key(s) core does not know: ${unknown.join(", ")}\n` +
        `  A user selecting one gets "unknown feature" from \`warlock add\` at their\n` +
        `  own terminal. Fix the key in create-warlock/src/features/features-map.ts,\n` +
        `  or add the feature to core/src/generations/features/.\n`,
    );
  }

  if (missing.length > 0) {
    console.error(
      `  core has ${missing.length} feature(s) the scaffolder never offers: ${missing.join(", ")}\n` +
        `  Either surface them in create-warlock/src/features/features-map.ts, or —\n` +
        `  if the omission is intended — add them to DELIBERATE_OMISSIONS in this\n` +
        `  file WITH the reason.\n`,
    );
  }

  return 1;
}

process.exit(main());
