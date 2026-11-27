#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const steps = [
  { name: "lint", command: ["npm", "run", "lint"] },
  { name: "unit tests", command: ["npm", "test"] },
  // Prints the full report. Gate fails on critical; Next 15's nested postcss
  // highs are reported until a Next 16 upgrade clears them. On GitHub, the
  // Dependency review workflow also fails PRs that add high or critical
  // advisories. This step stays so the gate holds on paths without it.
  { name: "security audit", command: ["npm", "audit", "--audit-level=critical"] },
];

let failed = false;
for (const step of steps) {
  process.stdout.write(`\n==> ${step.name}\n`);
  const result = spawnSync(step.command[0], step.command.slice(1), {
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    failed = true;
    process.stderr.write(`ci: ${step.name} failed with exit ${result.status ?? "unknown"}\n`);
  }
}

if (failed) {
  process.exit(1);
}
process.stdout.write("\nci: lint, unit tests, and security audit passed\n");
