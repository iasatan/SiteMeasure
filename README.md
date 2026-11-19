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

## Current scope

Phases 1 and 2 include:

- iPhone-first project dashboard and iPad adaptive project workspace;
- create, open, rename, duplicate, archive, restore, delete, and undo deletion;
- debounced metadata autosave and visible save failures;
- schema-versioned repository with corrupt-entry protection and quota error handling;
- validated project export/import, conflict preview, and copy ID remapping;
- SVG floor-plan editing in real-world meter coordinates;
- wall and polygon room drawing, endpoint dragging, pan, pinch zoom, fit, grid, and snapping;
- split/join, rotate, duplicate, copy/paste, lock, delete, and undo/redo;
- door/window placement, dimension labels, manual comma-decimal measurements, and live area/volume calculations;
- static GitHub Pages deployment workflow.

Bluetooth, photos, reports, backups, and the offline service worker remain later-phase work.

## Deployment

Pushes to `main` run type checking, linting, tests, and a production build before deploying `dist/` to GitHub Pages. GitHub Pages must be configured to use GitHub Actions as its source.
