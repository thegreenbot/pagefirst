#!/bin/sh
# Vercel "Ignored Build Step": exit 0 skips the build, exit 1 builds.
# Keeps us under the Hobby plan's 100 deployments per 24 hours.
#
# Production builds are skipped when the last commit touched only docs, CI config or
# repository metadata. Preview builds are stricter: they run only when the last commit
# touched something the running app is built from (not tests, infra, runbooks, docs,
# the Worker or release tooling), and never for Dependabot branches.
# If the diff can't be computed (shallow clone), build.

if [ "$VERCEL_ENV" = "preview" ]; then
  case "$VERCEL_GIT_COMMIT_REF" in
    dependabot/*) echo "Dependabot preview; skipping the build."; exit 0 ;;
  esac
  git diff --quiet HEAD^ HEAD -- \
    app components lib public themes middleware.ts next.config.ts \
    package.json package-lock.json tsconfig.json postcss.config.mjs vercel.json \
    ':!*.test.ts' ':!*.test.tsx' ':!lib/**/test-db.ts' 2>/dev/null
  case $? in
    0) echo "Nothing the app is built from changed; skipping the preview build."; exit 0 ;;
    *) exit 1 ;;
  esac
fi

git diff --quiet HEAD^ HEAD -- . \
  ':!docs' ':!*.md' ':!.github' ':!LICENSE' ':!NOTICE' ':!CLA.md' ':!PLAN.md' ':!scripts/git-flow*' ':!scripts/check-pr-source.mjs' 2>/dev/null
case $? in
  0) echo "Only docs or repository metadata changed; skipping the build."; exit 0 ;;
  *) exit 1 ;;
esac
