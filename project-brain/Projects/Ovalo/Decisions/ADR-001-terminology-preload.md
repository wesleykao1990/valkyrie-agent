---
id: ovalo-adr-001
type: decision
status: accepted
authority: canonical
project: ovalo
approved_by: wesley
---
# Preload terminology assets for low-latency interpretation

Phrase terminology and translation-memory assets should be pulled before a live call and prepared locally. A live API or MCP round trip is not part of the latency-critical path.

## Reasoning

The live path must prioritize predictable latency and graceful offline or degraded operation. External calls may be used for preparation and refresh, but not for each finalized segment.
