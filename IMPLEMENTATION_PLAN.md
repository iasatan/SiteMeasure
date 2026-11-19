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

Provider selection, iOSWebBLE isolation, native Bluetooth, validated Bosch profiles, fake devices, confirmation, and rapid capture.

## Phase 4: Photos and reports

Photo processing and annotation, notes, CSV, SVG/PNG, and printable reports.

## Phase 5: PWA and completion

Offline shell, backups, restore, Safari/iPad acceptance checks, accessibility hardening, and operational documentation.

## Phase 1 Completion Notes

Phase 1 is complete as an executable vertical slice. It includes a 320px-compatible responsive shell, project CRUD, local autosave, schema migration backups, validated import/export, import conflict choices, focused automated tests, and GitHub Pages deployment. No backend services, analytics, credentials, or runtime environment variables were introduced.

## Phase 2 Completion Notes

Phase 2 is complete as an executable editor slice. It includes building/floor/room navigation, wall and room drawing, endpoint and wall movement, doors and windows, manual comma-decimal measurements, live calculations, pan/zoom, undo/redo, split/join, copy/paste, locking, responsive inspectors, and validated local persistence.

Phase 3 remains intentionally blocked on verified Bosch profile values for any real device protocol integration. The Bluetooth provider, fake adapter, and confirmation pipeline can proceed without guessed UUIDs or packet formats.
