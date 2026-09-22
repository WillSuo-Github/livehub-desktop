# LiveHub Desktop

LiveHub is a cross-platform Electron desktop client for discovering live rooms from Douyin, Douyu, Huya, and Bilibili in one place, then opening a fresh direct stream in a locally installed media player.

The project is designed around one rule: the **Use Player** action always tries the selected media player and never silently falls back to a web page. Opening the platform page is a separate, explicit action.

## Current release

- Version: manually maintained in `package.json`; the release workflow never changes it
- Published build: macOS Apple Silicon (`arm64`) and Windows x64
- Release page: <https://github.com/WillSuo-Github/livehub-desktop/releases/latest>

The source is cross-platform. The GitHub Actions release workflow builds macOS arm64 and Windows x64 packages on every push to `main`. Linux packaging remains available from the same Electron Builder configuration on a Linux runner.

## Features

- One live-room directory for Douyin, Douyu, Huya, and Bilibili.
- Multi-select platform filtering.
- Single-select category filtering, including platform + category combinations.
- Search by room title, anchor, category, and tags.
- Favorites stored locally in the renderer.
- Online-audience-first sorting when a platform exposes a comparable online metric.
- Platform-normalized popularity sorting as a fallback view.
- Featured rooms appear first while full platform aggregation continues in the background.
- Background refresh after startup and once per completed hourly refresh cycle.
- No demo rooms are mixed into production results.
- Direct-stream resolution at play time for HLS and FLV playback URLs.
- Explicit web-opening action for users who want to visit the room page.
- Local media-player discovery with a persistent default player setting.
- Background GitHub Release update checks with download-and-restart installation.

## Download and install

