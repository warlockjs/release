/**
 * @warlock.js/builder release config — a static package registry.
 *
 * The version bump and commit message come from the CLI per release:
 *   npx pkgist build @mongez/<pkg>          --bump <patch|minor|major|x.y.z> --commit "<msg>"
 *   npx pkgist build:family <atom|warlock>  --bump <strategy>                 --commit "<msg>"
 *
 * Every entry uses `commit: true` so a missing `--commit` still commits the
 * fallback "Released x.y.z" (rather than silently skipping git). Per-release
 * intent lives ONLY on the CLI — never edit this file for a release.
 */
import { defineConfig } from "@mongez/pkgist";

export default defineConfig({
  settings: {
    /**
     * 4, down from 20 — but be aware this does NOT fix the family-build OOM.
     *
     * Measured 2026-08-26, `build:family warlock`, all runs exit 134 (V8
     * "Ineffective mark-compacts near heap limit") at the same ~4085 MB ceiling:
     *
     *   concurrency 20 →  0 of 28 compiled
     *   concurrency  4 → 13 of 28 compiled
     *   concurrency  2 → 15 of 28 compiled
     *   concurrency  1 → 15 of 28 compiled   ← one build in flight at a time
     *
     * Concurrency 1 still dies, so peak parallelism is not the cause: the
     * pkgist process never releases what each tsdown/rolldown build retains, so
     * the heap climbs monotonically and hits 4GB after ~15 packages however
     * slowly they are fed in. The packages it dies on (`cache`, `cascade`) each
     * compile in ~2s in a fresh process, so they are not hogs either.
     *
     * 4 is kept because it is strictly better than 20 (13 compiled vs 0, lower
     * peak) and 1 buys only two more packages for a fully serialized build. The
     * real fix belongs in pkgist — build each package in its own child process —
     * and until that lands, a 28-package family release CANNOT complete in one
     * run. Do not "solve" this with --max-old-space-size: a bigger heap only
     * moves the ceiling, and git runs BEFORE publish per package, so an OOM
     * mid-run leaves some of the 28 repos pushed and tagged, the rest untouched,
     * and nothing published.
     */
    concurrency: 4,
    buildDir: "./builds", // builder holds its own build artifacts
    sourcesDir: "./sources", // builder holds its own source snapshots
  },

  standalone: [
],

  families: [
    {
      name: "warlock",
      version: "patch",
      commit: true,
      packages: [
        {
          name: "@warlock.js/ai",
          root: "../ai",
          clone: [
            "README.md",
            "LICENSE",
            "CHANGELOG.md",
            "skills",
            "llms.txt",
            "llms-full.txt",
          ],
        },
        {
          name: "@warlock.js/ai-panoptic",
          root: "../ai-panoptic",
          clone: [
            "README.md",
            "LICENSE",
            "CHANGELOG.md",
            "skills",
            "llms.txt",
            "llms-full.txt",
          ],
        },
        {
          name: "@warlock.js/ai-anthropic",
          root: "../ai-anthropic",
          clone: [
            "README.md",
            "LICENSE",
            "CHANGELOG.md",
            "skills",
            "llms.txt",
            "llms-full.txt",
          ],
        },
        {
          name: "@warlock.js/ai-bedrock",
          root: "../ai-bedrock",
          clone: [
            "README.md",
            "LICENSE",
            "CHANGELOG.md",
            "skills",
            "llms.txt",
            "llms-full.txt",
          ],
        },
        {
          name: "@warlock.js/ai-google",
          root: "../ai-google",
          clone: [
            "README.md",
            "LICENSE",
            "CHANGELOG.md",
            "skills",
            "llms.txt",
            "llms-full.txt",
          ],
        },
        {
          name: "@warlock.js/ai-ollama",
          root: "../ai-ollama",
          clone: [
            "README.md",
            "LICENSE",
            "CHANGELOG.md",
            "skills",
            "llms.txt",
            "llms-full.txt",
          ],
        },
        {
          name: "@warlock.js/ai-openai",
          root: "../ai-openai",
          clone: [
            "README.md",
            "LICENSE",
            "CHANGELOG.md",
            "skills",
            "llms.txt",
            "llms-full.txt",
          ],
        },
        {
          name: "@warlock.js/ai-live",
          root: "../ai-live",
          clone: [
            "README.md",
            "LICENSE",
            "CHANGELOG.md",
            "skills",
            "llms.txt",
            "llms-full.txt",
          ],
        },
        {
          name: "@warlock.js/ai-mistral",
          root: "../ai-mistral",
          clone: [
            "README.md",
            "LICENSE",
            "CHANGELOG.md",
            "skills",
            "llms.txt",
            "llms-full.txt",
          ],
        },
        {
          name: "@warlock.js/ai-groq",
          root: "../ai-groq",
          clone: [
            "README.md",
            "LICENSE",
            "CHANGELOG.md",
            "skills",
            "llms.txt",
            "llms-full.txt",
          ],
        },
        {
          name: "@warlock.js/ai-deepseek",
          root: "../ai-deepseek",
          clone: [
            "README.md",
            "LICENSE",
            "CHANGELOG.md",
            "skills",
            "llms.txt",
            "llms-full.txt",
          ],
        },
        {
          name: "@warlock.js/ai-xai",
          root: "../ai-xai",
          clone: [
            "README.md",
            "LICENSE",
            "CHANGELOG.md",
            "skills",
            "llms.txt",
            "llms-full.txt",
          ],
        },
        {
          name: "@warlock.js/ai-tools",
          root: "../ai-tools",
          clone: [
            "README.md",
            "LICENSE",
            "CHANGELOG.md",
            "skills",
            "llms.txt",
            "llms-full.txt",
          ],
        },
        {
          name: "@warlock.js/ai-workspace",
          root: "../ai-workspace",
          clone: [
            "README.md",
            "LICENSE",
            "CHANGELOG.md",
            "skills",
            "llms.txt",
            "llms-full.txt",
          ],
        },
        {
          name: "@warlock.js/auth",
          root: "../auth",
          mainType: "esm",
          formats: ["esm"],
          clone: [
            "README.md",
            "LICENSE",
            "CHANGELOG.md",
            "skills",
            "llms.txt",
            "llms-full.txt",
          ],
        },
        {
          name: "@warlock.js/cache",
          root: "../cache",
          clone: [
            "README.md",
            "LICENSE",
            "CHANGELOG.md",
            "skills",
            "llms.txt",
            "llms-full.txt",
          ],
        },
        {
          name: "@warlock.js/cascade",
          root: "../cascade",
          clone: [
            "bin",
            "README.md",
            "LICENSE",
            "CHANGELOG.md",
            "skills",
            "llms.txt",
            "llms-full.txt",
          ],
        },
        {
          name: "@warlock.js/context",
          root: "../context",
          clone: [
            "README.md",
            "LICENSE",
            "CHANGELOG.md",
            "skills",
            "llms.txt",
            "llms-full.txt",
          ],
        },
        {
          name: "@warlock.js/core",
          root: "../core",
          mainType: "esm",
          entries: [
            "index.ts",
            "cli/start.ts",
            // Subpath entries. These are NOT reachable from `index.ts` — that is the
            // point. 4.13.0 removed them from the root barrel to keep dev-only tooling
            // out of every consumer's production module graph, so they need their own
            // build entries and `exports` entries to remain importable at all.
            "tests/index.ts",
            "vite/index.ts",
            "dev-server/health-checker/workers/eslint-health.worker.ts",
            "dev-server/health-checker/workers/ts-health.worker.ts",
            "dev-server/loader/hook-thread.ts",
          ],
          formats: ["esm"],
          clone: [
            "bin",
            "README.md",
            "LICENSE",
            "CHANGELOG.md",
            "skills",
            "llms.txt",
            "llms-full.txt",
          ],
        },
        {
          name: "create-warlock",
          root: "../create-warlock",
          mainType: "esm",
          formats: ["esm"],
          clone: [
            "bin",
            "templates",
            "README.md",
            "LICENSE",
            "CHANGELOG.md",
            "skills",
            "llms.txt",
            "llms-full.txt",
          ],
        },
        {
          name: "@warlock.js/fs",
          root: "../fs",
          clone: [
            "README.md",
            "LICENSE",
            "CHANGELOG.md",
            "skills",
            "llms.txt",
            "llms-full.txt",
          ],
        },
        {
          name: "@warlock.js/herald",
          root: "../herald",
          clone: [
            "README.md",
            "LICENSE",
            "CHANGELOG.md",
            "skills",
            "llms.txt",
            "llms-full.txt",
          ],
        },
        {
          name: "@warlock.js/logger",
          root: "../logger",
          clone: [
            "README.md",
            "LICENSE",
            "CHANGELOG.md",
            "skills",
            "llms.txt",
            "llms-full.txt",
          ],
        },
        {
          name: "@warlock.js/scheduler",
          root: "../scheduler",
          clone: [
            "README.md",
            "LICENSE",
            "CHANGELOG.md",
            "skills",
            "llms.txt",
            "llms-full.txt",
          ],
        },
        {
          name: "@warlock.js/seal",
          root: "../seal",
          clone: [
            "README.md",
            "LICENSE",
            "CHANGELOG.md",
            "skills",
            "llms.txt",
            "llms-full.txt",
          ],
        },
        {
          name: "@warlock.js/notifications",
          root: "../notifications",
          clone: [
            "README.md",
            "LICENSE",
            "CHANGELOG.md",
            "skills",
            "llms.txt",
            "llms-full.txt",
          ],
        },
        {
          /**
           * The SSR page layer. Registered 2026-08-25: it had never been in this
           * registry, so `@warlock.js/web` had never been published — `npm view`
           * returned a 404 while every sibling was at 4.16.0. `warlock add web`
           * cannot work until this ships once.
           */
          name: "@warlock.js/web",
          root: "../web",
          mainType: "esm",
          /**
           * Every subpath from `web/package.json`'s own `exports` map. Only
           * `index.ts` is reachable from the root barrel; the others are
           * deliberately separate so a consumer's production graph never pulls
           * the dev-only Vite plugin or the connector in behind a bare import.
           *
           * `entry/index.ts` is the HYDRATION ENTRY and is not imported by any
           * consumer — `warlock build` feeds it to Vite as a build input. It is
           * built here because the build previously resolved it to
           * `<webRoot>/src/entry/index.ts`, a path that exists only in this
           * checkout: with `"files": ["esm"]`, no installed copy has `src/`, so
           * the client bundle could not be produced by any real consumer.
           *
           * The path is `entry/`, not `hydration/`, and this list is the ONLY
           * thing that has to be kept in step with that name by hand. `web`
           * `b4d3d71` renamed the folder; this entry was not renamed with it,
           * and `@warlock.js/web` stopped building at all —
           * `[UNRESOLVED_ENTRY] Cannot resolve entry module ../web/src/hydration/index.ts`.
           * It went unnoticed because the only gate that builds the family
           * OOM'd (canon `ccd02104`) before it ever reached `web`. The runtime
           * half already agrees: `vite/hydration-entries.ts` looks for
           * `esm/entry/index.mjs`, falling back to `src/entry/index.ts`.
           *
           * `server/index.ts` is the PIPELINE SEAM and is likewise imported by
           * nobody — the dev connector reaches it through
           * `vite.ssrLoadModule(paths.webServerBarrel)`, and that argument is a
           * path STRING computed at runtime (`server/web-connector.ts:624`). No
           * static edge in the graph points at it, so without an entry of its own
           * the bundler treats its exports as unreachable and tree-shakes them:
           * v5.0.0 shipped a barrel exporting 4 of ~16 names, an
           * `install-page-routes.mjs` that was literally `export {  };`, and a
           * `stylesheet-urls.mjs` with `devStylesheetUrls`'s body deleted —
           * `warlock dev` died on `devStylesheetUrls is not a function`. An entry's
           * export surface is preserved, which is what keeps them alive.
           */
          entries: [
            "index.ts",
            "entry/index.ts",
            "server/index.ts",
            // The PUBLIC server-only subpath `@warlock.js/web/page-cache`
            // (`web/package.json`'s `"./page-cache"`) — deliberately a
            // SEPARATE entry from `server/index.ts` above (the internal
            // pipeline seam, reached only by the dev connector's
            // `ssrLoadModule` on a runtime path string, never by a package
            // specifier). Re-exporting the page-cache API from
            // `server/index.ts` instead would make the whole pipeline
            // surface (`executePageRequest`, `installPageRoutes`, …)
            // publicly importable, which is exactly what that file's own
            // header forbids. Top-level (`page-cache.ts`, not
            // `server/page-cache.ts`) so pkgist derives "./page-cache"
            // instead of colliding with the "./server" key `server/index.ts`
            // already owns.
            "page-cache.ts",
            // The PUBLIC build-time subpath `@warlock.js/web/build`. Kept off
            // the root barrel on purpose: it reaches `discover-pages`, which
            // walks the filesystem and imports page files by path, and on the
            // root barrel that module joined the graph of every page importing
            // `@warlock.js/web` — a generated app answered 500 on every route
            // in dev until it moved here (5.15.0).
            "build/index.ts",
            // The PUBLIC sitemap/robots subpath `@warlock.js/web/sitemap`
            // (5.16). `warlock add sitemap` generates
            // `import type { WebSitemapConfig } from "@warlock.js/web/sitemap"`
            // into src/config/web.ts, so a missing entry here breaks every
            // app that adds the feature. Kept off the root barrel for the
            // same reason as `build/index.ts`: it reaches listRoutablePages.
            "sitemap/index.ts",
            "client/runtime/index.ts",
            "connector/index.ts",
            "vite/index.ts",
          ],
          formats: ["esm"],
          /**
           * `skills/` and the two `llms` files WERE judged non-blocking for the
           * first publish. That judgement was overturned on 2026-08-25: web is
           * v5's headline package, and it was the only one an assistant would
           * have had nothing to read about.
           *
           * This list is the SHIPPING list. A skill written into `web/skills/`
           * and left out of here exists in the repo and is absent from the
           * tarball — done everywhere except where it counts.
           */
          clone: [
            "README.md",
            "LICENSE",
            "CHANGELOG.md",
            "skills",
            "llms.txt",
            "llms-full.txt",
          ],
        },
        {
          name: "@warlock.js/access",
          root: "../access",
          clone: [
            "README.md",
            "LICENSE",
            "CHANGELOG.md",
            "skills",
            "llms.txt",
            "llms-full.txt",
          ],
        },
        {
          /**
           * Durable background jobs (BullMQ + Redis), new in 5.13. The
           * `./notifications` subpath (`queue/package.json` exports) is its own
           * entry so the root barrel never pulls `@warlock.js/notifications`.
           */
          name: "@warlock.js/queue",
          root: "../queue",
          entries: ["index.ts"],
          clone: [
            "README.md",
            "LICENSE",
            "CHANGELOG.md",
            "skills",
            "llms.txt",
            "llms-full.txt",
          ],
        },
        {
          /** Runtime `sitemap.xml` generation, new in 5.15. No subpath exports. */
          name: "@warlock.js/sitemap",
          root: "../sitemap",
          clone: [
            "README.md",
            "LICENSE",
            "CHANGELOG.md",
            "skills",
            "llms.txt",
            "llms-full.txt",
          ],
        },
      ],
    },
  ],
});
