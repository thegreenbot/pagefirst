#!/usr/bin/env node
// CI gate: fails a pull request into main unless it comes from a
// release/vX.Y.Z or hotfix/vX.Y.Z branch. Reads BASE_REF and HEAD_REF.
import { checkPullRequestSource } from "./git-flow.mjs";

const base = process.env.BASE_REF ?? "";
const head = process.env.HEAD_REF ?? "";
const result = checkPullRequestSource(base, head);
if (!result.ok) {
  process.stderr.write(`git-flow: ${result.message}\n`);
  process.exit(1);
}
process.stdout.write(`git-flow: ${head || "(none)"} may merge into ${base || "(none)"}\n`);
