#!/bin/sh
# Vercel "Ignored Build Step": exit 0 skips the build, exit 1 builds.
#
# The Hobby plan allows 100 deployments per 24 hours, and CI already builds and
# tests every PR. So:
#   - production (main) always builds;
#   - pushes to develop, feature/* and any branch without an open PR never build;
#   - a PR preview builds only when the commit message contains "[preview]".
# The script cannot read PR labels (that needs a GitHub token), so the opt-in is
# the commit message. A preview can also be started from the Vercel dashboard.
if [ "$VERCEL_ENV" = "production" ]; then
  exit 1
fi
if [ -z "$VERCEL_GIT_PULL_REQUEST_ID" ]; then
  echo "No open pull request for this branch; skipping the build."
  exit 0
fi
case "$VERCEL_GIT_COMMIT_MESSAGE" in
  *"[preview]"*) exit 1 ;;
esac
echo "Add [preview] to the commit message to build a preview; skipping."
exit 0
