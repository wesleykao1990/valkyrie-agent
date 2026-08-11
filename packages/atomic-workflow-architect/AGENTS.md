# Atomic module instructions

This directory is the Atomic-specific execution module inside Wesley's larger Project OS repository. It is not the whole control plane.

- Follow the repository-root `AGENTS.md` and accepted architecture decisions.
- Preserve Atomic as one possible first-class root runtime; do not place it underneath Codex or Claude Code.
- Keep direct Codex and Claude paths available and keep Atomic pilot-gated.
- Keep skills, router, prompts, launch assets, and workflows independently testable.
- Keep generated workflows run- or project-scoped until reviewed and evaluated.
- Do not enable live runtime execution, credentials, network access, worktree mutation, or final actions through package-source changes alone.
- Preserve the nested private license and record derived-package changes in `CHANGELOG.md`.
- Run `npm run verify` after changes. Run `npm run typecheck` only when the pinned TypeScript toolchain is installed.

Read `START_HERE.md`, `skills/atomic-workflow-architect/SKILL.md`, and the relevant integration guide before editing behavior.
