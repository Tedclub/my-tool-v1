# V2 static snapshot publishing

Primary APIs, Scanner calculations/selection/ranking, ingestion, schema and trading
calendar are unchanged. Only the existing successful daily Scheduled handler has
a downstream publishing hook, after its `daily_update` result has been logged.
No additional Cron, HTTP endpoint, backfill or Scanner rebuild is introduced.

## Deployment

- Worker: `taiwan-market-scanner`; source changes belong to V2, never main.
- Public data-only Git branch: `Tedclub/my-tool-v1`, `v2-snapshots`.
- Required Worker secret: `GITHUB_SNAPSHOT_TOKEN`. Use a fine-grained GitHub token
  restricted to that repository with Contents read/write. Never commit, print or
  return its value. GitHub cannot restrict a token to just one branch; the
  publisher additionally hard-limits its target branch to `v2-snapshots`, checks
  that the current tree contains only `v2/` and README, and never force-pushes.
- Configuration: `STATIC_SNAPSHOT_EXPORT_ENABLED=true`,
  `SNAPSHOT_GITHUB_REPOSITORY=Tedclub/my-tool-v1`,
  `SNAPSHOT_GITHUB_BRANCH=v2-snapshots`, `SNAPSHOT_R2_ENABLED=false`.
- R2 is deferred: do not activate billing, create a bucket/binding, expose r2.dev,
  add DNS or deploy an R2 endpoint. The adapter/interface and failure tests are
  retained. Future activation needs a dedicated bucket binding `V2_SNAPSHOTS` and
  an authorized custom domain.

## Public files

Base URL:
`https://raw.githubusercontent.com/Tedclub/my-tool-v1/v2-snapshots/`

Every exported bundle has `manifest.json`, `summary.json`, `TWSE-compact.json` at:

- `v2/latest/`
- `v2/archive/YYYY-MM-DD/`
- `v2/snapshots/<existing-snapshot-hash-without-sha256-prefix>/`

GitHub Raw headers are controlled by GitHub: observed `text/plain; charset=utf-8`
and `Cache-Control: max-age=300`, although bodies are valid UTF-8 JSON. They cannot
be set to application/json/no-cache from repository file contents. Readers must
validate trading date and hash even if a GET returns 200. GitHub Pages was not
enabled because that would change the existing site's hosting configuration.

## Snapshot and atomicity

Capture the existing full read-only snapshot once via `handleScannerRead`. Verify
its existing `v2-snapshot-sha256-1` hash using `snapshotHash` and its public checks.
Project its existing ordered TWSE candidates with the existing `COMPACT_FIELDS`.
No calculation, selection or sort is added. Summary/compact/manifest carry the
same existing snapshot hash. No run ID or completion timestamp is invented.

All GitHub JSONs are committed in one Git tree and become visible together with
one non-forced branch update. Immutable/date files are never overwritten. A date
archive collision with a different hash fails publishing, without changing the
old latest marker or any D1 data. Investigate such a collision separately.

Manifest `files` links point to the hash path, not mutable latest aliases. Always
follow these links. A cached old manifest still references its own complete files.
The hash identifies the existing full V2 snapshot; it is not a new hash of compact
JSON bytes. Matching hash labels alone do not independently prove an untrusted
provider did not alter compact content; use the trusted GitHub source and compare
Primary when available. No extra payload hash replaces the Primary snapshot hash.

R2 (when enabled in the future) writes immutable files, date archive, latest
summary, latest compact, then latest manifest. Failure before the marker leaves
the previous manifest's immutable targets usable. Each provider fails separately:
`GITHUB_SNAPSHOT_EXPORT_FAILED` / `R2_SNAPSHOT_EXPORT_FAILED`. Error bodies,
credentials and candidate payloads are never logged.

## Fail closed and independent retrieval

`src/static-retrieval.js` only reads the static manifest and its immutable files.
It never calls Primary. It rejects off-origin or non-hash-bound manifest links.
`usableStaticCandidates` returns `PASS`, `DATA_FAIL` or `RETRIEVAL_FAIL`. On either
failure it returns zero usable candidates. Fresh TWSE may PASS independently of
stale TPEX. Expected date is recalculated with the existing calendar, including
10/23 closure and fail-closed unknown years, never by weekday-only heuristics.

Initial 2026-10-30 bootstrap preserved the public 10/28 snapshot with 110 TWSE
candidates and `fresh=false`: it is readable but DATA FAIL as the calendar expects
10/29. No ingestion repair was authorized here. `allowStale` is available only
for the explicit one-time bootstrap utility; the automatic Scheduled exporter
does not use it. Missing/old static files must never be interpreted as fresh.

## Rollback

Disable `STATIC_SNAPSHOT_EXPORT_ENABLED` or restore the recorded pre-deployment
Worker version. Published public static files remain readable and keep their
original freshness metadata; consumers must still date-check. No D1 rollback is
necessary because this layer issues only the existing snapshot SELECT and remote
publishing writes. Never clear or rebuild D1 as part of this feature.
