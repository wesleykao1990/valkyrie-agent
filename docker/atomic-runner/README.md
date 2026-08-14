# Atomic runner image

This image is the disabled-by-default, credential-free Atomic 0.9.12 runner for
the disposable Milestone 5 fixture. It is not a general developer image.

The Node base is pinned by manifest digest in `Dockerfile`. Git is built from the
official `git-2.50.1.tar.xz` release because Debian Bookworm's Git 2.39 does not
recognize `extensions.relativeWorktrees`. Relative worktree paths first appear in
Git 2.48; 2.50.1 exactly matches the macOS host version used for the live pilot.
The pinned binary is exposed at `/usr/bin/git`, which is the reviewed absolute
path in the Atomic fixture workflow contract.

Source provenance:

- Git source: `https://www.kernel.org/pub/software/scm/git/git-2.50.1.tar.xz`
- Git SHA-256: `7e3e6c36decbd8f1eedd14d42db6674be03671c2204864befa2a41756c5c8fc4`
- Checksum manifest: `https://www.kernel.org/pub/software/scm/git/sha256sums.asc`
- Atomic package: `@bastani/atomic@0.9.12`, integrity pinned in `package-lock.json`

Build, push to the loopback registry, and verify without network access:

```sh
docker build --pull=false -t localhost:5000/valkyrie-atomic-runner:0.9.12-m5a-git250 docker/atomic-runner
docker push localhost:5000/valkyrie-atomic-runner:0.9.12-m5a-git250
docker/atomic-runner/verify-image.sh localhost:5000/valkyrie-atomic-runner:0.9.12-m5a-git250
```

Use the pushed `@sha256:...` reference in control-plane configuration, never the
mutable tag. The verification probe runs as the production numeric user with a
read-only root, an ephemeral `/tmp`, and `--network none`; it checks Atomic, Git,
and an actual relative linked worktree.
