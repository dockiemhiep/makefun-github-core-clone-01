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

## Perf Round 2 — priced implementation (2026-11-18)

Implemented independently from `0922ab3` on `perf/round2-priced`. Only the baseline and the three
requested background records were used; no excluded branch, commit, or debate record was read.
Nothing was submitted or pushed.

### Method and baseline

One official Docker baseline and five fresh SDK runs completed before the first code edit. The
initial five official grades of the pinned `0922ab3` baseline all passed Feature 600 / Agent 200 /
Perf 200, with median `perf_p50_us` **70,852**. Their median workload p50s were push **107.896 ms**,
clone **36.153 ms**, read **203.418 ms**, write **30.412 ms**. This session's machine was substantially
faster than the earlier build record; the earlier 104,947 us is not used as the comparison baseline.

All final comparisons below use five fresh entry processes per version, alternating baseline and
candidate. Each workload still uses the SDK's five warm-ups and three measured rounds. Reported
columns are medians across the five runs; the aggregate is the median of the five `perf_p50_us`
values, not the geometric mean of the column medians.

- Official: unchanged kit CLI, `grade-local --driver docker --kit . --bot <repo>` with `--commit
  0922ab3` for baseline and `--worktree` for the candidate. `TMPDIR=$HOME/makefun-grade-tmp/` was
  exported for every invocation. Entry/env image digest remains `de170b39439e...`, Node 22.23.4 /
  undici 6.29.1. The CLI reports its existing harness Node 26.9.0 vs server 26.13.1 mismatch for both
  versions; the entry/env runtime is the pinned Node 22 image in both.
- SDK: unmodified `sdk/run.ts --perf --json` in `node:22-alpine`, Node 22.23.4 / undici 6.29.1,
  arm64, `--cpus 2 -m 1024m`; entry starts via `main.ts` with a stub coordinator. The entry and SDK
  share this container's limits, matching the earlier NOTES protocol.
- Host `uptime` was recorded before each alternating measurement; no run started above load 6.
  Noise remained visible below that threshold. Separate phase profiles use 25 rounds to collect
  samples; they are diagnostics, not replacements for the three-round grader measurements.
- Runner scripts, complete round arrays, JSON scores, replay exports, and CPU profiles are retained
  outside the repository at `$HOME/makefun-grade-tmp/round2-priced/`. The final prefixes are
  `official-validated-{base,candidate}-*` and `validated{base,}-pair*`.

| Method / version (5 runs each) | push p50 ms | clone p50 ms | read p50 ms | write p50 ms | perf_p50_us |
| --- | ---: | ---: | ---: | ---: | ---: |
| Official alternating baseline | 107.064 | 37.977 | 192.544 | 32.412 | 71,059 |
| Official final candidate | 104.019 | 39.643 | 188.918 | 31.281 | 68,410 |
| Linux SDK alternating baseline | 103.137 | 38.106 | 188.852 | 32.147 | 70,522 |
| Linux SDK final candidate | 98.497 | 34.986 | 182.199 | 27.821 | 64,542 |

Official final median: **71,059 -> 68,410 us (3.73% lower)** in the
interleaved comparison; 3.45% lower than the pre-edit baseline. The SDK
paired comparison improved 8.48%. The requested >=10% official improvement
was **not demonstrated**. All timing runs are retained, including outliers; none is discarded to
reach the target. In particular, final official candidate aggregates were 62994, 68410, 71299, 66134, 82560 us.

### Profile findings and retained changes

V8 inspector profiles sampled the Linux entry at 100 us during each isolated workload. Baseline
push was dominated by socket writes, GC, pack inflation, and body handling. Clone's remaining
application work was advertisements, ls-refs, and packet decoding. Issue reads still parsed URLs
and resolved repositories; writes added the async-iterator body lifecycle. Commit parsing was too
small to justify a metadata-cache refactor.

The staged SDK comparisons below each used five fresh full suites. They identify affected-workload
medians, not additive percentage guarantees:

