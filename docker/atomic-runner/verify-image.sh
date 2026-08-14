#!/usr/bin/env bash
set -euo pipefail

image_ref="${1:?usage: verify-image.sh IMAGE_REFERENCE [ENGINE]}"
engine="${2:-docker}"

"${engine}" run --rm \
  --pull never \
  --network none \
  --read-only \
  --user 65532:65532 \
  --workdir /tmp \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,mode=1777 \
  --env HOME=/tmp/home \
  --entrypoint /bin/bash \
  "${image_ref}" \
  -ceu '
    test "$(/usr/bin/git --version)" = "git version 2.50.1"
    test "$(atomic --version)" = "0.9.12"

    mkdir -p "$HOME" /tmp/relative-worktree-probe
    cd /tmp/relative-worktree-probe
    /usr/bin/git init --quiet main
    /usr/bin/git -C main config user.name "Valkyrie runner probe"
    /usr/bin/git -C main config user.email "runner-probe@invalid.example"
    printf "%s\n" baseline > main/probe.txt
    /usr/bin/git -C main add probe.txt
    /usr/bin/git -C main commit --quiet -m baseline
    /usr/bin/git -C main worktree add --quiet --relative-paths -b probe ../linked HEAD
    test "$(/usr/bin/git -C main config --get extensions.relativeWorktrees)" = "true"
    test "$(/usr/bin/git -C linked status --short)" = ""

    printf "%s\n" "atomic=$(atomic --version)" "$(/usr/bin/git --version)" "relative_worktrees=ok" "network=none"
  '
