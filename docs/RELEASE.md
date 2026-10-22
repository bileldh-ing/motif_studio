# Release & store checklist

## Cutting a release
1. Update `CHANGELOG.md` and bump versions (`package.json`, `apps/desktop/package.json`).
2. Merge to `main` with CI green (typecheck, tests, smoke, API image, installers).
3. `git tag vX.Y.Z && git push --tags` → **Release** workflow builds every platform, publishes the GitHub Release (the auto-update feed: `latest*.yml` + sha512) and uploads `SHA256SUMS.txt`.
4. Download each installer on a clean machine/VM and run the installer smoke list below.

## Signing secrets (GitHub → Settings → Secrets → Actions)
| Secret | Used for |
|---|---|
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | Authenticode .pfx (base64) for the NSIS installer and update verification |
| `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD` | Developer ID Application certificate (.p12, base64) |
| `APPLE_API_KEY_BASE64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | App Store Connect API key for notarization |
| `MS_STORE_IDENTITY_NAME`, `MS_STORE_PUBLISHER` | Partner Center product identity for the `.appx` |
| `SNAPCRAFT_STORE_CREDENTIALS` | `snapcraft export-login` output for Snap Store uploads |

Without these, builds are produced **unsigned** and the release notes say so. Never claim a build is signed unless the secret was present.

## Store submission
- **Microsoft Store**: upload `MOTIF-Studio-*-win-x64.appx` from the `store-packages-Windows` artifact in Partner Center (the Store signs it). Age rating: no user-generated sharing; privacy policy URL: `docs/PRIVACY.md` published on the website.
- **Mac App Store**: build the `mas` target on macOS with an Apple Distribution certificate and `build/embedded.provisionprofile`, then upload with Transporter. MAS builds run sandboxed: user-selected files and the Movies folder are read-write.
- **Snap Store**: the Release workflow uploads to the `edge` channel; promote to `stable` in the dashboard after testing.
- **Direct download**: GitHub Release assets + `apps/web` download page.

## Installer smoke list (clean machine)
- Installs without admin (Windows per-user, macOS drag to Applications, AppImage chmod +x).
- First launch shows Home with FFmpeg detected (bundled), no console errors.
- Try the demo project → play → export 1080p MP4 → file opens in the system player.
- Open a `.motif` file by double-click (file association).
- Upgrade test: install previous version, create a project, install new version, project reopens; auto-update banner appears for AppImage/NSIS/DMG builds.
- Uninstall leaves projects in Documents/MOTIF Studio.
