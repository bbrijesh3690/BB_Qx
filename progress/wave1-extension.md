# wave1/extension progress

Feed + extension agent. Branch `wave1/extension`. Tick items as they land (tests green, committed, pushed).

- [x] 1. IndexedDB ledger (`src/ledger/indexeddb.ts`) with tests
- [x] 2. Socket.IO / Engine.IO parser (`src/extension/quotex/socketio.ts`)
- [x] 3. Quotex decoder (`src/extension/quotex/decoder.ts`) with hypothesis mapping table
- [x] 4. Redaction (`src/extension/quotex/redact.ts`)
- [x] 5. Interception (`src/extension/inject.ts`, `src/extension/content.ts`)
- [x] 6. Service worker (`src/extension/background/*.ts`)
- [x] 7. Panel (`src/extension/panel/*`)
- [x] 8. Export page (`src/extension/export.html`, `export.ts`)
- [x] 9. Schema-mapping tool (`scripts/analyze-frames.ts`)
- [x] 10. Build (`scripts/build-extension.mjs`, manifest) and confirm output

## Notes for a resuming agent

- Link deps: in PowerShell `New-Item -ItemType Junction -Path node_modules -Target E:\Qx\BB_Qx\node_modules`.
- Checks before each commit: `npx tsc --noEmit` and `npx vitest run src/extension src/ledger/indexeddb.test.ts scripts`.
- Build: `npm run build:ext` -> `dist/extension` (manifest, background.js, inject.js, content.js, export.html, export.js + maps). Load unpacked from chrome://extensions.
- Host matches live only in `src/extension/hosts.json`; owner confirmed the trading page https://quotex.com/en/demo-trade (covered).
- Panel DOM smoke-tested in a browser with stubbed chrome APIs (renders, spot-check list works, no console errors).
