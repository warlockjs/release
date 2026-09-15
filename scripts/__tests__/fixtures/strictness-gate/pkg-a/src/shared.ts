// Deliberate type error (TS2322). This file is relative-imported by pkg-b
// (outside pkg-b's rootDir), so it is pulled into pkg-b's program too. Used
// as the UNCHANGED case: a non-containment diagnostic in a file under pkg-a,
// surfaced while compiling pkg-b's program, still follows the existing
// file-directory ownership rule -- it stays owned by pkg-a.
export const shared: number = "also-not-a-number";
