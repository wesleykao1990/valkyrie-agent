# Verification and Gates

## Evidence hierarchy

Strong evidence:

- deterministic test output;
- type/lint/build exit status;
- runtime/API/CLI probe;
- schema/code generation and validation;
- browser automation assertions plus screenshot/video;
- diff/commit and clean-worktree proof;
- artifact checksum;
- fresh independent review grounded in literal contract, actual files, and tool results;
- authenticated human judgment for product/design/high-consequence actions.

Weak evidence:

- implementer says it works;
- reviewer reads only the implementer's summary;
- circular tests authored to mirror the implementation;
- “looks good” without the contract or diff;
- old logs or remembered status;
- several reviewers repeating the same prompt/context.

## Author/verifier separation

```text
author produces candidate
→ fresh verifier derives probes from contract/risks
→ workflow-owned tools run probes
→ fresh evaluator interprets evidence
→ reducer creates one repair payload
→ forked author repairs
→ same probes rerun
```

Reviewer personas should map to distinct surfaces such as correctness, compatibility, security, performance, operations, or UX—not cosmetic plurality.

## Gates by risk

- API/schema/wire format: compatibility and schema-generation checks.
- Data migration: fixtures, dry run, rollback, idempotency, old/new reader compatibility.
- UI: behavior assertions, screenshot/video proof, and human visual gate.
- Security/permissions: negative tests, dangerous-path tests, and least privilege.
- Performance: benchmark against baseline/threshold.
- Release: version/changelog/build/package/install smoke and human approval.
- Generated workflow source: type check, reload, contract inspection, success/failure/bound tests.
- Stacked delivery: each slice proves its own contract before the next depends on it.

## Final-action separation

Implementation/review acceptance must be separable from:

- PR creation;
- merge;
- release tagging;
- deployment;
- external publication.

Once implementation criteria pass, stop the repair loop and expose the remaining final action as an explicit next action/gate.

## Bounds

Define pass, repair, failure, awaiting-input, cancelled, timed-out, budget-exceeded, and repair-bound-exhausted states before launch. Bound exhaustion is an inspectable failure, never success.
