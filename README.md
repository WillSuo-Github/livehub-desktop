# LiveHub Desktop

LiveHub is a cross-platform desktop client for collecting live rooms from Douyin, Douyu, Huya, and Bilibili in one place.

## Current status

- Electron desktop shell is ready.
- React + TypeScript renderer is ready.
- Multi-platform filters, single-category filtering, search, favorites, detail panel, and settings shell are ready.
- Douyin data is fetched by our own standard-library Go helper. Its HTML parser flow is adapted from DYLIVE, but DYLIVE is not a runtime dependency.
- The helper aggregates every currently exposed leaf category, deduplicates rooms, sorts by viewer count, and reports partial category failures.
- Douyu, Huya, and Bilibili use independent TypeScript adapters and their public directory APIs. Demo rooms are no longer mixed into the result.
- The adapters aggregate public categories and pagination, deduplicate rooms, retry transient HTTP failures, and expose per-platform coverage status.
- Cross-platform discovery defaults to reported-online-first sorting. Douyin and Bilibili expose platform-reported online values; Douyu's `ol` and Huya's public `totalCount` are treated as platform heat and placed after comparable online values. Users can toggle back to platform-normalized popularity ranking.
- Startup fetches a small set of fresh featured rooms first. Full platform aggregation continues in the Electron main process and replaces each platform's rooms as soon as that platform finishes.
- No room data is persisted to disk. Featured rooms refresh every five minutes, while a complete background refresh starts at launch and repeats one hour after each completed refresh cycle. Both paths use single-flight guards to prevent overlapping crawls.
- Installed media players are scanned locally (Vunio, IINA, mpv, VLC, Celluloid, PotPlayer, and ffplay when available). No browser fallback is used for playback; opening the room page is a separate explicit action.
- The player dropdown beside the play button and the settings page both update and persist the default player. Player settings are stored in Electron's user-data directory.
- Clicking play resolves a fresh direct stream at playback time for Douyin, Douyu, Huya, and Bilibili, then launches the selected media player. If extraction fails, LiveHub reports the error and never opens the platform page.

## Development

```bash
npm install
npm run dev
```

The first Douyin request builds `native/douyin-helper` with Go and fetches a small set of featured categories so the first screen can render quickly. The Electron main process then fetches all exposed categories and pages in the background. The other three adapters follow the same featured-first/full-background flow.

The current Douyin web category page exposes 15 rooms per category. This gives LiveHub broad real-time coverage, but it is not a guarantee that every live room on Douyin is returned. The separate cursor-based endpoint is protected by Douyin's browser risk-control flow, so it remains an isolated follow-up provider instead of being bypassed in the first integration. The other platforms have similar directory/API limits, so “all” means all rooms exposed by the public category and pagination endpoints at refresh time.

## Build

```bash
npm run typecheck
npm run build
npm start
```

## Planned integration

1. Stabilize Douyin aggregation with a cursor-pagination provider.
2. Add more direct-stream quality selection and provider diagnostics.
3. Add player process lifecycle management and packaged-app verification on Windows and macOS.
4. Replace external-player launching with bundled native media components where practical.
