# Runtime and Machine Identity Review

Branch: `feat/runtime-machine-identity`.
Harness baseline: `ae243d47b265d9206299344b085203c3141f284b`.
Worker baseline: `e2165593bd72c7638b3fc121109372be1fbf1a13`.
Both reviews cover the complete working-tree change, including new files, against these pre-change baselines.

## Standards

[P2, fixed] Persistent machine identity needed failure and restart-recovery tests under CONTRIBUTING.md. Added rejection/non-overwrite tests for malformed JSON, null/false/zero, invalid schema/label, plus failed enrollment followed by a stable-label retry. Independent re-review confirmed closure and found no new actionable standards violations or baseline smells.

## Spec

[P1, fixed] Explicit renewal could send a saved Runtime credential to an overridden endpoint. Existing profile server and Worker bindings are now checked before any request; regression tests assert zero fetch for changed endpoints. Independent re-review confirmed closure and found no new actionable specification deviations.

## Verification

Build, typecheck and lint passed. The full Harness suite has 209 tests: 207 passed, two existing opt-in tests skipped, no failures. Worker tests/vet and real local MySQL schema and identity tests passed, including eight concurrent first enrollments, retry/renewal/registration reuse, same-machine profile isolation, and rejection/revocation paths. The local Worker database was reset; online E2E and deployment changes were not performed. The bundled operation skill was updated and validated.

The local Worker pre-reset export is not a full data backup: it contains only the database definition. See the Worker repository's `docs/runtime-machine-identity-review.md` for the full cross-repository verification and database-reset record.

Summary: Standards 1 finding (original worst P2), Spec 1 finding (original worst P1); both fixed and re-reviewed, zero open actionable findings.
