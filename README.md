# SiteMeasure

SiteMeasure is a private, local-first construction measurement and floor-plan web application. Phase 1 provides the executable mobile-first project workspace, localStorage project storage, project CRUD, and validated project import/export.

## Run locally

```sh
npm install
npm run dev
```

Open the URL printed by Vite. No backend or runtime environment variables are required.

## Quality checks

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

The production output is written to `dist/` and uses relative asset paths for GitHub Pages repository subpaths.

## Project data and privacy

Projects are stored only in browser `localStorage`. SiteMeasure does not transmit project data and contains no analytics, authentication, or backend service. Clearing Safari website data can delete local projects, so export important projects regularly.

Current export format: `*.sitemeasure.json`.

## Debug recording

Enable debug recording under More, reproduce the issue, then turn it off to view or export the JSON log. Recording continues across reloads. Starting another recording replaces the previous one; the latest 1,000 entries are retained, and older entries are discarded. The log captures common browser and interaction events, console messages, unhandled errors and rejections, handled app errors, and Bluetooth diagnostics. It cannot capture events or errors outside the instrumented page or errors caught internally by browser libraries. Form values and typed characters are not recorded by event capture, but button labels, error messages, console output, and Bluetooth diagnostics may contain sensitive information. Review logs before sharing them. Logs stay on the device until exported or browser data is cleared. If storage is full, export the in-memory log before closing the page.

## Editing layers

Choose Builder, Technician, or Designer in the header. Builder edits rooms, walls, doors, and windows. Technician places electrical wiring, sockets, pipes, and faucets from Objects. Designer places furniture from Objects. Other layers remain visible on the plan but cannot be selected or edited in the active layer. Existing objects without a layer belong to Designer. Use Open plan in Objects to return to the selected room after inserting a template.

Layers are local editing modes, not user accounts or security permissions; anyone with access to the project can switch modes. Wiring and pipes are individual resizable object segments, not connected system models.

In the 3D room view, use the View selector to switch between the orbiting 3D view, the floor, and individual wall elevations. The same views are available in downloaded 3D room files.

In the plan editor, select a wall in the Editor view control to edit its elevation. Technicians can place an existing object on that wall, draw an object directly, drag it, or resize it using its handle. The inspector also accepts exact distance-along-wall and height-above-floor values. Wall attachments are saved with the project and appear at their mounted height in 3D.

## Current scope

Phases 1 through 4 include:

- iPhone-first project dashboard and iPad adaptive project workspace;
- create, open, rename, duplicate, archive, restore, delete, and undo deletion;
- debounced metadata autosave and visible save failures;
- schema-versioned repository with corrupt-entry protection and quota error handling;
- validated project export/import, conflict preview, and copy ID remapping;
- SVG floor-plan editing in real-world meter coordinates;
- wall and polygon room drawing, endpoint dragging, pan, pinch zoom, fit, grid, and snapping;
- split/join, rotate, duplicate, copy/paste, lock, delete, and undo/redo;
- door/window placement, dimension labels, manual comma-decimal measurements, and live area/volume calculations;
- isolated native Web Bluetooth and iOSWebBLE provider selection with manual fallback;
- fail-closed Bosch protocol profiles, connection states, and confirmation-based Bluetooth capture with one replaceable pending reading;
- camera and library photos with 1600px resize, JPEG compression, preview-size confirmation, notes, and annotations;
- room notes, measurement CSV, room SVG/PNG, printable reports, and photo-free project export;
- interactive 3D room views and self-contained HTML exports that work offline;
- static GitHub Pages deployment workflow.

Real Bosch hardware remains disabled until its device identifiers, GATT UUIDs, and packet format are verified. Manual measurements remain available. Backups and the offline service worker remain later-phase work.

## Deployment

Pushes to `main` run type checking, linting, tests, and a production build before deploying `dist/` to GitHub Pages. GitHub Pages must be configured to use GitHub Actions as its source.
