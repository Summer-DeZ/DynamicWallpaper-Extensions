# Architecture

Dynamic Wallpaper Renderer separates VS Code-facing workflows from reusable project and platform
code. Dependencies point inward: application modules coordinate use cases, while domain and project
modules do not depend on VS Code.

```text
src/
├─ extension.ts                  Extension composition root
├─ application/                 VS Code commands, settings, recovery workflow, and UI errors
│  └─ commands/                 One module per command family
├─ domain/                      Renderer configuration types
├─ project/                     wallpaper.json loading plus managed-library paths and catalog
├─ importers/                   External wallpaper format conversion
└─ platform/
   ├─ workbench/                Workbench patching, lifecycle decisions, and resource URIs
   └─ windows/                  Windows GPU preference integration

scripts/
└─ release/                     Packaging tasks
```

## Boundaries

- `extension.ts` contains no feature logic; it registers commands and starts recovery.
- `application` may depend on VS Code and all inner modules.
- `domain`, `project`, and `importers` never depend on VS Code UI APIs.
- `platform` isolates operating-system and unsupported Workbench integration details.
- Production code compiles into `dist`.

## Verification

Run `npm run check` for a clean production compilation. Run `npm run package` to verify that no
rendering content enters the release and produce the Windows x64
VSIX under `build/`. Public release requirements are documented in `docs/publishing.md`.
