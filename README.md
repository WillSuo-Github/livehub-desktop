# LiveHub Desktop

LiveHub is a cross-platform desktop client for collecting live rooms from Douyin, Douyu, Huya, and Bilibili in one place.

## Current status

- Electron desktop shell is ready.
- React + TypeScript renderer is ready.
- Platform filters, search, favorites, detail panel, and settings shell are ready.
- Douyin category and room data are now fetched through a Go helper backed by DYLIVE.
- Douyu, Huya, and Bilibili still use demo data.
- The player bridge is intentionally isolated behind `electron/platform-service.ts`.

## Development

```bash
npm install
npm run dev
```

The first Douyin request builds `native/douyin-helper` with Go and then fetches the current category room list.

## Build

```bash
npm run typecheck
npm run build
npm start
```

## Planned integration

1. Add category selection and refresh controls for Douyin.
2. Add platform adapters for Douyu, Huya, and Bilibili.
3. Add a Streamlink compatibility bridge for the first playable version.
4. Add player selection and process lifecycle management.
5. Replace the compatibility bridge with bundled native media components where practical.
