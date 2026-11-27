#!/bin/sh
# Vercel "Ignored Build Step": exit 0 skips the build, exit 1 builds.
#
# The Hobby plan allows 100 deployments per 24 hours, and CI already builds and
# tests every PR. So a preview is built only when the last commit changed
# something a person would look at in a browser: pages, components, themes,
# styles, static files or the framework and dependency config. Production
# always builds. If the diff can't be computed (shallow clone), build.
if [ "$VERCEL_ENV" = "production" ]; then
  exit 1
fi
git diff --quiet HEAD^ HEAD -- \
  'app/**/*.tsx' 'app/**/*.css' 'app/*.tsx' 'app/*.css' \
  'components' 'themes' 'public' \
  'next.config.*' 'package-lock.json' 'vercel.json' 'tsconfig.json' 2>/dev/null
case $? in
  0) echo "No UI, theme or dependency change in this commit; skipping the preview build."; exit 0 ;;
  *) exit 1 ;;
esac
