// Deliberate type error (TS2322), used as the INNOCENT case: a normal type
// error in a file under pkg-a, reported by pkg-a's own program, must stay
// owned by pkg-a. Deliberately NOT reachable from pkg-b, so this diagnostic
// only ever appears when pkg-a is compiled.
export const value: number = "not-a-number";
