# Acceptance checks

All run with `npm test` against a real Postgres database (55 tests, all passing on 2026-10-15). File: `tests/acceptance.test.ts` unless noted.

| # | Check | Test |
|---|---|---|
| 1 | Synthetic lead → simulated call → CDL upload → handoff | `1. synthetic lead -> simulated call -> handoff` |
| 2 | Driver questions get approved answers (verbatim fact text) | `answers pay and home time only with approved fact text`, units: `knowledge answers` |
| 3 | Unknown/unconfirmed questions reach a human, nothing invented | `routes unknown/unconfirmed questions to a human`, `injection attempts do not change answers` |
| 4 | Duplicate imports and webhooks do not duplicate outreach; bad/replayed signatures rejected | `4. duplicate imports and webhooks` (3 tests), units: CSV re-import |
| 5 | Opt-out (on call or by STOP text) blocks calls and texts, survives re-import | `5. opt-out` |
| 6 | Outside permitted hours stays queued; unknown timezone, missing permission, global pause block | `6. contact hours` (4 tests) |
| 7 | Secure upload updates candidate; bad type/expired/unknown token rejected; token not logged | `7/8 upload updates candidate` |
| 8 | Unauthorized users cannot retrieve CDL files | `7/8 unauthorized users cannot read CDL files` + browser check (anonymous 401, other recruiter 404) |
| 9 | Recruiters only see assigned candidates | `9. recruiter permissions` + browser check |
| 10 | Failed transfers create callback tasks; success only on provider confirmation | `10. failed transfers` (3 tests) |
| 11 | Missing live credentials cannot initiate contact (no network request made); synthetic offers and demo records refused in live mode | `11. missing live credentials` (3 tests) |
| 12 | Worker restarts preserve work; re-delivered jobs do not duplicate calls; concurrent jobs never dial twice | `12. worker restarts` (3 tests) |
| 13 | Barge-in stops audio and cancels stale queued speech | `13. voice interruption` |
| 4 (Sheets) | Google Sheets: reviewed first import, ID or phone identity survives re-sorting, concurrent syncs, write-back never says "hired", live HTTP contract | `tests/sheets.test.ts` (10 tests) |
| 14 | Dashboard/integration statuses identify mocks honestly | `14. integration status honesty` + Integrations page |
