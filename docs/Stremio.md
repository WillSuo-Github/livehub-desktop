# Local Stremio source

For the public remote subscription, import
`https://live-catalog-addon.open-live-catalog.workers.dev/manifest.json` in
[Vunio](https://vunio.willsuo.com/). No local LiveHub process is required.
The [README](../README.en.md#watch-live-streams-in-vunio) includes the setup
steps and current remote-platform limitations. The instructions below are for
the separate local development server, whose upstream network conditions differ.

LiveHub can also run as a standalone Stremio HTTP addon. One manifest exposes
Douyin, Douyu, Huya and Bilibili as four `tv` catalogs. The addon reuses the
desktop directory adapters and stream resolvers, without launching Electron.

## Run

Prerequisites: Node.js 22 or newer, the repository's npm dependencies, and Go
when the Douyin helper has not been built yet. The helper is built automatically
on first use, or explicitly with `npm run build:helper`.

```sh
npm install
npm run stremio
```

In Vunio, choose **Add Protocol**, enter this URL, and save:

```text
http://127.0.0.1:11471/manifest.json
```

Select a platform in **Catalog**. Search matches indexed room titles, anchors,
categories, tags and room IDs. Open a room, then select a quality/CDN option to
play. The service must remain running while browsing and opening streams.

The loopback address works on the Mac running the service. To test another
device on the same trusted LAN, explicitly listen on the LAN interface:

```sh
npm run stremio -- --host 0.0.0.0 --port 11471
```

Import `http://<Mac-LAN-IP>:11471/manifest.json` on that device. There is no
authentication or TLS in this local development server; do not expose its port
to the public Internet. `stremio://` addresses normalize to HTTPS in Vunio, so
use the explicit `http://` address for this local server.

## Directory coverage and refresh

- Start with each platform's existing featured directory. These are not a
  guarantee of every live room on the platform. For example, Douyu's directory
  may expose thousands of rooms while Douyin's featured index is much smaller.
- Featured directories refresh every five minutes. Concurrent catalog, search
  and metadata requests share directory loads. Search filters the live index;
  it does not call a platform-wide search API.
- To expand the index with the desktop adapters' background full sync, use
  `npm run stremio -- --full-sync`. Full sync may take minutes and can be partial
  when upstream categories fail. Browse featured rooms while it runs.
- Catalog pages contain up to 50 entries. Room IDs are stable across refreshes.
- `http://127.0.0.1:11471/health.json` reports per-platform connection state,
  indexed room counts, refresh times and partial coverage. A manifest response
  alone does not mean the four upstream platforms have finished loading.
- If an upstream refresh fails with no indexed rooms, catalog loading returns
  an HTTP error. If rooms were already indexed, they remain available and
  health reports the failed refresh. Live status can lag until the next refresh.

## Playback

Opening `/stream/tv/{id}.json` resolves the current session from its platform.
Resolved FLV/HLS URLs are never persisted or reused for later plays. Concurrent
requests for one room share only their in-flight lookup. Each available
quality/CDN is a separate Stremio stream; required request headers are carried
in `behaviorHints.proxyHeaders.request`, with `notWebReady: true`.

Video travels directly from the platform CDN to Vunio. This service does not
relay video, transcode or execute downloaded addon scripts. Platform/CDN
restrictions, expired URLs and room closures can still interrupt playback.
Reopen the room to resolve a new URL. Long-running automatic URL renewal is not
implemented. Danmaku and desktop favorites are not part of this addon.

Supported routes:

```text
/manifest.json
/catalog/tv/livehub-{douyin|douyu|huya|bilibili}.json
/catalog/tv/livehub-{platform}/search={encoded-text}&skip={offset}.json
/meta/tv/livehub%3A{platform}-{room-id}.json
/stream/tv/livehub%3A{platform}-{room-id}.json
/health.json
```

Resource IDs are resolved only against the platform directory. Arbitrary
user-supplied playback URLs are not accepted. Errors and server logs omit
provider response bodies, signed media URLs and cookies.

## Validation

```sh
npm run typecheck
npm test
npm run build
```

The HTTP tests cover four catalogs, Unicode/escaped search, paging, metadata,
headers, fresh URLs, concurrent lookups, background updates and upstream errors.
They use deterministic fixtures. Live acceptance additionally requires importing
the manifest in Vunio and checking browsing, search and actual video playback
for each platform; see `Stremio-local-validation.md` for the recorded local run.

Protocol references: [Stremio addon protocol](https://stremio.github.io/stremio-addon-sdk/protocol.html),
[manifest](https://stremio.github.io/stremio-addon-sdk/api/responses/manifest.html),
[streams](https://stremio.github.io/stremio-addon-sdk/api/responses/stream.html).
