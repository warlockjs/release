/**
 * Consumer-contract strictness flags.
 *
 * The scaffolded app (`create-warlock/templates/warlock/tsconfig.json`) is the
 * actual compile every package's shipped TypeScript source has to survive:
 * packages ship source via `exports`, so a consumer app compiles that source
 * directly under its own tsconfig. If the consumer's tsconfig turns on a
 * type-checking flag that a package's own tsconfig does not, the package looks
 * clean in isolation while failing the moment a real app imports it. This
 * module reads the consumer template and returns the boolean checking flags it
 * has enabled, restricted to an explicit allowlist, so `strictness-gate.ts` can
 * fold them into the forced compile args alongside the existing shared
 * strictness contract.
 *
 * Deliberately excluded:
 * - `skipLibCheck`: it loosens checking (skips declaration files), so it is
 *   never a flag to force on regardless of the consumer's setting.
 * - `moduleResolution` / `module`: packages mostly compile as CommonJS with
 *   node resolution. Forcing the consumer's `"bundler"` resolution onto a
 *   CommonJS package would change what resolves at all (breaking imports that
 *   are fine at runtime) rather than surface a real type-checking gap, so
 *   resolution/module settings are out of scope for this ratchet.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
export const CONSUMER_TSCONFIG_PATH = path.join(REPO_ROOT, "create-warlock", "templates", "warlock", "tsconfig.json");

/**
 * Boolean type-checking compiler options this module will ever surface from
 * the consumer tsconfig. Anything not on this list (resolution/module
 * settings, `skipLibCheck`, emit/path options, etc.) is ignored even if the
 * consumer tsconfig sets it.
 */
export const CONSUMER_FLAG_ALLOWLIST = [
  "strict",
  "noImplicitAny",
  "strictNullChecks",
  "noUncheckedIndexedAccess",
  "exactOptionalPropertyTypes",
  "noImplicitOverride",
  "noImplicitReturns",
  "noFallthroughCasesInSwitch",
  "useUnknownInCatchVariables",
  "isolatedModules",
  "forceConsistentCasingInFileNames",
  "noPropertyAccessFromIndexSignature",
] as const;

export type ConsumerFlag = (typeof CONSUMER_FLAG_ALLOWLIST)[number];

/**
 * Reads the consumer app's tsconfig and returns the allowlisted boolean
 * checking flags that are `true` there, in stable allowlist order. Throws
 * (naming the path) if the file is missing or unparseable — a silent fallback
 * would let the consumer contract silently drift out of the gate.
 */
export function consumerStrictnessFlags(filePath = CONSUMER_TSCONFIG_PATH): ConsumerFlag[] {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    throw new Error(`Cannot read consumer tsconfig at ${filePath}.`);
  }
  const parsed = ts.parseConfigFileTextToJson(filePath, text);
  const options = parsed.config?.compilerOptions;
  if (parsed.error || !options || typeof options !== "object") throw new Error(`Cannot parse consumer tsconfig at ${filePath}.`);
  return CONSUMER_FLAG_ALLOWLIST.filter((flag) => options[flag] === true);
}
