/**
 * The one check every free-text tool argument passes at the boundary.
 *
 * Tools echo their arguments into a plain-text answer (the owner name inside
 * the printed WHERE clause, an unknown state inside "No covered counties
 * found"). A line break in an argument can therefore start a line of its own
 * in that answer, such as a fake "Query URL:" heading over an unfiltered URL.
 * SQL escaping does not help: the text stays inside the literal and still
 * breaks the line. So every free-text argument in every tool's schema is built
 * here, and it refuses the ASCII control characters (U+0000-U+001F and U+007F,
 * which take in CR, LF and TAB) and the Unicode line and paragraph separators
 * U+2028 and U+2029.
 */
import { z } from "zod/v3";

export const NO_CONTROL_CHARS_RE = /^[^\u0000-\u001F\u007F\u2028\u2029]*$/;

export const CONTROL_CHARS_MESSAGE =
  "must not contain control characters or line breaks (CR, LF, TAB, NUL, U+2028, U+2029)";

/** A string argument that refuses control characters and line separators. */
export function freeText() {
  return z.string().regex(NO_CONTROL_CHARS_RE, CONTROL_CHARS_MESSAGE);
}
