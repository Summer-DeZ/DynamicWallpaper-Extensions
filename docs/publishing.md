# Publishing

The release build deliberately excludes wallpaper projects, generated render templates, and converted
media. Complete every remaining release gate below before publishing.

## Release gates

### 1. Keep rendering content outside the release

`.vscodeignore` excludes `wallpapers/` and `tools/wallpaper-engine/`. The release verifier fails the
build if either path appears in the VSIX file list. Scene imports operate only on files selected from
the user's local Wallpaper Engine project and the extension does not ship converted Workshop assets.

Keep local wallpaper sources ignored by Git as well as VSIX packaging. Do not attach local wallpaper
archives to the public source release unless their rights holder has explicitly permitted redistribution.

### 2. Publish corresponding source

The extension is GPL-2.0-only and contains GPL-derived compatibility work. Publish the complete source,
build scripts, notices, and the exact source tag corresponding to every Marketplace release. Keep the
RePKG MIT license and third-party notices in the VSIX.

### 3. Complete Marketplace identity and presentation

Before packaging the public candidate:

- create a Visual Studio Marketplace publisher and replace `publisher: "local"` with its immutable ID;
- confirm that both `name` and `displayName` are available;
- add `author`, `repository`, `homepage`, and `bugs` metadata;
- add a non-SVG PNG icon of at least 128x128 pixels, preferably 256x256;
- add screenshots showing the editor, media/PDF protection, and recovery after a VS Code update;
- add `SUPPORT.md` and a security-reporting contact.

Keep the extension marked Preview until the unsupported Workbench patch has been exercised across
several VS Code update cycles.

### 4. Validate the supported platform

The extension modifies the desktop Workbench and bundles a Windows executable, so releases target
`win32-x64` and run as a UI extension. Test on a clean Windows x64 machine with:

- the oldest supported VS Code (`1.96`) and the current Stable release;
- a standard user and an elevated installation requiring administrator access;
- apply, restore, uninstall, VS Code update, stale-patch migration, and missing-patch recovery;
- image, video, PDF, Web wallpaper, and Wallpaper Engine import workflows;
- an installation containing another Workbench-modifying extension.

## Build and inspect

```powershell
npm ci
npm run package
npm run verify:release
npx vsce ls --tree --target win32-x64
code --install-extension build/dynamic-wallpaper-engine-0.6.0.vsix
```

`vscode:prepublish` runs the production compile and release-content verification.
The package script emits only a platform-specific VSIX under `build/`.

## First Marketplace release

1. Create the publisher in the Marketplace management portal.
2. Complete the manifest metadata and all release gates above.
3. Build from a clean, tagged source checkout.
4. Install and smoke-test the exact VSIX that will be uploaded.
5. Upload that VSIX manually as a pre-release first, or use:

   ```powershell
   npx vsce publish --pre-release --target win32-x64
   ```

6. After a testing period, publish a different `major.minor.patch` version as the stable release.

For one-off publishing, `vsce login <publisher-id>` supports a Marketplace-scoped Azure DevOps token.
Never commit or print the token. For CI, use Microsoft Entra ID workload identity federation instead of
a long-lived PAT; global Azure DevOps PATs are scheduled for retirement on December 1, 2026.

Prefer unpublishing over removing a Marketplace entry. Removing is irreversible, permanently reserves
the extension name, and discards its statistics.
