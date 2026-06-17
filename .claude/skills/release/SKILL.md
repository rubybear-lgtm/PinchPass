---
name: release
description: Tag and push a new version to trigger the GitHub Actions release workflow
disable-model-invocation: true
---

Release a new version of pinchpass. Usage: `/release <version>` (e.g. `/release v1.2.0`).

The version tag is passed as `$ARGUMENTS`.

## Steps

1. Validate the version argument matches `v\d+\.\d+\.\d+` format. Abort if missing or malformed.
2. Check that the working tree is clean (`git status --porcelain`). Abort if dirty.
3. Check that the current branch is `master`. Warn if not.
4. Create an annotated git tag: `git tag -a $ARGUMENTS -m "Release $ARGUMENTS"`
5. Push the tag: `git push origin $ARGUMENTS`
6. Confirm the release workflow was triggered: `gh run list --workflow=release.yml --limit=1`
7. Print the tag name and a link to the GitHub Actions run.
