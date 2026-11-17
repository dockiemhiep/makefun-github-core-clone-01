# Build notes

All suite runs use `/opt/homebrew/Cellar/node@22/22.23.2_2/bin/node` (`v22.23.2`).

## Starter baseline

Untouched `starter/`, local SDK full run (`--perf --json`):

- Working: `1`
- Score: `15 / 1000`
- Feature: `15 / 600` (`3 / 120` checks)
- Agent: `0 / 200` (`0 / 15` MCP checks)
- Performance: `0 / 200`
- Workload p50: push/clone/read/write all unmeasured (`1,000,000,000 ms` sentinel) because repository creation returned 404
- Passing checks: `repos.root`, `repos.not-found`, `protocol.unknown-route-json-404`

## Surface deltas

### Git smart HTTP v2 / receive-pack v0

- Local SDK run: `36 / 120` checks, feature `180`, agent `0`, perf not run, score `180`
- Git group: `30 / 30`
- Incidental prerequisite passes: repos `4 / 15`, protocol `2 / 5`
- Delta vs starter: `+33` checks, `+165` score

### REST v3

- Local SDK run: `85 / 120` checks, feature `425`, agent `0`, perf not run, score `425`
- Repositories: `15 / 15`; issues: `15 / 15`; pulls: `20 / 20`; protocol: `5 / 5`
- Git remained `30 / 30`
- Delta vs previous run: `+49` checks, `+245` score; delta vs starter: `+82` checks, `+410` score

### GraphQL v4

- Local SDK run: `105 / 120` checks, feature `525`, agent `0`, perf not run, score `525`
- GraphQL: `20 / 20`; all Git and REST groups remained green
- Delta vs previous run: `+20` checks, `+100` score; delta vs starter: `+102` checks, `+510` score

### MCP

- Local SDK run: `120 / 120` checks, feature `600`, agent `200`, perf not run, score `800`
- MCP: `15 / 15`; every other group remained green
- Delta vs previous run: `+15` checks, `+275` score (including the full agent-native column)
- Delta vs starter before performance: `+117` checks, `+785` score

## Performance passes

### First full pass

- Conformance: `120 / 120`; feature `600`, agent `200`
- Performance: `148 / 200`; local score `948 / 1000`
- p50: push `584.705 ms`, clone `17.181 ms`, read `2710.179 ms`, write `277.721 ms`
- Workload points: push `44`, clone `50`, read `25`, write `29`

### Optimized hot-path pass

Issue reads now use cached serialized bodies and direct route dispatch; issue creates bypass unrelated
route matching; request bodies avoid a one-chunk copy; response date formatting is disabled. Git
authentication and malformed percent-encoding handling were hardened at the same time.

- Conformance remained `120 / 120`
- Performance: `134 / 200`; local score `934 / 1000`
- p50: push `765.198 ms`, clone `17.758 ms`, read `3339.496 ms`, write `386.398 ms`
- The host had a separate virtualization process consuming a full CPU throughout this pass; the
  across-the-board regression is treated as host contention, not an optimization delta.

### Final clean gate

Fresh Node process after all server changes:

- Working: `1`
- Feature: `600 / 600` (`120 / 120` conformance checks)
- Agent: `200 / 200` (`15 / 15` MCP checks)
- Performance: `148 / 200`
- Final local score: `948 / 1000`
- p50: push `581.292 ms`, clone `17.983 ms`, read `2691.213 ms`, write `279.311 ms`
- Workload points: push `44`, clone `50`, read `25`, write `29`
- Aggregate `perf_p50_us`: `297730`

The rules run every trial in a fresh process and do not require state to survive a restart, so no
restart-persistence gate applies; state is intentionally process-local and in memory.

## Review gates

- Node 22 syntax checks passed for `app.ts`, `forge.ts`, and `main.ts`.
- `git diff --check` passed.
- HTTP correctness is covered by all `5 / 5` protocol checks plus the Git smart-HTTP checks. The
  web-platform baseline has no browser-rendered UI rules applicable to this server-only entry.
- Security review: all scored surfaces except `/healthz` require the exact bearer token; tokens are
  neither logged nor returned; malformed URL encoding is contained; JSON and request bodies are
  bounded; pack object inflation has a 64 MiB output ceiling; no filesystem paths, shell commands,
  subprocesses, outbound requests, SQL, templates, or runtime dependencies are used.
- Static secret-pattern and dangerous-API searches passed. `gitleaks`, `trufflehog`, `semgrep`, and
  `osv-scanner` were not installed; dependency scanning is not applicable because the entry has no
  dependencies or lockfile.
