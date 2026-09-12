# LiveHub Desktop

LiveHub is a cross-platform desktop client for collecting live rooms from Douyin, Douyu, Huya, and Bilibili in one place.

## Current status

- Electron desktop shell is ready.
- React + TypeScript renderer is ready.
- Platform filters, search, favorites, detail panel, and settings shell are ready.
- Douyin data is fetched by our own standard-library Go helper. Its HTML parser flow is adapted from DYLIVE, but DYLIVE is not a runtime dependency.
- The helper aggregates every currently exposed leaf category, deduplicates rooms, sorts by viewer count, and reports partial category failures.
- Douyu, Huya, and Bilibili use independent TypeScript adapters and their public directory APIs. Demo rooms are no longer mixed into the result.
- The adapters aggregate public categories and pagination, deduplicate rooms, retry transient HTTP failures, and expose per-platform coverage status.
- Clicking a room opens its platform page. Direct stream playback is intentionally isolated behind `electron/platform-service.ts` for the next integration.

## Development

```bash
npm install
npm run dev
```

The first Douyin request builds `native/douyin-helper` with Go and then fetches the current room list across all exposed categories. The other three adapters fetch their category lists and pages in parallel from the Electron main process.

The current Douyin web category page exposes 15 rooms per category. This gives LiveHub broad real-time coverage, but it is not a guarantee that every live room on Douyin is returned. The separate cursor-based endpoint is protected by Douyin's browser risk-control flow, so it remains an isolated follow-up provider instead of being bypassed in the first integration. The other platforms have similar directory/API limits, so “all” means all rooms exposed by the public category and pagination endpoints at refresh time.

## Build

```bash
npm run typecheck
npm run build
npm start
```

## Planned integration

1. Stabilize Douyin aggregation with cache-aware refresh and a cursor-pagination provider.
2. Add a Streamlink compatibility bridge for the first playable version.
3. Add player selection and process lifecycle management.
4. Replace the compatibility bridge with bundled native media components where practical.
