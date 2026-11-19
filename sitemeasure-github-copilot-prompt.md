# SiteMeasure GitHub Copilot prompt

## Primary platform

This application is iOS/iPadOS-first.

Primary target devices:

1. iPhone mini-sized devices
   - design primarily for approximately 375px wide portrait screens
   - must remain usable down to 320px CSS width
   - portrait mode is the primary phone orientation
2. iPad
   - portrait and landscape
   - optimize the floor-plan editor especially for landscape
   - take advantage of the larger screen with split-panel layouts
3. Desktop Safari as a secondary target
4. Chromium browsers as a secondary compatibility target

Do not design desktop-first and then shrink the UI. Design mobile-first and progressively enhance for iPad.

## Application constraints

Build a complete backend-free construction measurement and floor-plan web application inspired by the workflow of Bosch MeasureOn.

Do not copy Bosch source code, branding, logos, proprietary UI assets, protected text, or internal design elements.

The application name is `SiteMeasure`.

The application must:

- run as a completely static web application hosted on GitHub Pages;
- have no backend, server-side database, authentication, cloud synchronization, serverless functions, analytics, or tracking;
- store projects locally in browser `localStorage`;
- support complete project and backup file export/import;
- connect to compatible Bosch laser distance meters through a Web Bluetooth abstraction;
- use the iOSWebBLE Safari extension/SDK on supported iPhones and iPads;
- remain fully functional without Bluetooth through manual measurement entry;
- use relative asset paths compatible with a GitHub Pages repository subpath;
- work offline after the application shell has been cached.

Use:

- TypeScript;
- semantic HTML;
- modern CSS;
- SVG for the floor-plan editor;
- browser-native APIs;
- Pointer Events;
- minimal dependencies;
- no React, Angular, or Vue.

A lightweight build tool such as Vite may be used. The generated output must be static and deployable to GitHub Pages.

## Safari and iOS Web Bluetooth

Safari on iOS/iPadOS is the primary browser. Native Safari Web Bluetooth support must not be assumed.

Use the iOSWebBLE Safari Web Extension/WebBLE compatibility layer on supported iOS devices. Keep all extension-specific logic isolated.

Reference implementation:

https://github.com/wklm/beacio-sdk

The application should support:

- iOS Safari with the iOSWebBLE extension;
- iPadOS Safari with a compatible Web Bluetooth extension;
- native Web Bluetooth where available;
- manual operation where neither implementation is available.

Create a provider abstraction:

```typescript
interface BluetoothProvider {
  isAvailable(): Promise<boolean>;
  requestDevice(options: BluetoothRequestOptions): Promise<BluetoothDeviceLike>;
}
```

Implement:

```text
IOSWebBLEProvider
NativeWebBluetoothProvider
UnsupportedBluetoothProvider
```

Provider selection:

1. Detect iOS/iPadOS Safari.
2. Detect iOSWebBLE/WebBLE support.
3. If available, use iOSWebBLE.
4. Otherwise check `navigator.bluetooth`.
5. If native Web Bluetooth exists, use it.
6. Otherwise use `UnsupportedBluetoothProvider`.

Do not scatter `navigator.bluetooth` or `navigator.webble` calls throughout the application. All BLE communication must go through the provider abstraction.

Where appropriate, use:

```text
@ios-web-bluetooth/core
@ios-web-bluetooth/detect
```

Keep integration code in:

```text
src/bluetooth/providers/ios-webble-provider.ts
```

Do not make the rest of the application dependent on extension-specific APIs.

## Bluetooth UX on iOS

Provide a prominent button:

```text
Connect laser measure
```

Device selection must only happen after an explicit user tap. Never request Bluetooth permission automatically.

Connection states:

```text
Not available
Extension required
Ready
Searching
Connecting
Connected
Receiving measurement
Disconnected
Error
```

If Safari is detected but the extension is unavailable, show a compact setup explanation. Manual measurements must always remain available. Bluetooth failure must never prevent project editing.

## Bosch laser measuring device

Implement `BoschLaserMeasureAdapter` on top of `BluetoothProvider`:

```text
BluetoothProvider
  -> BoschLaserMeasureAdapter
  -> BoschDeviceProfile
  -> MeasurementParser
  -> MeasurementConfirmation
  -> Project State
  -> localStorage
```

Do not invent Bosch BLE UUIDs, GATT services, characteristics, commands, or packet formats.

Store device-specific configuration under:

```text
src/bluetooth/profiles/
```

Each profile contains:

- supported device identifiers;
- name prefixes;
- BLE service UUID;
- measurement characteristic UUID;
- optional command characteristic UUID;
- payload parser;
- unit conversion information;
- protocol version if relevant.

Unknown values must be marked `TODO` and must never be replaced with guessed values.

