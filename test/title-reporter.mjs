/**
 * A node:test reporter that prints each test's name as one JSON line and
 * nothing else, for test/log-hygiene.test.mjs. JSON keeps every name on one
 * line whatever it holds; failure details are left out, so only titles are
 * judged.
 */
export default async function* titleReporter(source) {
  for await (const event of source) {
    if (event.type === "test:start") yield `${JSON.stringify(event.data.name)}\n`;
  }
}
