import { spawnSync } from "node:child_process";
import { branchRef, tagRef } from "./git-flow.mjs";

const repo = process.argv[2] ?? "william-mccreery/page-first";

function origin(command, args) {
  const result = spawnSync("origin", [...command, "-R", repo, ...args], { encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0) {
    process.stderr.write(output);
    process.exit(result.status || 1);
  }
  process.stdout.write(output);
}

const protectedPush = ["block_direct_updates", "deletion", "non_fast_forward"];

function protect(branch, summary) {
  origin(["ruleset", "create"], [
    "--name",
    `${branch}: pull requests only`,
    "--description",
    summary,
    "--enforcement",
    "active",
    "--kind",
    "push_branch",
    "--included-ref",
    `refs/heads/${branch}`,
    ...protectedPush.flatMap((rule) => ["--rule", rule]),
    "--json",
    "id,name",
  ]);
  origin(["ruleset", "create"], [
    "--name",
    `${branch}: merge by pull request`,
    "--description",
    `Changes reach ${branch} through a pull request.`,
    "--enforcement",
    "active",
    "--kind",
    "merge_branch",
    "--included-ref",
    `refs/heads/${branch}`,
    "--rule",
    'pull_request={"requiredApprovingReviewCount":0}',
    "--json",
    "id,name",
  ]);
}

protect(
  "main",
  "Release and hotfix pull requests merge here. Direct pushes, force-pushes, and deletion are refused.",
);
protect(
  "develop",
  "Feature pull requests merge here. Direct pushes, force-pushes, and deletion are refused.",
);

origin(["ruleset", "create"], [
  "--name",
  "git-flow branch names",
  "--description",
  "Branches other than main and develop use feature/, cursor/, release/vX.Y.Z, or hotfix/vX.Y.Z.",
  "--enforcement",
  "active",
  "--kind",
  "push_branch",
  "--included-ref",
  "refs/heads/*",
  "--included-ref",
  "refs/heads/*/*",
  "--included-ref",
  "refs/heads/*/*/*",
  "--excluded-ref",
  "refs/heads/main",
  "--excluded-ref",
  "refs/heads/develop",
  "--rule",
  `ref_name_pattern={"pattern":${JSON.stringify(branchRef.source)},"negate":false}`,
  "--json",
  "id,name",
]);

origin(["ruleset", "create"], [
  "--name",
  "semver tags",
  "--description",
  "Tags are immutable vX.Y.Z semver names.",
  "--enforcement",
  "active",
  "--kind",
  "push_tag",
  "--included-ref",
  "refs/tags/**",
  "--included-ref",
  "refs/tags/*",
  "--rule",
  `ref_name_pattern={"pattern":${JSON.stringify(tagRef.source)},"negate":false}`,
  "--rule",
  "deletion",
  "--rule",
  "non_fast_forward",
  "--json",
  "id,name",
]);

origin(["repo", "edit"], ["--default-branch", "develop", "--json", "org,name,defaultBranch"]);