| Change | Before -> after | Evidence / behavior |
| --- | --- | --- |
| Cache issue JSON as UTF-8 strings | read 188.641 -> 176.085 ms; write 30.730 -> 28.233 ms | node:http combines the header and string body; JSON bytes are unchanged |
| Cache exact issue request target + method | read 188.237 -> 179.012 ms | bounded 256 entries; every hit checks exact auth, live repository identity/owner, and Git generation; issue state is checked on every serialization-cache hit |
| Reuse issue response header arrays and byte length | read 189.162 -> 184.919 ms; write 31.237 -> 30.062 ms | avoids recreating header objects and rescanning UTF-8 text on each read |
| Right-size zlib output slabs for small objects | push 110.703 -> 104.652 ms | chunk size 64..16,384 bytes; checksum, output ceiling, object-size checks, storage, and ancestry checks remain intact |
| Reuse validated receive-pack success framing | isolated 25-round push entry CPU 842.4 -> 802.6 ms | bounded 256 refs; cache is consulted only after full pack ingestion and per-ref validation; mixed/rejected reports remain generated normally |
| Event-based, zero-copy body collection | write 31.062 -> 25.461 ms; SDK aggregate 66,130 -> 63,375 us | retains the 64 MiB cap and concatenates only multi-chunk bodies |
| Exact-byte upload-pack answer cache plus immutable v2 advertisement | clone 33.217 -> 31.614 ms; SDK aggregate 61,712 -> 60,291 us | caches both ls-refs and fetch, keyed by complete request bytes; repository generation, object count, and default branch invalidate it |

The upload cache retains the original 16-answer / 4 MiB-per-answer bounds and now limits cached
request keys to 64 KiB; larger requests still execute normally. Repository identity is a WeakMap
key, so deletion/recreation cannot reuse an old answer. Rejected pushes that ingest objects without
moving refs still invalidate by object count. The single-ref success report contains no repository
state and cannot bypass validation.

As a diagnostic across 25-round phases, entry user+system CPU fell from 1,026.7 -> 761.5 ms (push),
425.9 -> 369.2 ms (clone), 1,404.3 -> 1,241.9 ms (read), and 480.5 -> 386.2 ms (write). Push GC samples
fell from 116.6 -> 42.8 ms in the earlier allocation comparison. Profiles include setup and profiler
overhead and are not official timing claims. The final overflow repair only changes the reject path.

### Experiments rejected and correctness repair

- Removing only the Buffer copy did not pay: SDK aggregate 63,547 -> 65,157 us. It was reverted as a
  standalone change; zero-copy was retained only with the measured event-reader improvement.
- The initial advertisement/upload-cache combination did not pay with the original body reader
  (65,157 -> 66,532 us). It was reverted, then retained only after the later combined retest above.
- Small binary responses converted to latin1 strings (65,920 -> 66,604 us), a broad parsed-URL cache
  (66,604 -> 67,346 us), and splitting synchronous/async dispatch (63,375 -> 67,846 us) were reverted.
- No v0 advertisement cache was added: the push profile's advertisement cost was small and every
  successful push changes its generation. No parsed-commit cache or HTTP-stack replacement was kept.
- The first event reader called `req.destroy()` on overflow. A boundary comparison caught a socket
  reset where baseline answered JSON 400. Node's async iterator detaches the request socket before
  destroying its stream; the replacement now rejects and drains excess input with `req.resume()`.
  The 64 MiB limit is unchanged. A committed regression test accepts exactly 64 MiB, rejects 64 MiB
  + 1 with the exact JSON 400 body, and verifies the rejected request did not create an issue and
  subsequent requests still succeed. The same test failed with ECONNRESET against the unfixed
  candidate and passed against the repair.

### Verification

- Final SDK five-run pairs: 120/120 conformance and 15/15 MCP on every run, SDK/client EXIT=0 and
  measurement-driver EXIT=0. All scored workload operations completed, with Perf 200 throughout.
- Official five-run final pairs: Feature 600 / Agent 200 / Perf 200, score 1,000, EXIT=0 on every run. Live/replay exports match and L1 reproduces in every run.
- Independent HTTP differential probes: 330 comparisons passed, including UTF-8 response bytes,
  exact-token rejection after cache warm-up, REST/GraphQL state changes, MCP parity, cross-owner
  requests, malformed JSON/URLs, cache eviction, delete/recreate, split and aborted uploads, bad pack
  checksum/size/trailing bytes, mixed and stale ref reports, and shallow fetch/deepen requests.
  Boundary differential tests use two entries in a 2 GiB test container; scored runs use the 1 GiB
  configuration above. Both baseline and candidate answered JSON 400 at the invalid-JSON 64 MiB
  boundary and at 64 MiB + 1.
- `npm test` on Linux Node 22: EXIT=0. Regression sensitivity against the unfixed candidate: EXIT=1
  for the intended ECONNRESET failure. The positive limit/control requests pass.
