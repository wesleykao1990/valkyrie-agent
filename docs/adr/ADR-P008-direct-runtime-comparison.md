# ADR-P008: fixed-contract direct-runtime comparison boundary

Status: proposed

## Context

The M5b pilot proved one Atomic-owned workflow using a scoped host-side Codex
subscription broker. The existing comparison endpoint and direct CLI adapters are
prototype demonstrations: they use mock workflows or marker-only read probes and
cannot produce a fair writer comparison.

Running Codex directly inside the writer would require mounting subscription
credentials or exporting OAuth state. Reusing the Atomic workflow for a Codex
candidate would also violate the one-root-runtime rule and make the comparison
circular.

## Proposed decision

1. Add a fixed-fixture direct coordinator whose root runtime is Codex. It owns its
   candidate lifecycle directly and never starts Atomic.
2. Reuse the control-plane-owned scoped inference broker, exact fixture commit,
   isolated writer boundary, deterministic checks, fresh verifier rubric,
   governed exports, and approval contract. Reuse policy mechanisms, not Atomic's
   graph or session state.
3. Give every candidate a distinct run, worktree, container, lease owner/fence,
   capability, artifact set, approval, and native evidence stream.
4. Persist a comparison aggregate and immutable candidate metric snapshots.
   Metrics are derived from authoritative run, inference, artifact, and approval
   records and cannot substitute for their evidence.
5. Keep the first direct path narrow: one reviewed target file, one fixed test,
   one fresh verifier, and at most one repair. It is not a general remote coding
   service.
6. Keep Claude Code a separate root candidate behind its own default-off auth and
   runtime gate. Absence of a verified Claude subscription boundary must report
   unavailable, never fall back to Codex or an ambient Claude profile.
7. Preserve the final-action boundary. Candidate acceptance records only a safe
   mock receipt; a real GitHub draft PR remains separately authorized work.

## Rejected alternatives

- Treating marker-only CLI connectivity as implementation evidence.
- Letting direct Codex or Claude drive Atomic's workflow graph.
- Sharing an Atomic worktree, writer lease, capability, or approval with a direct
  candidate.
- Mounting `~/.codex`, `~/.claude`, browser/keychain state, or provider tokens in
  the writer container.
- Selecting a default runtime from one fixture or from completion status alone.

## Consequences

The control plane gains a second narrow lifecycle coordinator and a comparison
ledger, which increases integration complexity but makes the A/B evidence
meaningful. The implementation can use Wesley's existing dedicated ChatGPT
subscription profile for Codex without another credential. Claude requires a
separate verified credential/auth decision before live execution. The ADR remains
proposed until Wesley accepts or amends this architectural decision. The fixed
live comparison and evidence review completed on 13 August 2026; that evidence
does not by itself select a default runtime.

The integration-complexity metric is a transparent ordinal seam count, not a
quality score: Atomic counts the control-plane lifecycle, writer boundary, native
RPC transport, main session, workflow graph, inference bridge, scoped gateway,
and subscription broker (8); direct Codex counts the control-plane lifecycle,
writer boundary, direct coordinator, scoped gateway, and subscription broker (5).
`defectsCaught` is likewise the fixed pilot's evidence-backed repair trigger (0
or 1), not a general defect-density estimate.

The first live fixture showed why elapsed time must remain descriptive rather than
decisive. Atomic used eight stateless model requests and 134,670 input tokens;
direct Codex used three and 34,933. Atomic's 83,188 ms versus direct's 27,267 ms
was primarily repeated tool-loop/model wait, not deterministic verification.
Neither candidate found a defect or repaired its output. This supports direct
Codex for the tested tiny task, while Atomic's richer workflow/event structure
still needs multi-task evidence before its overhead can be judged worthwhile.
