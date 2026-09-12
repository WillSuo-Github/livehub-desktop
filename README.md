# LiveHub Desktop

LiveHub is a cross-platform desktop client for collecting live rooms from Douyin, Douyu, Huya, and Bilibili in one place.

## Current status

- Electron desktop shell is ready.
- React + TypeScript renderer is ready.
- Platform filters, search, favorites, detail panel, and settings shell are ready.
- Douyin data is fetched by our own standard-library Go helper. Its HTML parser flow is adapted from DYLIVE, but DYLIVE is not a runtime dependency.
- The helper aggregates every currently exposed leaf category, deduplicates rooms, sorts by viewer count, and reports partial category failures.
- Douyu, Huya, and Bilibili still use demo data.
- The player bridge is intentionally isolated behind `electron/platform-service.ts`.

## Development

```bash
npm install
npm run dev
```

The first Douyin request builds `native/douyin-helper` with Go and then fetches the current room list across all exposed categories.

The current Douyin web category page exposes 15 rooms per category. This gives LiveHub broad real-time coverage, but it is not a guarantee that every live room on Douyin is returned. The separate cursor-based endpoint is protected by Douyin's browser risk-control flow, so it remains an isolated follow-up provider instead of being bypassed in the first integration.

## Build

```bash
npm run typecheck
npm run build
npm start
```

## Planned integration

1. Stabilize Douyin aggregation with cache-aware refresh and a cursor-pagination provider.
2. Add platform adapters for Douyu, Huya, and Bilibili.
3. Add a Streamlink compatibility bridge for the first playable version.
4. Add player selection and process lifecycle management.
5. Replace the compatibility bridge with bundled native media components where practical.
