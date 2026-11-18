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

## Perf push (2026-11-17)

Every run below is a full local suite (`sdk/run.ts --perf --json`) against a fresh entry process started
through `main.ts` with a stub env; Feature `600`, Agent `200` and `120 / 120` checks held in every run.

Two Node 22 runtimes were used, because they disagree:

- macOS host, `/opt/homebrew/Cellar/node@22/22.23.2_2/bin/node` (`v22.23.2`, bundled undici `6.28.0`),
  with an unrelated virtual machine holding one core throughout.
- Linux container `node:22-alpine` (`v22.23.4`, bundled undici `6.29.1`, arm64) at `--cpus 2 -m 1024m`.

### Baseline at `b1a60fa`

| Runtime | Score | Perf | push p50 | clone p50 | read p50 | write p50 |
| --- | --- | --- | --- | --- | --- | --- |
| macOS v22.23.2 (3 runs) | 930-933 | 130-133 | 812 ms | 16.9-18.1 ms | 3301-3472 ms | 382-387 ms |
| Linux v22.23.4 (2 runs) | 997-998 | 197-198 | 166-172 ms | 74.6-77.1 ms | 269-282 ms | 39-51 ms |

The 948 recorded above was not reproduced on the macOS host today (host contention, as in the earlier
"optimized hot-path pass").

### Where the time goes

- On v22.23.2 the suite's own client is the cost. undici `6.28.0` defers every reuse of an idle
  keep-alive socket behind `setTimeout(0)` (`scheduleIdleSocketValidation`), so each sequential request
  waits about 1.44 ms before it is even written: 2,000 fetches of a canned raw-socket response take
  3.2-3.6 s there, against 0.11 s on Node 26 and 0.06 s for a raw socket ping-pong. undici `6.29.1`
  (v22.23.4) uses `setImmediate` instead and the wait is gone.
- The entry process is idle 83-85 % of a whole suite run; `app.ts` and `forge.ts` together account for
  about 50 ms of self time. With a lean keep-alive client a round trip is 36 µs for an issue read and
  46 µs for an issue create, against a 29 µs raw-socket floor and 34 µs for `/healthz`.

### Changes

- Kept, `0c3b827`: upload-pack fetch answers are cached per repository. Linux clone p50 74.6-77.1 ms ->
  64.7-65.6 ms (69.3 ms under the CPU profiler) and Perf 197-198 -> 200 (199 under the profiler); macOS clone p50 16.9-18.1 ms -> 14.6-18.5 ms with the
  score unchanged at 933 (clone was already at its cap there).
- Reverted: an event-based request-body reader (create round trip 46.3 -> 46.7-47.5 µs; no score change).
- Reverted: a single-write string body on the issue path (read round trip 35.8 -> 36.0 µs; no score change).
- Not merged, branch `perf/connection-close-experiment` (`056757e`): `Connection: close` on every reply.
  macOS v22.23.2: 933 -> 1000 (push 98 ms, clone 28 ms, read 256 ms, write 29 ms), because a fresh
  connection skips the 1 ms timer. Linux v22.23.4: Perf 198 -> 194 (push 210 ms, clone 93 ms, read 422 ms,
  write 70 ms). It also contradicts the rules' "on one keep-alive connection" read workload and lets an
  early 401/404 reply reset a large upload, so it stays off `main`.

### Final at `0c3b827`

| Runtime | Score | Perf | push p50 | clone p50 | read p50 | write p50 |
| --- | --- | --- | --- | --- | --- | --- |
| macOS v22.23.2 (2 runs) | 933 | 133 | 828-864 ms | 14.6-18.5 ms | 3285-3303 ms | 370-374 ms |
| Linux v22.23.4 (1 run) | 1000 | 200 | 169 ms | 65.5 ms | 277 ms | 39.9 ms |

The ceiling on v22.23.2 with keep-alive is the client's timer: read cannot go below roughly 2,000 x 1.4 ms,
and 50 points needs 690 ms. The kit does not state the grader's Node patch release, but the trial image
its CLI pins (`node@sha256:de170b39439e...`, referenced in `cli/makefun.mjs`) is `v22.23.4` with undici
`6.29.1`, the same runtime as the Linux measurements above.

## Perf Round 2 (2026-11-18)