- Node syntax checks and `git diff --check`: EXIT=0. Scoped secret-pattern / dangerous-API checks
  passed; runtime dependencies remain empty. Exact bearer-token comparison is unchanged.
- No lint/typecheck script or local tsc exists. gitleaks, trufflehog, semgrep, and osv-scanner were
  unavailable; no comprehensive scanner pass or live-grader performance result is claimed.
- All measurement/probe containers are task-owned and auto-removed. No dev server is left running.

### Review fix — deleted-repository retention (2026-11-18)

On successful repository deletion, the bounded issue-route map is now cleared so its cached
routes release the deleted Repository and its issues. The upload-response cache (`fetchCache`)
uses a `WeakMap<Repository, ...>`: its keys do not strongly retain repositories, so it needs no
explicit deletion eviction. The issue-body cache also uses weak keys. The optional body-limit
test improvement now asserts `req.reusedSocket` on the request following overflow.

Fresh processes in the pinned Docker image `de170b39439e...` (Node **22.23.4**, 2 CPUs,
1,024 MiB) drove create repo, POST issue, GET issue, DELETE repo (204), GET issue (404), then GC.
`v8.queryObjects(Repository, { format: 'count' })` measured:

| Version | Before creation | After issue POST and GET | After DELETE, GET and GC |
| --- | ---: | ---: | ---: |
| `4015f66` | 0 | 1 | 1 |
| Retention fix | 0 | 1 | 0 |

The same assertion fails against the archived `4015f66` for the intended retention defect
(EXIT=1) and passes after the fix (EXIT=0). A separate fresh process warmed upload-pack ls-refs
answers twice with old contents and an old-only branch before deletion; it also measured zero
live repositories after deletion and GC. Both probes passed same-name recreation checks. The
extended probe verified empty replacement issues/refs, new issue numbering and title, missing old
contents, and upload answers containing only the replacement's refs. Deleting the replacement
returned the instance count to zero again. Peak memory was not measured.

Five official Docker pairs compared the `4015f66` committed snapshot against the fixed worktree,
alternating pair order (base/fix, fix/base). Every invocation ran from the kit directory after
`export TMPDIR=$HOME/makefun-grade-tmp/`, using unchanged
`node cli/makefun.mjs grade-local --driver docker --kit . --bot <repo> --json --save <evidence>`
with `--commit 4015f66` or `--worktree`. `uptime` was recorded before every timing run; starting
one-minute load ranged from **2.04 to 3.18** on the shared Mac. The entry/env image remained pinned
to Node 22.23.4; the CLI's existing harness-version mismatch remains as described above.

| Pair | Order | `4015f66` perf_p50_us | Fixed perf_p50_us | Fixed time change |
| --- | --- | ---: | ---: | ---: |
| 1 | Base, fix | 76,371 | 69,624 | -8.83% |
| 2 | Fix, base | 66,310 | 61,997 | -6.50% |
| 3 | Base, fix | 66,536 | 62,024 | -6.78% |
| 4 | Fix, base | 64,117 | 66,334 | +3.46% |
| 5 | Base, fix | 64,830 | 67,704 | +4.43% |

All ten invocations scored **1,000/1,000: Feature 600 / Agent 200 / Perf 200**, EXIT=0,
with 120/120 checks including MCP 15/15, matching live/replay state, L1 reproduced, and zero
nondeterministic trials. The geometric mean of paired fixed/base timing ratios was **0.969941**
(**3.01% lower**). Separate medians were **66,310 -> 66,334 us (+0.04%)**. The measurements show
no aggregate regression beyond observed shared-host noise; no timed-workload speedup is attributed
to the deletion fix.

Additional fixed-tree gates on the same pinned Node image:

- Fresh SDK full run through `main.ts`: **120/120**, MCP **15/15**, Feature 600 / Agent 200 /
  Perf 200, SDK and driver EXIT=0.
- `npm test`: EXIT=0, including the new follow-up socket-reuse assertion.
- `node --check` for all three runtime files and `test/body-limit.test.mjs`: EXIT=0.
- `git diff --check`: EXIT=0. No lint/typecheck script or installed compiler is available;
  no supplemental typecheck was run.

Probe scripts, archived pre-fix source, exact runtime diff, SDK output, all ten official JSON/state
exports, timing summary and load logs are retained outside the repository at
`$HOME/makefun-grade-tmp/round2-priced-fix/`. Test servers exited, task containers were auto-removed,
and nothing was submitted or pushed.
