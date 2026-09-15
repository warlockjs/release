// A re-export barrel, the same shape as core/src/router/index.ts's
// `export * from "./normalize-route-path";`. When pkg-b relative-imports
// THIS file (instead of shared.ts directly), TypeScript records shared.ts's
// "why is this file included" reason as the export-star statement below, at
// THIS file's own position -- so the TS6059 diagnostic for shared.ts is
// reported at a location inside pkg-a, even though pkg-b's program is what
// raised it.
export * from "./shared";
