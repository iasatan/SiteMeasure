# SiteMeasure Implementation Plan

## Phase 1: Foundation and project workspace

- [x] Establish a static Vite + TypeScript toolchain with relative asset paths.
- [x] Define the versioned project schema and migration boundary.
- [x] Implement the localStorage project repository with safe corrupt-entry handling.
- [x] Build the iPhone-first projects dashboard and project CRUD flows.
- [x] Add project file export/import with validation and import preview.
- [x] Add focused repository and file-format tests.
- [x] Configure GitHub Pages deployment and document local development.

## Phase 2: Plans and measurements

- [x] Add room/floor hierarchy navigation and room creation/renaming.
- [x] Replace the static plan preview with a real-world-coordinate SVG editor.
- [x] Implement wall drawing, endpoint dragging, selection, pan, pinch zoom, fit, grid, and snapping.
- [x] Add polygonal rooms, split/join, rotate, duplicate, copy/paste, lock, delete, and undo/redo.
- [x] Add doors, windows, dimensions, manual measurements, and measurement confirmation.
- [x] Add tested geometry, unit, area, perimeter, volume, and polygon validation calculations.
- [x] Persist completed edits and measurement records through the repository layer.

## Phase 3: Bluetooth

- [x] Add isolated native Web Bluetooth, iOSWebBLE, and unsupported providers with deterministic selection.
- [x] Add a fail-closed Bosch adapter and validated device-profile boundary with explicit TODO protocol values.
- [x] Add confirmation-first capture, retry/cancel controls, timestamps, sequence numbers, and explicit target assignment; each incoming reading replaces the previous pending value.
- [x] Persist confirmed Bluetooth captures without requiring Bluetooth for manual entry or project editing.

## Phase 4: Photos and reports

- [x] Decode, orientation-correct, resize, and compress camera/library photos before local saving.
- [x] Show processed dimensions and approximate size, warn at high localStorage usage, and support photo-free project export.
- [x] Add photo titles, notes, arrows, rectangles, circles, text annotations, and deletion.
- [x] Add room notes and autosave them through the repository layer.
- [x] Export measurements CSV, active-room SVG/PNG, and printable HTML reports with photos and annotations.
- [x] Validate photo and annotation payloads and remap their IDs during project copying.

## Phase 5: PWA and completion

Offline shell, backups, restore, Safari/iPad acceptance checks, accessibility hardening, and operational documentation.

## Phase 1 Completion Notes

Phase 1 is complete as an executable vertical slice. It includes a 320px-compatible responsive shell, project CRUD, local autosave, schema migration backups, validated import/export, import conflict choices, focused automated tests, and GitHub Pages deployment. No backend services, analytics, credentials, or runtime environment variables were introduced.

## Phase 2 Completion Notes

Phase 2 is complete as an executable editor slice. It includes building/floor/room navigation, wall and room drawing, endpoint and wall movement, doors and windows, manual comma-decimal measurements, live calculations, pan/zoom, undo/redo, split/join, copy/paste, locking, responsive inspectors, and validated local persistence.

## Phase 3 Completion Notes

Phase 3 is complete as an executable capture slice. It includes provider selection, extension-required handling on iOS Safari, isolated native and iOSWebBLE access, a fail-closed Bosch profile registry and adapter, connection states, confirmation-first measurement application, retry/cancel controls, and a single replaceable pending reading. Real Bosch connections remain disabled until a device profile contains verified identifiers, UUIDs, and packet parsing; no protocol values were guessed.

## Phase 4 Completion Notes

Phase 4 is complete as an executable documentation slice. Photos are decoded and compressed to a 1600px maximum dimension before explicit size confirmation and saving. The Photos view supports camera/library capture, room notes, titles, photo notes, arrows, rectangles, circles, text annotations, and deletion. More exports validated measurement CSV, standalone room SVG and PNG, printable HTML reports with photos and annotations, full project JSON, and photo-free project JSON.