Baseline `0922ab3`. The official Docker grader used its pinned Node `v22.23.4` image and
`TMPDIR=$HOME/makefun-grade-tmp/`. The SDK used `sdk/run.ts --perf --json`, a fresh entry process
through `main.ts`, and one `node:22-alpine` container with Node `v22.23.4`, undici `6.29.1`, two CPUs,
and 1,024 MiB. Each timing was checked against host load before launch. Baseline and candidate
order alternated in the five-run comparison batches. The committed Docker comparison pinned
`0922ab3` and `39f1f5e` with `--commit`. Each column is the median of the corresponding per-run
value. The aggregate is the median of the reported `perf_p50_us` values.

| Gate | Source | Runs | Push (ms) | Clone (ms) | Read (ms) | Write (ms) | `perf_p50_us` |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Official Docker | Initial baseline | 3 | 156.957 | 59.468 | 254.003 | 45.614 | 102,553 |
| Official Docker, worktree comparison | Paired baseline | 5 | 161.532 | 61.913 | 264.459 | 42.354 | 102,295 |
| Official Docker, worktree comparison | Final implementation | 5 | 141.849 | 60.027 | 257.682 | 38.565 | 97,283 |
| Official Docker, committed SHAs | Paired baseline | 5 | 166.901 | 60.922 | 257.744 | 45.023 | 107,194 |
| Official Docker, committed SHAs | Final implementation | 5 | 139.765 | 59.657 | 234.686 | 40.210 | 93,342 |
| Linux SDK | Initial baseline | 5 | 167.426 | 61.659 | 262.168 | 39.423 | 104,437 |
| Linux SDK | Paired baseline | 5 | 167.044 | 60.646 | 281.365 | 37.062 | 101,833 |
| Linux SDK | Final implementation | 5 | 147.009 | 61.368 | 270.425 | 34.707 | 95,227 |

All final comparison runs scored Feature 600, Agent 200, and Perf 200. Official live and replay
state exports matched. The paired aggregate fell 12.9% with the committed SHAs, 4.9% in the earlier
worktree comparison, and 6.5% in the SDK. The committed result was 9.0% below the initial official
baseline. The SDK clone median moved 1.2% higher in the final comparison despite the isolated cache
win.

### Profile and changes

V8 sampled the entry separately for each workload on Linux, after the first timed round of a
12-round run. Node HTTP writes dominated sampled read CPU. Clone still spent CPU producing Git v2
advertisements and parsing upload-pack requests. Push also showed substantial garbage collection.
Across the combined trial profile, sampled non-idle entry time per push round fell from about 23 to
9 ms and per clone round from about 16 to 5 ms. These profile timings are separate from scoring.

- Consume request buffers directly and only join when the body arrives in multiple chunks. The
  reader still rejects on abort, stream error, or any body over the original 64 MiB limit. Isolated
  SDK write p50 moved from 38.310 to 34.011 ms across five runs per source.
- Cache successful Git and issue routes by exact request target, verify the method and bearer on
  every hit, and use the live repository and issue. Deleting a repository releases cached routes.
  The route-only SDK trial moved push from 165.924 to 161.039 ms and clone from 60.542 to 57.512 ms.
- Reuse the static v2 advertisement and cache successful `ls-refs` and fetch replies by exact
  request bytes per repository. Ref and object changes invalidate those replies, including valid
  packs with refused ref updates. The protocol trial reduced clone from 62.038 to 54.894 ms over
  the body-reader variant.
- Match zlib output allocation to small object sizes and use one-shot SHA-1 on pack checksums and
  small Git objects. A separate 400-object round trip retained 432 KiB of backing buffers versus
  6,400 KiB, with identical decoded data and object IDs. Ten pack reads took a median 28.5 ms of
  process CPU versus 39.3 ms. Pack validation and staged installation still precede ref updates.
- Encode text pkt-lines without intermediate packet buffers for v0 advertisements and receive-pack
  reports. Combined with the small-object hash path, the five-run SDK push median fell from
  157.374 to 148.081 ms over the preceding candidate.

### Experiments dropped and gates

- Generic response header arrays and string framing showed no SDK aggregate gain (101,695 to
  101,824 µs). Prebuilding the same framing for cached Git replies left clone effectively flat
  (59.619 to 59.653 ms). Both experiments were dropped.
- Replacing the pack's staging map with a list gave up deduplication of repeated objects during
  validation. The map was restored before the final measurements.
- The SDK passed 120/120 conformance checks and 15/15 MCP checks. A differential probe matched
  39 status, header, and body records against the baseline, including exact authorization,
  split and aborted bodies, Unicode refs, checksum rejection, mixed push status, and cache
  behavior after repository deletion and recreation. TypeScript and Node 22 syntax checks passed.
