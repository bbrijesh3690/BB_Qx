# wave1/extension progress

Feed + extension agent. Branch `wave1/extension`. Tick items as they land (tests green, committed, pushed).

- [x] 1. IndexedDB ledger (`src/ledger/indexeddb.ts`) with tests
- [ ] 2. Socket.IO / Engine.IO parser (`src/extension/quotex/socketio.ts`)
- [ ] 3. Quotex decoder (`src/extension/quotex/decoder.ts`) with hypothesis mapping table
- [ ] 4. Redaction (`src/extension/quotex/redact.ts`)
- [ ] 5. Interception (`src/extension/inject.ts`, `src/extension/content.ts`)
- [ ] 6. Service worker (`src/extension/background/*.ts`)
- [ ] 7. Panel (`src/extension/panel/*`)
- [ ] 8. Export page (`src/extension/export.html`, `export.ts`)
- [ ] 9. Schema-mapping tool (`scripts/analyze-frames.ts`)
- [ ] 10. Build (`scripts/build-extension.mjs`, manifest) and confirm output

## Notes for a resuming agent

- Link deps: in PowerShell `New-Item -ItemType Junction -Path node_modules -Target E:\Qx\BB_Qx\node_modules`.
- Checks before each commit: `npx tsc --noEmit` and `npx vitest run src/extension src/ledger/indexeddb.test.ts scripts`.