Create:

```typescript
interface BoschDeviceProfile {
  profileId: string;
  displayName: string;
  namePrefixes: string[];
  serviceUuid: BluetoothServiceUUID;
  measurementCharacteristicUuid: BluetoothCharacteristicUUID;
  commandCharacteristicUuid?: BluetoothCharacteristicUUID;
  parseMeasurement(
    value: DataView,
    context: MeasurementParserContext
  ): ParsedMeasurement | null;
}
```

Provide a fake device adapter for development and automated tests. Simulated measurements must be clearly marked as simulated.

## iPhone mini-first UI

Design every important workflow for approximately `375 x 812` CSS pixels, while remaining functional down to 320px width.

Requirements:

- no horizontal page scrolling;
- use `width: 100%`, `max-width: 100%`, and `box-sizing: border-box` appropriately;
- respect `env(safe-area-inset-top)`, `env(safe-area-inset-right)`, `env(safe-area-inset-bottom)`, and `env(safe-area-inset-left)`;
- keep the bottom toolbar above the Home Indicator;
- use large, readable measurement values;
- use touch targets of approximately 44 x 44 CSS pixels or larger;
- do not require hover, right-click, mouse wheel, middle-click, or keyboard shortcuts;
- support tap, drag, pinch zoom, and optional long-press actions;
- prevent editor gestures from unintentionally triggering Safari page scrolling.

Use bottom navigation on iPhone with a small set of primary destinations:

```text
Projects
Plan
Measure
Photos
More
```

Use sheets and bottom sheets for secondary actions.

## Floor-plan editor on iPhone

The editor is the main mobile screen and must maximize drawing space.

Layout:

```text
Top: compact project/floor selector
Center: full-width SVG floor-plan canvas
Bottom: context-sensitive tool bar
```

Do not permanently display sidebars on iPhone.

Toolbar actions:

```text
Select
Wall
Room
Door
Window
Measure
Undo
More
```

When an element is selected, show its properties in a draggable bottom sheet with:

```text
collapsed
half
expanded
```

The floor plan must remain visible while dimensions are edited.

## iPhone measurement workflow

Optimize the workflow for a user holding an iPhone in one hand and a Bosch laser measure in the other:

1. Select a wall or other target.
2. Tap `Measure`.
3. Open the Bluetooth panel.
4. Receive the Bosch measurement.
5. Display the value prominently.
6. Show `Apply`, `Retry`, and `Cancel`.
7. Apply the value to the selected target only after confirmation.
8. Update calculations immediately.
9. Save the project automatically to localStorage.

Confirmation mode is the default.

Provide optional Rapid Capture mode, which queues measurements with timestamps and sequence numbers for later assignment. Never silently overwrite an existing value.

When a measurement arrives, display:

- large numeric value and unit;
- Bluetooth connection state;
- device name;
- timestamp;
- target object;
- sequence number.

Use haptic feedback only as an optional enhancement where supported.

## iPad optimization

Do not stretch the phone interface.

In iPad landscape use a three-region layout where space permits:

```text
Left: project/building/floor/room navigation
Center: floor-plan editor
Right: contextual properties, measurements, and Bluetooth controls
```

Panels must be collapsible.

In iPad portrait use a navigation drawer plus the floor plan and an adaptive inspector panel or bottom sheet.

Use media/container queries based on available width rather than device names.

Starting breakpoints:

```text
320px+: phone
600px+: large phone/small tablet
768px+: tablet
1024px+: large tablet/desktop-style layout
```

## Floor-plan touch gestures

Implement:

- tap to select;
- tap empty area to deselect;
- one-finger drag to move a selected element in edit mode;
- one-finger drag on empty canvas to pan in navigation mode;
- pinch to zoom;
- two-finger drag to pan;
- double-tap to zoom to selection.

Also provide dedicated buttons for zoom in, zoom out, and fit drawing.

Use Pointer Events. Detect `pointerType === "pen"` for Apple Pencil enhancements, but keep all functionality usable with fingers.

Prefer SVG. Store geometry in real-world coordinates, never screen coordinates:

```typescript
interface Point {
  xMeters: number;
  yMeters: number;
}
```

Use larger invisible hit areas around walls, vertices, doors, windows, and dimension lines. Keep visible geometry accurate while making touch selection forgiving.

## Project hierarchy and functionality

Use:

```text
Project
  Building
    Floor
      Room
        Walls
        Doors
        Windows
        Openings
        Objects
        Measurements
        Photos
        Notes
```

Projects support:

- create;
- open;
- rename;
- duplicate;
- archive;
- delete;
- undo deletion during the current session;
- automatic local saving;
- current-project export/import;
- full backup/restore.

Project metadata:

