## Plan: SiteMeasure UX and DX Audit

Broad, read-only source audit of the SiteMeasure workspace. No project files were changed. Findings below are prioritized by data-loss/accessibility risk, then workflow consistency and maintainability. P0: none confirmed in static review; live browser and real-device interaction were unavailable.

**Summary**
Confirmed high-impact issues: a project can be left during its 650 ms autosave debounce without an unload warning; the shared modal references a title ID that most dialogs do not provide; core SVG plan editing has no keyboard equivalent; and deletion/duplication storage errors can escape without consistent UI feedback. Other confirmed gaps include unit labels/calculations that remain metric, new rooms always going onto the first floor, toast/undo timer races, photo annotation limitations and unconfirmed edits lost when closing the photo dialog, and weak import replacement context. Phase 5 backup/restore, offline shell, and accessibility acceptance remain unfinished.

**Improvements**

P1 — Data integrity and core access
1. Protect pending autosaves. In `src/app.ts`, manage `scheduleSave`, `save`, and `beforeunload` together: persist pending work before navigation where possible, warn whenever data remains dirty (not only after a failed save), and clear/replace the timer after immediate saves. Add fake-timer coverage for pending, successful, and failed saves.
2. Handle every storage mutation failure. Catch failures in project delete/duplicate and other direct repository actions, preserve the current view and undo state, and show the same actionable error treatment used by `save`. Test quota/security failures for delete, duplicate, and undo.
3. Make plan editing keyboard-accessible. `FloorPlanEditor` currently relies on pointer gestures for drawing, selection, dragging, and resizing; its only keyboard handler is for clearance controls. Define keyboard equivalents for choosing tools, selecting/editing geometry, exact dimensions, and undo/redo; expose toolbar state with appropriate semantics. Validate with keyboard-only and screen-reader use.
4. Give each modal an accessible name. The shell dialog points `aria-labelledby` at `dialog-title`, while most dynamic headings only have a class and the debug-log dialog is the exception. Assign the ID/name consistently and test all dialog workflows, including announcements and focus behavior.
5. Deliver validated project backup/restore. This is essential for local-only construction records because browser-data clearing can delete projects. Add full backup export, validated restore preview, an explicit pre-replacement export/recovery step, and round-trip/corrupt-file/quota tests. Keep cloud sync out of scope.

P2 — Workflow clarity and consistency
6. Honor selected units throughout. Inspector area/volume/net-wall readouts and the editor summary are hard-coded to metric, as are report area figures. Convert and label area/volume for imperial projects and verify metric/imperial displays and exports.
7. Create rooms on the active floor. `addRoom` always selects `project.buildings[0].floors[0]`; resolve the active room's parent floor and add a regression test for another floor. Do not broaden building-management scope as part of this fix.
8. Fix toast and undo timing. Independent `showToast` timers can hide a newer message and any toast timeout clears deletion undo. Own one hide timer and bind undo expiry to the delete toast; test overlapping messages and exact expiry behavior.
9. Make photo edits understandable and recoverable. `showPhotoDialog` starts with an unmarked active tool, skips text annotations in selection, offers only undo-last rather than per-item deletion, and mutates an unsaved project copy until Save. Add active/selected states, select/delete controls for every annotation, and a discard confirmation when closing with changes. Cover save, cancel, delete, reopen, and annotation workflows.
10. Add target context to measurement history. `renderMeasurements` currently shows value, room, source, and date but omits useful wall/object target identity and device. Resolve target labels where possible and show device/source context without exposing raw IDs as the only identifier.
11. Make replacement imports explicit. `showImportPreview` shows only partial metadata and offers a replace action without clearly summarizing what local project will be overwritten. Show useful project/floor/room/photo metadata and modified time, name the affected local project, and make replace/copy/cancel consequences clear.
12. Normalize object-library actions. `ObjectsPage.saveDraft` uses native `window.confirm` for same-name replacement; delete has no matching error feedback. Use the app's confirmation pattern and report failures. Test cancel, replacement, and delete errors.
13. Align documentation with shipped behavior. README's opening still says Phase 1 despite describing Phases 1–4 later. Reconcile it with `IMPLEMENTATION_PLAN.md`; state clearly that project data is local but the app shell is not yet available offline, and document verified browser/device limits.
14. Finish or clearly bound PWA claims. A manifest/icon exist, but no service worker/offline shell is present and Phase 5 defers it. Either implement versioned static-asset caching/update behavior with offline acceptance tests, or keep installation messaging explicit until then.
15. Use one application-version source. `package.json` and `src/domain/models.ts` both contain `0.1.0`, while Vite derives the displayed build version separately. Derive export metadata from the same source and add a consistency check.

P2 — Developer experience and validation
16. Reduce controller complexity in tested increments. `src/app.ts` combines navigation, storage, dialogs, Bluetooth, photos, and exports; `src/editor/floor-plan-editor.ts` combines geometry changes, pointer state, rendering, and controls. Workspace diagnostics report high cognitive complexity and nested expressions in both files. Add characterization tests first, then extract only cohesive responsibilities; do not turn this into unrelated cleanup.
17. Add focused end-to-end workflow coverage. Existing tests cover domain/repository/editor/export and selected Bluetooth cases, but do not establish complete navigation, accessibility, responsive, or real Safari/iPad behavior. Add small integration tests for autosave, room/floor context, dialogs, import replacement, photo draft lifecycle, and toast undo; add browser-level checks for 320px mobile and desktop rather than brittle snapshots.
18. Establish the baseline gates. Run `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build` before implementation and after each relevant phase. These commands were not run in this audit; workspace diagnostics are not proof that the lint script fails.

**Relevant files**
- `src/app.ts` — save lifecycle, room placement, units/readouts, modal labels, toast lifecycle, photo draft, import preview, measurement history, repository actions.
- `src/editor/floor-plan-editor.ts` — keyboard workflow, tool semantics, unit summary, future interaction/render boundaries.
- `src/objects/objects-page.ts` — library confirmation/error behavior.
- `src/data/local-storage-repository.ts` and `src/data/project-files.ts` — backup/restore validation and persistence failure behavior.
- `src/domain/models.ts`, `vite.config.ts`, `package.json` — version source of truth.
- `README.md`, `IMPLEMENTATION_PLAN.md`, `src/styles.css`, and focused files under `tests/` — scope documentation, responsive/accessibility styling, and regression coverage.

**Implementation order**
1. P1 items 1–4: data-loss, storage feedback, keyboard access, and dialog naming; add narrow regression tests alongside each change.
2. P1 item 5: backup/restore, depending on validated project-file and repository behavior.
3. P2 items 6–12: fix workflow consistency and feedback, each with a focused test.
4. P2 items 13–15: reconcile docs/PWA scope/version metadata; offline implementation is a product choice and can remain deferred if claims stay accurate.
5. P2 items 16–18: add characterization/integration coverage, then modularize by behavior and run all quality gates.
6. Manual acceptance: keyboard/screen reader, phone/tablet/desktop, storage quota recovery, import conflicts, photo save/discard, Safari/Bluefy camera/share/Bluetooth/offline behavior. Real Bosch hardware stays out of scope until identifiers, UUIDs, and packet parsing are verified.

**Limits and decisions**
- Source-backed findings are separated from browser/device acceptance work; the attached page could not be interacted with through available tools.
- No screen reader, physical iPhone/iPad, storage quota edge, iOSWebBLE, or laser hardware was exercised. The inventory is broad static analysis, not a guarantee of every runtime defect.
- No code, tests, or project documentation were edited. Cloud sync and real Bosch protocol implementation are excluded.