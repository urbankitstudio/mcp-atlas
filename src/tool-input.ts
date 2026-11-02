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
 * which take in CR, LF and TAB), the C1 controls U+0080-U+009F (NEL, U+0085,
 * is a line break to some readers, and CSI, U+009B, starts a terminal escape),
 * the Unicode line and paragraph separators U+2028 and U+2029, and the whole
 * Bidi_Control set (U+061C, U+200E, U+200F, U+202A-U+202E and U+2066-U+2069),
 * which can reorder how the text is displayed. Other invisible characters,
 * such as U+200B, U+FEFF and the soft hyphen U+00AD, still pass: they break no
 * line and reorder nothing.
 */
import { z } from "zod/v3";

export const NO_CONTROL_CHARS_RE =
  /^[^\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]*$/;

export const CONTROL_CHARS_MESSAGE =
  "must not contain control characters, line breaks or bidi controls (U+0000-U+001F, U+007F-U+009F, U+061C, U+200E, U+200F, U+2028, U+2029, U+202A-U+202E, U+2066-U+2069)";

/** A string argument that refuses control characters, line separators and bidi controls. */
export function freeText() {
  return z.string().regex(NO_CONTROL_CHARS_RE, CONTROL_CHARS_MESSAGE);
}
