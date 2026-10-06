#!/usr/bin/env node
/**
 * Design drift gate for CI — fails on reintroduced legacy dialects.
 * Counts are informational; hard failures are structural (depas import, class names).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../src", import.meta.url));
const DEPAS_IMPORT = /depas\.css/;
const DEPAS_CLASS =
  /\bdepas-(?:view|app|nav|sheet|offline|main|topbar|brand|viewkop|viewsub)/g;
const LEGACY_TOKEN = /--(?:wijn|gietijzer)(?:-[a-z0-9]+)*\b/gi;
const HEX = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(tsx?|css)$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk(ROOT);
const failures = [];
let depasClassHits = 0;
let legacyTokenHits = 0;
const hexInTsx = new Set();

for (const file of files) {
  const rel = relative(join(ROOT, ".."), file);
  const text = readFileSync(file, "utf8");
  if (DEPAS_IMPORT.test(text)) {
    failures.push(`${rel}: imports depas.css`);
  }
  const depas = text.match(DEPAS_CLASS);
  if (depas) {
    depasClassHits += depas.length;
    failures.push(`${rel}: ${depas.join(", ")}`);
  }
  const legacy = text.match(LEGACY_TOKEN);
  if (legacy) {
    legacyTokenHits += legacy.length;
    failures.push(`${rel}: ${legacy.join(", ")}`);
  }
  if (file.endsWith(".tsx")) {
    for (const m of text.matchAll(HEX)) hexInTsx.add(m[0].toLowerCase());
  }
}

console.log("Design drift check");
console.log(`  files scanned: ${files.length}`);
console.log(`  depas class hits: ${depasClassHits}`);
console.log(`  legacy token hits: ${legacyTokenHits}`);
console.log(`  distinct hex in TSX: ${hexInTsx.size}`);

if (failures.length > 0) {
  console.error("\nFAIL — legacy dialect detected:");
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}

console.log("\nPASS — no legacy dialect violations");
