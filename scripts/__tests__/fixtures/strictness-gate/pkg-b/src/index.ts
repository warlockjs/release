// Deliberately relative-imports pkg-a's barrel, which lives outside this
// package's own rootDir ("./src") -- the same shape as
// web/src/build/generate-pages-barrel.ts reaching core/src/router source
// through a path that escapes web's rootDir. Because pkg-a/src/index.ts
// re-exports pkg-a/src/shared.ts, pkg-b's own program pulls both files in and
// raises TS6059 ("file is not under rootDir") for each -- the one for
// shared.ts is reported at pkg-a/src/index.ts's own re-export statement, i.e.
// at a location INSIDE pkg-a, even though pkg-b's program is what raised it.
// pkg-b's program also surfaces pkg-a/src/shared.ts's own TS2322.
import { shared } from "../../pkg-a/src/index";

export const useShared = (): number => shared;
