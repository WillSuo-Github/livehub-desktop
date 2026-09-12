# LiveHub Desktop

LiveHub is a cross-platform desktop client for collecting live rooms from Douyin, Douyu, Huya, and Bilibili in one place.

## Current status

- Electron desktop shell is ready.
- React + TypeScript renderer is ready.
- Platform filters, search, favorites, detail panel, and settings shell are ready.
- The current room list is demo data.
- The parser and player bridge are intentionally isolated behind `electron/platform-service.ts`.

## Development

```bash
npm install
npm run dev
```

## Build

```bash
npm run typecheck
npm run build
npm start
```

## Planned integration

1. Add platform adapters for Douyin, Douyu, Huya, and Bilibili.
2. Add a Streamlink compatibility bridge for the first playable version.
3. Add player selection and process lifecycle management.
4. Replace the compatibility bridge with bundled native media components where practical.