- name;
- project number;
- customer;
- address;
- description;
- status;
- tags;
- created/modified timestamps;
- preferred units.

## LocalStorage persistence

`localStorage` is the only persistent data source.

Use separate keys:

```text
sitemeasure:settings
sitemeasure:project-index
sitemeasure:project:{uuid}
sitemeasure:bluetooth-settings
sitemeasure:schema-version
```

All storage access must go through a repository layer:

```typescript
interface ProjectRepository {
  list(): ProjectSummary[];
  get(projectId: string): Project | null;
  save(project: Project): void;
  delete(projectId: string): void;
  duplicate(projectId: string): Project;
  getStorageUsage(): StorageUsage;
}
```

Implement `LocalStorageProjectRepository`.

Save behavior:

- update in-memory state immediately;
- debounce normal saves;
- save after completed important actions;
- do not write on every `pointermove`;
- show `Saved locally` and the last-save timestamp;
- handle corrupt entries and `QuotaExceededError` without silent data loss;
- add schema versioning and migrations;
- create a backup before migration;
- warn before closing only if persistence failed and unsaved changes remain.

Generate IDs using `crypto.randomUUID()` with a fallback.

Display during onboarding:

```text
Projects are stored on this device. Export a backup regularly to avoid losing your plans.
```

## File export and import

Primary project format:

```text
*.sitemeasure.json
```

Use a versioned wrapper:

```typescript
interface ProjectFile {
  format: "sitemeasure-project";
  formatVersion: number;
  exportedAt: string;
  applicationVersion: string;
  checksum?: string;
  project: Project;
}
```

Support:

- export current project;
- import project;
- back up all projects and settings;
- restore backup;
- export measurements to CSV;
- export floor plan to SVG and PNG;
- generate printable HTML reports for browser-based PDF printing.

Before import:

1. Read and parse safely.
2. Validate the format identifier and version.
3. Validate all required fields and value ranges.
4. Prevent prototype pollution and executable HTML.
5. Show an import preview.
6. Detect matching project IDs.
7. Offer replace, import as copy, or cancel.
8. Save only after confirmation.

When importing as a copy, generate new IDs and remap all internal references consistently.

Before replacing all local data during restore, offer to export the current data.

Use the iPhone/iPad Files workflow where supported.

## Room and floor-plan features

Support:

- rectangular and polygonal rooms;
- wall drawing and editing;
- wall endpoint dragging;
- splitting and joining walls;
- doors, windows, openings, stairs, columns, labels, and generic objects;
- pan, zoom, fit-to-screen, grid, snap, scale, dimensions;
- undo/redo;
- copy, paste, duplicate, rotate, lock;
- touch and Apple Pencil input.

Pure tested calculations:

- distance between points;
- polygon area and perimeter;
- floor and ceiling area;
- wall area;
- opening subtraction;
- room volume;
- unit conversion;
- scale conversion;
- totals by room, floor, and project.

Detect invalid polygons, self-intersections, zero-length walls, disconnected endpoints, overlapping openings, invalid numbers, and objects outside rooms.

## Numeric input on iOS

Use `inputmode="decimal"` for measurements.

Accept both:

```text
3.45
3,45
```

Normalize values internally. Ensure the virtual keyboard does not permanently hide the active input or selected geometry.

## Photos

Support camera capture and photo-library selection.

Before saving a photo:

1. Decode it.
2. Correct orientation if required.
3. Resize it.
4. Compress it to JPEG or WebP.
5. Show approximate resulting size.
6. Save only after processing succeeds.

Do not store full-resolution iPhone photos directly in localStorage.

Configurable defaults:

```text
maximum dimension: 1600px
JPEG quality: 0.75-0.8
storage warning threshold: 70%
```

Allow title, notes, arrows, rectangles, circles, text annotations, deletion, and photo-free project exports.

## PWA and Safari behavior

Make the application installable on the iPhone/iPad Home Screen where supported.

Include:

- `manifest.webmanifest`;
- service worker;
- Apple touch icon;
- suitable theme color;
- safe viewport configuration;
- offline application-shell caching;
- update notification;
- versioned cache cleanup.

The service worker caches only static assets. Project data remains in localStorage. BLE operations stay in the visible page context.

Test:

- Safari back/forward navigation;
- pull-to-refresh interaction;
- viewport resize;
- software keyboard;
- safe-area insets;
- touch scrolling;
- pinch gestures;
- rotation;
- standalone Home Screen mode;
- file import/export;
- extension detection;
- Bluetooth reconnect;
- tab switching and returning from background.

Do not lock orientation. Preserve zoom, pan, selected tool, selection, and unsaved in-memory edits after orientation changes.

## GitHub Pages deployment

Create:

```text
.github/workflows/deploy-pages.yml
```

