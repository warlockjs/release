# @warlock.js/builder — release runner

This folder is **not** pkgist. It is the local harness that *runs* pkgist for the
`@warlock.js/*` family — 27 packages, released together in lockstep.

- `pkgist.config.ts` — the static package registry (warlock family only). Never edit it for a release;
  pass `--bump` / `--commit` on the CLI instead.
- `builds/` and `sources/` — created on first build, artifacts only.

```bash
npx pkgist validate
npx pkgist build:family warlock --bump minor --commit "Release x.y.z — ..."
```

The pkgist tool source lives at `../../@mongez/pkgist` and is released from the
@mongez runner at `../../@mongez/builder`. The two registries are disjoint, so
neither can release the other's packages. Keep their pinned `@mongez/pkgist`
versions in step.

---

The rest of this file is a copy of pkgist's own README, kept here for reference.

---

# @mongez/pkgist

A build, version, and publish tool for TypeScript/React npm packages. Powered by [tsdown](https://tsdown.dev) (Rolldown/Rust-based bundler).

## Features

- **Two versioning strategies** — standalone packages version independently; family packages share one synchronized version
- **tsdown engine** — Rust-based Rolldown bundler; fast, reliable, modern
- **Dual output** — ESM + CJS with proper `exports` map and separate `.d.ts` files per format
- **File cloning** — copy `README.md`, `skills/`, `llms.txt`, or any file/folder into the build
- **Source snapshots** — archives a clean copy of the source before each build (`.git` and `node_modules` excluded)
- **Git integration** — `git add → commit → push → tag v<x.y.z> → push tags`
- **npm publish** — publishes from the build directory, not the source
- **Dry-run mode** — prints every step without touching disk, git, or npm
- **Concurrency** — builds multiple packages in parallel
- **TypeScript config** — `pkgist.config.ts` with full type safety via `defineConfig`

---

## Installation

```sh
# Global — use the CLI anywhere
npm install -g @mongez/pkgist

# Or as a dev dependency in your monorepo root
npm install -D @mongez/pkgist
```

Add a script to your root `package.json` for convenience:

```json
{
  "scripts": {
    "release": "pkgist build:all",
    "release:dry": "pkgist build:all --dry-run"
  }
}
```

---

## Configuration

Create a `pkgist.config.ts` in your project root (auto-discovered; `builder.ts` also works):

```ts
import { defineConfig } from "@mongez/pkgist";

export default defineConfig({
  settings: {
    concurrency: 8, // parallel build limit (default: 4)
    buildDir: "../builds", // where compiled packages are written
    sourcesDir: "../sources", // optional: where source snapshots are archived
  },

  // Standalone: each package versions independently
  standalone: [
    {
      name: "@my-scope/utils",
      root: "../utils",
      clone: ["README.md", "skills", "llms.txt", "llms-full.txt"],
    },
  ],

  // Families: all packages in a group share one version
  families: [
    {
      name: "state",
      packages: [
        { name: "@my-scope/atom", root: "../atom", clone: ["README.md"] },
        {
          name: "@my-scope/react-atom",
          root: "../react-atom",
          type: "react",
          clone: ["README.md"],
        },
      ],
    },
  ],
});
```

The config file is loaded at runtime via dynamic import — it can use `import` syntax freely.

---

## Package options

Every entry in `standalone[]` and `families[].packages[]` accepts:

| Option            | Type                             | Default          | Description                                                                                                                                                                                                                                             |
| ----------------- | -------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`            | `string`                         | **required**     | npm package name                                                                                                                                                                                                                                        |
| `root`            | `string`                         | **required**     | Path to package root, relative to `pkgist.config.ts`                                                                                                                                                                                                    |
| `type`            | `"typescript" \| "react"`        | `"typescript"`   | React packages get JSX support                                                                                                                                                                                                                          |
| `formats`         | `("esm" \| "cjs")[]`             | `["esm", "cjs"]` | Output formats                                                                                                                                                                                                                                          |
| `mainType`        | `"cjs" \| "esm"`                 | `"cjs"`          | Primary format (affects `main` field in package.json)                                                                                                                                                                                                   |
| `entries`         | `string \| string[]`             | `["index.ts"]`   | Entry files inside `src/`                                                                                                                                                                                                                               |
| `srcDir`          | `string`                         | `"src"`          | Source directory name                                                                                                                                                                                                                                   |
| `dts`             | `boolean`                        | `true`           | Generate TypeScript declarations                                                                                                                                                                                                                        |
| `sourcemap`       | `boolean`                        | `true`           | Generate sourcemaps                                                                                                                                                                                                                                     |
| `minify`          | `boolean`                        | `false`          | Minify output                                                                                                                                                                                                                                           |
| `preserveModules` | `boolean`                        | `true`           | Keep one file per source module instead of bundling everything into a single `index.js`. Produces meaningful stack traces (`array/chunk.mjs:4` vs `index.js:1027`). Set to `false` only for tiny single-file packages where a flat bundle is preferred. |
| `clone`           | `(string \| [string, string])[]` | `[]`             | Files/dirs to copy into build. Strings copy as-is; `["src", "dest"]` renames                                                                                                                                                                            |
| `publish`         | `boolean`                        | `true`           | Publish to npm                                                                                                                                                                                                                                          |
| `access`          | `"public" \| "restricted"`       | `"public"`       | npm access level                                                                                                                                                                                                                                        |
| `commit`          | `string \| true \| false`        | —                | Git commit message. `string` → use verbatim. `true` → auto-generate `Released <new-version>`. `false` / omitted → skip git entirely.                                                                                                                    |
| `branch`          | `string`                         | current branch   | Git branch to push to                                                                                                                                                                                                                                   |

### Standalone-only option

| Option    | Type                                                | Default  | Description                                                                                                                         |
| --------- | --------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `version` | `"auto" \| "patch" \| "minor" \| "major" \| string` | `"auto"` | `"auto"`/`"patch"` bumps the patch digit; `"minor"` bumps minor; `"major"` bumps major; any semver string uses that version exactly |

### Family-level options

| Option    | Type                                                | Default  | Description                                                                                                                                                                                                          |
| --------- | --------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version` | `"auto" \| "patch" \| "minor" \| "major" \| string` | `"auto"` | Same strategies as standalone; applied to the highest current version across all family members                                                                                                                      |
| `commit`  | `string \| true \| false`                           | —        | Commit message applied to all family members (overrides per-package). Same shape as the per-package `commit`. `true` auto-generates `Released <new-version>` for every member with their shared version substituted. |

---

## Versioning

### Standalone packages

```
current: 2.1.0
version: "auto"   →  2.1.1  (patch bump)
version: "3.0.0"  →  3.0.0  (explicit)
```

### Family packages

The family picks the **highest current version** across all members, then bumps it:

```
atom        1.0.5
react-atom  5.1.3   ← highest
atomic-query 0.1.0

family version: "auto"  →  5.1.4  (all three land on 5.1.4)
```

This means if you add a new package to a family at `0.1.0`, it jumps to match the family on first build — which is intentional. The family version is the compatibility contract.

---

## CLI reference

### `build`

Build one or more standalone packages.

```sh
pkgist build @my-scope/utils
pkgist build @my-scope/utils @my-scope/cache
pkgist build --all                   # all standalone packages
```

### `build:family`

Build all packages in a family with a shared version.

```sh
pkgist build:family atom
pkgist build:family localization
```

### `build:all`

Build every standalone package and every family.

```sh
pkgist build:all
```

### `list`

Show all registered packages and families with their current versions.

```sh
pkgist list
```

```
=== Standalone Packages ===
  @my-scope/utils v2.1.0 [typescript] [esm, cjs]
    root: /path/to/utils

=== Families ===
  Family: state
    @my-scope/atom v5.1.3 [typescript] [esm, cjs]
    @my-scope/react-atom v5.1.3 [react] [esm, cjs]
```

### `validate`

Check that the config is valid and all package roots exist on disk.

```sh
pkgist validate
```

---

## Common flags

Available on all `build` commands:

| Flag                | Description                                                                            |
| ------------------- | -------------------------------------------------------------------------------------- |
| `--dry-run`         | Print every step without writing to disk, git, or npm                                  |
| `--no-publish`      | Skip `npm publish`                                                                     |
| `--no-git`          | Skip git add / commit / push / tag                                                     |
| `--concurrency <n>` | Override the parallel build limit                                                      |
| `--config <path>`   | Path to config file (default: auto-discovers `pkgist.config.ts` / `builder.ts` in cwd) |
| `--verbose`         | Show debug-level log lines                                                             |

---

## Build output structure

### With `preserveModules: true` (default)

Each source file becomes its own output file, mirroring the source tree. Stack traces show file names instead of opaque line numbers.

```
builds/
└── utils/
    └── 2.1.1/
        ├── package.json            ← clean: no devDeps, no scripts
        ├── README.md               ← cloned
        ├── skills/                 ← cloned (directory)
        ├── esm/
        │   ├── index.mjs
        │   ├── index.mjs.map
        │   ├── index.d.mts
        │   ├── array/
        │   │   ├── chunk.mjs
        │   │   └── chunk.d.mts
        │   └── string/
        │       └── trim.mjs
        └── cjs/
            ├── index.cjs
            ├── index.cjs.map
            ├── index.d.cts
            └── array/
                └── chunk.cjs
```

The generated `package.json` sets:

```json
{
  "main": "./cjs/index.cjs",
  "module": "./esm/index.mjs",
  "types": "./esm/index.d.mts",
  "exports": {
    ".": {
      "import": {
        "types": "./**esm**/index.d.mts",
        "default": "./esm/index.mjs"
      },
      "require": { "types": "./cjs/index.d.cts", "default": "./cjs/index.cjs" }
    }
  }
}
```

### With `preserveModules: false`

Everything is bundled into a single file per format. Useful for tiny single-file packages.

```
esm/
  index.js / index.js.map / index.d.ts
cjs/
  index.js / index.js.map / index.d.ts
```

```json
{
  "main": "./cjs/index.js",
  "module": "./esm/index.js",
  "types": "./esm/index.d.ts"
}
```

ESM-only packages (`mainType: "esm"` or `formats: ["esm"]`) get `"type": "module"` and omit the `require` condition in both modes.

---

## Build pipeline (per package)

1. Load source `package.json` → read current version
2. Resolve new version (auto-bump or explicit)
3. Create build output directory
4. Snapshot source to `sourcesDir/` — full copy excluding `.git`, `node_modules`, `dist`
5. Compile with **tsdown** → `esm/` and `cjs/` subdirectories
6. Clone extra files/directories listed in `clone`
7. Write clean `package.json` for the build
8. Update source `package.json` version in-place
9. Git: `add .` → `commit` → `push` → `tag v<version>` → `push tags` _(if `commit` is set)_
10. `npm publish --access <public|restricted>` from build directory _(if `publish !== false`)_

---

## Git workflow

Git operations run when `commit` resolves to a non-empty message. Three shapes:

```ts
// 1. Explicit message — string
{ name: "@my-scope/utils", root: "../utils", commit: "chore: release" }

// 2. Auto-generated message — boolean true
//    → produces "Released <new-version>", e.g. "Released 2.1.4"
{ name: "@my-scope/utils", root: "../utils", commit: true }

// 3. Skip git — omit, or pass false explicitly
{ name: "@my-scope/utils", root: "../utils" }              // omitted
{ name: "@my-scope/utils", root: "../utils", commit: false } // explicit skip
```

**Family-level `commit`** uses the same shape and overrides per-package values:

```ts
// One explicit message for every family member
{
  name: "state",
  commit: "feat: improved actions API",
  packages: [ ... ],
}

// Auto-generated for every member with the shared family version
{
  name: "state",
  commit: true,
  packages: [ ... ],
}
```

The builder tags each package with `v<version>` and pushes tags automatically.  
Pick `false` or omit for local test builds where you want zero git side effects.

---

## Developing the bundler itself

```sh
yarn build     # compile src/ → dist/ once
yarn dev       # watch mode — recompiles on change
```

After any change to `src/`, run `yarn build` before the next `pkgist` invocation.

npx pkgist build:family warlock --bump 4.2.2
