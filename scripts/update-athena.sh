#!/usr/bin/env bash
#
# Brings your copy of Athena up to the newest release, on a branch of its own,
# and opens a pull request for you to merge. The "Update Athena" workflow
# (.github/workflows/update-athena.yml) runs this every week; you can also run
# it yourself from a clone of your copy:
#
#   scripts/update-athena.sh
#
# Environment:
#   ATHENA_UPSTREAM  where releases come from
#                    (default: https://github.com/matthojo/athena.git)
#   ATHENA_PUSH      "0" makes the branch locally, without pushing it or
#                    opening a pull request
#   GH_TOKEN         lets the GitHub CLI open the pull request (the workflow
#                    sets it)
#
# Two ways a copy can relate to Athena's repository:
#   - It shares history (you forked or cloned it): the release is merged in,
#     so changes you've made to your copy are kept unless they conflict.
#   - It doesn't (the Deploy to Netlify button copies files, not commits): the
#     release's files are copied over yours, and files the release removed
#     since your version are removed. Changes you made to Athena's own files
#     are replaced, and the pull request says so.
#
# Either way, your workflows (.github/workflows, .github/actions) stay as they
# are. A workflow on the pushed branch could run at once, with your
# repository's secrets, before anyone has read it, so the pull request lists
# the workflows a release changes, for you to copy across once you've read
# them.

set -euo pipefail

upstream="${ATHENA_UPSTREAM:-https://github.com/matthojo/athena.git}"
web="${upstream%.git}"
push="${ATHENA_PUSH:-1}"

cd "$(git rev-parse --show-toplevel)"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: commit or stash your changes first" >&2
  exit 2
fi

current="$(node -p "require('./package.json').version")"
latest="$(git ls-remote --tags --refs "$upstream" 'v*' \
  | sed 's#.*refs/tags/v##' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n1 || true)"

if [[ -z "$latest" ]]; then
  echo "No releases at $upstream yet."
  exit 0
fi
if [[ "$(printf '%s\n%s\n' "$current" "$latest" | sort -V | tail -n1)" == "$current" ]]; then
  echo "Up to date: this copy is $current, and the newest release is $latest."
  exit 0
fi

start="$(git rev-parse --abbrev-ref HEAD)"
base="$(git rev-parse HEAD)"
branch="athena-update/v$latest"
if [[ "$push" != 0 ]] && git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
  echo "$branch is already on your repository. Merge or close its pull request first."
  exit 0
fi

echo "Updating from $current to $latest."
target="refs/athena-upstream/v$latest"
git fetch --quiet --no-tags "$upstream" "+refs/tags/v$latest:$target"
git checkout --quiet -B "$branch"

if git merge-base HEAD "$target" >/dev/null 2>&1; then
  how="merged"
  if ! git merge --quiet --no-edit -m "Update Athena to $latest" "$target"; then
    git merge --abort
    git checkout --quiet "$start"
    echo "error: changes in your copy conflict with $latest. Merge it by hand:" >&2
    echo "  git fetch $upstream tag v$latest && git merge v$latest" >&2
    exit 1
  fi
else
  how="copied"
  git checkout "$target" -- .
  previous="refs/athena-upstream/v$current"
  if git fetch --quiet --no-tags "$upstream" "+refs/tags/v$current:$previous" 2>/dev/null; then
    git diff --no-renames --name-only --diff-filter=D "$previous" "$target" | while IFS= read -r gone; do
      git rm -q --ignore-unmatch -- "$gone"
    done
  else
    echo "note: $current isn't a release at $upstream, so files the update removed (if any) are still here."
  fi
  git commit --quiet -m "Update Athena to $latest"
fi

# Keep this copy's own workflows (see the top of this file).
workflows="$(git diff --no-renames --name-only "$base" HEAD -- .github/workflows .github/actions)"
if [[ -n "$workflows" ]]; then
  while IFS= read -r file; do
    if git cat-file -e "$base:$file" 2>/dev/null; then
      git checkout --quiet "$base" -- "$file"
    else
      git rm -q -- "$file"
    fi
  done <<<"$workflows"
  git commit --quiet -m "Keep this copy's own workflows"
  echo "Kept your own workflows. The release changes these, for you to copy across once you've read them:"
  sed 's/^/  /' <<<"$workflows"
fi

if [[ "$push" == 0 ]]; then
  echo "Made $branch here ($how). Not pushed: merge it into $start when you're ready."
  exit 0
fi

git push --quiet -u origin "$branch"

body="$(mktemp)"
{
  echo "Updates this copy of Athena from $current to $latest."
  echo
  echo "**What's new:** $web/releases/tag/v$latest"
  echo
  if [[ "$how" == "copied" ]]; then
    echo "This copy doesn't share history with Athena's repository (the Deploy to Netlify button copies files, not commits), so the release's files were copied over yours. If you've changed any of Athena's own files, check the diff: those changes are replaced here."
  else
    echo "The release was merged into your copy, so your own changes are kept."
  fi
  if [[ -n "$workflows" ]]; then
    echo
    echo "**Workflows:** this release changes the workflows below. Your own are kept as they were, since a workflow on this branch could run before anyone has read it. Read each one at the release, then copy it across yourself if you want it:"
    echo
    while IFS= read -r file; do
      echo "- [\`$file\`]($web/blob/v$latest/$file)"
    done <<<"$workflows"
  fi
  echo
  echo "Netlify builds a deploy preview of this pull request against a copy of your database, so any new database migrations run there before they reach your live site. The preview runs this release's code before you merge it, with whatever environment variables your deploy previews get. Keep \`ATHENA_DATA_KEY\`, \`MCP_BEARER_TOKEN\`, \`CONNECTOR_ENCRYPTION_KEY\`, \`SESSION_SECRET\` and \`SITE_PASSWORD\` to the Production context: then the preview can't read your content or sign in to your accounts, and its login page says it isn't set up. Check that it deployed, then merge, and Netlify updates your live site."
} >"$body"

if ! gh pr create --base "$start" --head "$branch" --title "Update Athena to $latest" --body-file "$body"; then
  echo "error: the branch is pushed, but the pull request couldn't be opened. Open it from GitHub, or see the README's \"Updating\" section." >&2
  exit 1
fi
