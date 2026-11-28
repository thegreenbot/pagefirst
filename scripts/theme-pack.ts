/**
 * Packs a theme directory into the registry's archive format (#64).
 *
 *   npx tsx scripts/theme-pack.ts <dir> <out.tgz> [expected-version]
 *
 * Prints the archive's integrity. With expected-version (the release tag's
 * version), refuses to pack a theme whose theme.json says otherwise.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { loadThemeFromFiles, readThemeDir } from "@/lib/theme/package";
import { archiveIntegrity, packTheme } from "@/lib/theme/tarball";

const [dir, out, expected] = process.argv.slice(2);
if (!dir || !out) {
  console.error("usage: theme-pack.ts <dir> <out.tgz> [expected-version]");
  process.exit(2);
}
const files = readThemeDir(path.resolve(dir));
const { manifest } = loadThemeFromFiles(files);
if (expected && manifest.version !== expected) {
  console.error(`${dir}/theme.json is version ${manifest.version}, but the tag says ${expected}`);
  process.exit(1);
}
const archive = packTheme(files);
writeFileSync(out, archive);
console.log(`${manifest.name}@${manifest.version} ${archiveIntegrity(archive)} (${archive.length} bytes)`);
