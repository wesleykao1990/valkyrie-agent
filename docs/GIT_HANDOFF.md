# Git handoff

The downloadable ZIP contains a Git bundle at:

```text
handoff/Wesley_Agent_Control_Plane_Prototype_v0.2.2.bundle
```

A Git bundle preserves the complete prototype repository history without requiring a hosted remote.

## Clone from the bundle

From the extracted package's parent directory:

```bash
git clone Wesley_Agent_Control_Plane_Prototype_v0.2.2/handoff/Wesley_Agent_Control_Plane_Prototype_v0.2.2.bundle wesley-agent-control-plane
cd wesley-agent-control-plane
npm run verify
```

## Continue in the extracted source directory instead

The ordinary source tree is also complete. Open its root in Codex or Claude Code and instruct the agent to read:

1. `START_HERE.md`
2. `AGENTS.md`
3. `CLAUDE.md`
4. `docs/DECISIONS.md`
5. `docs/CONTINUATION_PLAN.md`
6. `docs/PROMPT_FOR_CODEX_OR_CLAUDE.md`

Then run:

```bash
npm run verify
```

## Add a hosted remote later

```bash
git remote add origin <your-private-repository-url>
git push -u origin main
```

Do not commit secrets, provider tokens, local SQLite databases, generated workspaces, or run artifacts.
