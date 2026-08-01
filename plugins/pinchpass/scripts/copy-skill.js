#!/usr/bin/env node
/**
 * Copies the canonical universal skill from the repo root
 * (skills/pinchpass/SKILL.md) into the package (skills/pinchpass/SKILL.md)
 * so the Pi package ships the exact same skill as skills.sh.
 */
import { copyFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const repoRoot = join(packageRoot, "..", "..");

const src = join(repoRoot, "skills", "pinchpass", "SKILL.md");
const dest = join(packageRoot, "skills", "pinchpass", "SKILL.md");

mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);
console.log(`Copied skill → ${dest}`);
