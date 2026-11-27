# SiteMeasure

SiteMeasure is a private, local-first construction measurement and floor-plan web application. The current app includes project management, plans, measurements, Bluetooth capture boundaries, photos, reports, and validated project and full-workspace backup/restore.

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

Project metadata is stored in browser `localStorage`; photo files are stored as binary blobs in IndexedDB. SiteMeasure does not transmit project data and contains no analytics, authentication, or backend service. Clearing browser website data can delete both, so export important projects regularly.

Existing embedded photos are migrated when the app opens. A photo is written to IndexedDB before its project is updated; if migration fails, the original project remains available and the app shows a warning. IndexedDB must be available to add or import photos. Project and backup exports include the images and remain compatible with existing files. Storage estimates are browser-dependent and the site-wide estimate includes IndexedDB as well as other site data.

To protect duplicated projects, undo, and other open tabs, unreferenced photo blobs are not automatically deleted. Deleting photos or projects may therefore not immediately reclaim IndexedDB space. Export a full backup before clearing site data; restoring it recreates the photos still in the backup.

Project exports use `*.sitemeasure.json`; full local-workspace backups use `*.sitemeasure-backup.json`. Restoring a full backup replaces every local project after requesting a download of the current projects. Keep that recovery file before continuing.

The web app shell is not cached and requires the site to load while online. Standalone exported 3D room files can be opened offline after download; this does not make the app itself available offline. The manifest supports browser installation, not offline operation.

In Bluefy, project export uses the iOS share sheet when file sharing is supported; choose a destination such as Save to Files. If file sharing is unsupported or fails, a browser download is available instead. A completed share does not confirm that a file was saved.

## Debug recording

Enable debug recording under More, reproduce the issue, then turn it off to view or export the JSON log. Recording continues across reloads. Starting another recording replaces the previous one; the latest 1,000 entries are retained, and older entries are discarded. The log captures common browser and interaction events, console messages, unhandled errors and rejections, handled app errors, and Bluetooth diagnostics. It cannot capture events or errors outside the instrumented page or errors caught internally by browser libraries. Form values and typed characters are not recorded by event capture, but button labels, error messages, console output, and Bluetooth diagnostics may contain sensitive information. Review logs before sharing them. Logs stay on the device until exported or browser data is cleared. If storage is full, export the in-memory log before closing the page.

Project exports also log browser capabilities, photo count, serialized size, filename, and each download step. A completed link click only means a download was requested; browsers do not tell the app whether the file was saved. The filename may contain the project name, but the project contents are not logged. If downloads are unavailable, open the debug log and use Copy log; if clipboard access is blocked, the log is selected for manual copying.

## Editing layers

Choose Builder, Technician, or Designer in the header. Builder edits rooms, walls, doors, and windows. Technician places electrical wiring, sockets, pipes, and faucets from Objects. Designer places furniture from Objects. Other layers remain visible on the plan but cannot be selected or edited in the active layer. Existing objects without a layer belong to Designer. Use Open plan in Objects to return to the selected room after inserting a template.

Layers are local editing modes, not user accounts or security permissions; anyone with access to the project can switch modes. Wiring and pipes are individual resizable object segments, not connected system models.

In the 3D room view, use the View selector to switch between the orbiting 3D view, the floor, and individual wall elevations. The same views are available in downloaded 3D room files.

In the plan editor, select a wall in the Editor view control to edit its elevation. Technicians can place an existing object on that wall, draw an object directly, drag it, or resize it using its handle. The inspector also accepts exact distance-along-wall and height-above-floor values. Wall attachments are saved with the project and appear at their mounted height in 3D.

In Photos, draw or select an arrow, rectangle, or circle and choose its length, width, or height. Connect the laser measure and apply a pending reading, or enter a value manually, then save the photo. The measurement is displayed on the annotation; it does not change the outline or infer a scale from the photograph.

## Current scope

Shipped scope includes:

- iPhone-first project dashboard and iPad adaptive project workspace;
- create, open, rename, duplicate, archive, restore, delete, and undo deletion;
- debounced metadata autosave and visible save failures;
- schema-versioned repository with corrupt-entry protection and quota error handling;
- validated project export/import, conflict preview, and copy ID remapping;
- validated full-workspace backup export and replacement restore with preview and a pre-replacement backup;
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

Real Bosch hardware remains disabled until its device identifiers, GATT UUIDs, and packet format are verified. Manual measurements remain available. Safari/iPad, Bluefy, screen-reader, and physical laser-device behavior have not been accepted on real devices; automated checks run in jsdom and do not establish those compatibility guarantees. An offline service worker and app-shell caching remain unfinished.

## Deployment

Pushes to `main` run type checking, linting, tests, and a production build before deploying `dist/` to GitHub Pages. GitHub Pages must be configured to use GitHub Actions as its source.