On push to `main`:

1. Check out the repository.
2. Install dependencies.
3. Run type checking.
4. Run linting.
5. Run tests.
6. Build static files.
7. Upload the Pages artifact.
8. Deploy to GitHub Pages.

Use relative paths or a configurable repository base path. Prefer hash routing if routing is required. Do not include secrets or require runtime environment variables.

## Security and privacy

- never transmit project data;
- never use analytics or tracking;
- never include credentials or API keys;
- never use `eval`;
- sanitize imported strings before rendering;
- reject malformed project files;
- prevent imported HTML execution;
- validate file sizes and image processing;
- document that clearing Safari storage can delete projects;
- make backup/export functions prominent.

## Accessibility and visual design

Use an iOS-friendly but application-specific design. Do not imitate Apple's proprietary application UI exactly.

Requirements:

- semantic controls;
- keyboard navigation where available;
- visible focus states;
- accessible dialogs;
- labels for icon-only buttons;
- `aria-live` for important state changes;
- sufficient contrast;
- non-color-only connection states;
- large touch targets;
- light and dark themes;
- `prefers-color-scheme`;
- `prefers-reduced-motion`.

## Testing

Create automated tests for:

- localStorage repository;
- automatic save and failure handling;
- project schema validation and migration;
- project export/import;
- ID remapping;
- full backup/restore;
- geometry and unit calculations;
- polygon validation;
- Bluetooth provider selection;
- iOSWebBLE unavailable state;
- fake Bluetooth connection/disconnection;
- payload parsing;
- duplicate and malformed measurements;
- measurement confirmation;
- storage-quota errors.

Create:

```typescript
class FakeMeasurementDeviceAdapter implements MeasurementDeviceAdapter
```

It must simulate connection, disconnection, valid values, malformed data, duplicates, and connection errors without a real device.

## iPhone mini acceptance test

At 375px width, verify this complete workflow:

1. Open SiteMeasure.
2. Create a project.
3. Create a floor.
4. Create a room.
5. Draw walls.
6. Select a wall.
7. Connect the Bosch laser measure through the configured provider.
8. Receive a value.
9. Confirm and apply it.
10. Add a door and window.
11. Add a photo and note.
12. Save automatically.
13. Close and reopen the application.
14. Restore the project from localStorage.
15. Export the project.
16. Delete the local copy.
17. Import the exported file.
18. Verify complete restoration.

No horizontal scrolling is allowed.

## iPad acceptance test

At 768px and 1024px widths, in portrait and landscape, verify:

- adaptive inspector layout;
- project-tree navigation;
- finger input;
- Apple Pencil/pointer input;
- pinch zoom and pan;
- editing walls, doors, and windows;
- Bluetooth measurements;
- photo capture/import;
- project export/import;
- rotation without losing editor state.

## Implementation priority

Optimize in this order:

1. Safari on iPhone mini-sized screens;
2. Safari on iPad;
3. Safari PWA/Home Screen mode;
4. iOSWebBLE integration;
5. Apple Pencil interaction;
6. desktop Safari;
7. Chromium compatibility.

Implementation phases:

### Phase 1

- inspect the repository;
- create `IMPLEMENTATION_PLAN.md`;
- configure the static build and GitHub Pages deployment;
- create the mobile-first application shell;
- implement project models and localStorage repository;
- implement the dashboard and project CRUD;
- implement project JSON export/import;
- add tests.

### Phase 2

- implement buildings, floors, rooms, and floor-plan editor;
- implement geometry calculations;
- implement manual measurements;
- optimize for iPhone mini and iPad;
- add tests.

### Phase 3

- implement Bluetooth provider abstraction;
- integrate iOSWebBLE;
- implement native and unsupported providers;
- implement fake adapter and configurable Bosch profiles;
- implement connection UI, measurement confirmation, rapid capture, and diagnostics;
- add tests.

### Phase 4

- implement photos, annotations, and notes;
- implement CSV, SVG, PNG, and printable HTML export;
- add tests.

### Phase 5

- implement PWA support;
- implement full backup/restore;
- complete Safari and orientation testing;
- improve accessibility and performance;
- complete documentation.

At the end of every phase:

1. Run type checking.
2. Run tests.
3. Run linting.
4. Run the production build.
5. Fix all errors.
6. Verify that no backend dependency was introduced.
7. Verify GitHub Pages subpath operation.
8. Test the relevant iPhone/iPad layouts.
9. Update `README.md` and `IMPLEMENTATION_PLAN.md`.
10. Summarize completed and remaining work.

Start by inspecting the existing repository and creating `IMPLEMENTATION_PLAN.md`.

Do not attempt all phases at once. Implement Phase 1 first as a complete, executable, tested vertical slice.