Download the latest installer from the [GitHub Releases page](https://github.com/WillSuo-Github/livehub-desktop/releases/latest).

### macOS

The published package targets Apple Silicon (`arm64`). Download the `.dmg`, drag LiveHub to Applications, and launch it from there. The automatic release workflow requires Developer ID signing and Apple notarization before it publishes a macOS release.

The `.zip` artifact is also available for users who prefer a portable application bundle.

### Windows

Download the Windows `.exe` installer from the GitHub Releases page. The `.zip` artifact is also available for portable use.
Windows packages are intentionally unsigned, so SmartScreen may show a warning when they are first downloaded or launched.

### Linux

Linux packaging is supported by the project configuration, but it is not included in the automatic release workflow yet. Build it on a Linux runner with `npm run package`.

## Using LiveHub

1. Launch LiveHub and wait for the featured rooms to appear.
2. Select one or more platforms in the platform filter.
3. Select one category, or clear the category filter to show every category.
4. Use the search box or sorting control to narrow the room list.
5. Select a room card to open its detail panel.
6. Choose a detected player and click **Use Player** to resolve a fresh stream and launch it.
7. Click **Use Web** only when you explicitly want to open the platform page in the system browser.

### Automatic updates

Packaged builds check the public GitHub Releases feed after launch. When a newer compatible release is found, LiveHub downloads it in the background without interrupting playback. The Settings view shows the download progress and provides a **Restart to update** action after the download completes. Closing the app after a downloaded update also installs it automatically.

### Player discovery

LiveHub scans common local installations of:

- Vunio
- IINA
- mpv
- VLC
- Celluloid
- PotPlayer
- ffplay

Only players found on the current machine are shown. Selecting a player beside the play button or in Settings updates the persisted default. Vunio is opened through its `vunio://play` URL scheme; the other players receive the resolved stream URL directly.

macOS builds also show a permanent Vunio action next to the player picker and in Settings. Clicking it rescans the machine: when Vunio is installed it becomes the default player, and when it is missing LiveHub opens <https://vunio.willsuo.com> so it can be downloaded. Vunio ships for macOS only, so the action is hidden on Windows and Linux.

## Data sources and limitations

LiveHub uses public platform directory endpoints and adapter logic maintained in this repository. It does not require a platform login and does not use a browser window to resolve a stream.

“All rooms” means all rooms exposed by the public categories and pagination endpoints at the time of refresh. It does not guarantee every room visible inside a platform's own client. Platform risk control, regional access, expired rooms, rate limits, endpoint changes, and missing public categories can all reduce coverage.

Viewer metrics are not uniform across platforms:

- Douyin and Bilibili expose values that are treated as online-audience metrics.
- Douyu's `ol` and Huya's public `totalCount` are platform heat/popularity values rather than guaranteed comparable viewer counts.
- The default **Online first** mode puts comparable online metrics first and keeps less comparable values after them.
- **Normalized popularity** ranks rooms within each platform and merges those rankings, which is useful when raw platform values are not comparable.

Direct stream URLs are short-lived and can stop working after a room changes quality, goes offline, or the platform rejects a request. A failed direct-stream resolution is reported in the app; the player action does not open the web page as a fallback.

The packaged application contains the native Douyin helper for the target operating system. Development builds can compile it on first use, which requires Go 1.22 or newer.

## Development prerequisites

- Node.js 20 or newer
- npm 10 or newer
- Go 1.22 or newer for Douyin helper development and packaging
- A locally installed media player for testing playback

Install dependencies and start the development app:

```bash
npm ci
npm run dev
```

The development app uses the Vite renderer and Electron main process. The first Douyin request builds `native/douyin-helper/bin/douyin-helper` if the helper is not already present.

## Validation and builds

Run the normal checks:

```bash
npm run typecheck
npm run build
```

Build the native helper and package for the current operating system:

```bash
npm run package
```

Build the macOS DMG and ZIP artifacts:

```bash
npm run package:mac
```

Artifacts are written to `release/`. The package step builds the native Douyin helper first, bundles it outside the application archive, and includes the LiveHub icon in the packaged application.

### Automated GitHub releases

`.github/workflows/release.yml` runs on every push to `main` and on manual dispatch. It reads the version from the pushed `package.json`, creates the matching `vX.Y.Z` tag, builds macOS arm64 and Windows x64 packages, and publishes the installers and updater metadata to one GitHub Release. It never edits or commits version files.

Update `package.json` before pushing a release commit. The workflow packages exactly that version; if its matching tag already belongs to another commit, the release job stops so the version can be corrected.

The workflow requires a valid personal-account macOS Developer ID signature and Apple notarization before publishing the macOS artifacts. Windows artifacts are intentionally unsigned and do not require Windows certificate secrets; SmartScreen warnings are expected for new Windows downloads. For macOS signing, add `MACOS_CERTIFICATE_BASE64` (a base64-encoded personal-account Developer ID Application `.p12`) and `MACOS_CERTIFICATE_PASSWORD`. For notarization, add the personal team App Store Connect API key contents as `APPLE_API_KEY`, its key ID as `APPLE_API_KEY_ID`, and that team’s issuer UUID as `APPLE_API_ISSUER`. The repository must also allow GitHub Actions to write contents and push release tags.

## Project structure

```text
electron/                 Electron main process and platform services
native/douyin-helper/     Go helper for Douyin category and room discovery
shared/                   Types shared by Electron and the renderer
src/                      React renderer, filters, room cards, settings
assets/                   Packaged application resources
scripts/                  Build-time helper scripts
```

## Third-party notices

LiveHub is not a runtime dependency of DYLIVE or Streamlink. Selected parser and direct-stream resolution ideas were independently adapted from their public implementations. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for source links and license notices.

## License

LiveHub is licensed under the GNU General Public License v3.0 only. See [LICENSE](LICENSE).

## Roadmap

1. Add cursor-based Douyin coverage where the public endpoint becomes stable enough to use.
2. Add provider diagnostics and direct-stream quality selection.
3. Add packaged Linux artifacts to the GitHub release workflow.
4. Add player process lifecycle controls and richer playback error details.
5. Evaluate bundled playback components where licensing and maintenance make that practical.
