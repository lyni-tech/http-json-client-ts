#!/usr/bin/env bash
(
  set -e
  set -x
  npm ci
  npm run vitest
) || exit 1

if ! (git branch --show-current | grep -q -E '^main$'); then
  echo "Current git branch is not main."
  exit 1
fi

if [ -n "$(git status -s)" ]; then
  echo "Git repo has uncommitted changes"
  exit 1
fi

version=$(cat package.json |jq --raw-output '.version')
if ! (echo "$version" | grep -q -E '^[0-9]+\.[0-9]+\.[0-9]+$'); then
  echo "package.json has invalid version '$version'"
  exit 1
fi

# Create git tag pointing at HEAD, if it doesn't already exist.
if [ -n "$(git tag --list "$version")" ]; then
  if [ -n "$(git tag --list "$version" --points-at HEAD)" ]; then
    echo "git tag '$version' already exists and points at HEAD"
  else
    echo "git tag '$version' already exists and doesn't point at HEAD.  Did you forget to bump the version in package.json?"
    exit 1
  fi
else
  echo "git tag '$version' does not exist.  Creating it."
  (
    set -x
    git tag -m "$version" "$version"
  ) || exit 1
fi

set -e
set -x
git push --follow-tags
npm publish
