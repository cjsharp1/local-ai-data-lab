/**
 * copy-data.ts — copies data/ into dist/data, after a build.
 *
 * Run as part of:  npm run build
 *
 * tsc compiles .ts and ignores everything else. Without this step a build
 * produces a dist/ with no database in it, and the built data server
 * fails on its first query.
 *
 * ---------------------------------------------------------------------------
 * Why the database has to sit at dist/data
 * ---------------------------------------------------------------------------
 *
 * data-server/db.ts finds the database relative to ITS OWN FILE —
 * `../data/checkpoint.db` — not relative to the current directory. That
 * is deliberate: the app spawns the data server as a child process, and a
 * path that depended on cwd would break as soon as anything launched it
 * from a different folder.
 *
 * The same relative path then gives two locations:
 *
 *   npm run dev     data-server/db.ts       →  data/checkpoint.db
 *   after build     dist/data-server/db.js  →  dist/data/checkpoint.db
 *
 * So this script puts a copy at the second one. The failure it prevents
 * is easy to miss, because `npm run dev` runs the source through tsx and
 * never touches dist/ at all.
 *
 * A script rather than a shell command in package.json, because `cp -r`
 * and `xcopy` are not the same on both platforms.
 *
 * A missing database is reported, not fatal: the build still produces
 * working code, and `npm run seed` followed by another build fixes it.
 */

import { cp, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

const FROM = join(ROOT, "data");
const TO = join(ROOT, "dist", "data");

/**
 * Whether a path exists as a file.
 *
 * Distinguishes "not there" from "there but broken": ENOENT returns
 * false, anything else is rethrown, so a permissions problem is not
 * swallowed by a check meant to handle absence.
 */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

async function main(): Promise<void> {
  await mkdir(TO, { recursive: true });

  // schema.sql travels too: it is the readable copy of the structure, and
  // a dist/ folder handed to someone else should still explain itself.
  for (const name of ["checkpoint.db", "schema.sql"]) {
    const from = join(FROM, name);
    if (await isFile(from)) {
      await cp(from, join(TO, name));
      console.log(`Copied data/${name} → dist/data/${name}`);
    } else if (name === "checkpoint.db") {
      console.log("No data/checkpoint.db to copy — run `npm run seed`, then build again.");
    }
  }
}

await main();
