#!/bin/sh
# Vercel "Ignored Build Step": exit 0 skips the build, exit 1 builds.
# Skips when the last commit touched only docs, CI config or repository metadata,
# to stay under the Hobby plan's 100 deployments per 24 hours.
# If the diff can't be computed (shallow clone), build.
git diff --quiet HEAD^ HEAD -- . \
  ':!docs' ':!*.md' ':!.github' ':!LICENSE' ':!NOTICE' ':!CLA.md' ':!PLAN.md' ':!scripts/git-flow*' ':!scripts/check-pr-source.mjs' 2>/dev/null
case $? in
  0) echo "Only docs or repository metadata changed; skipping the build."; exit 0 ;;
  *) exit 1 ;;
esac
