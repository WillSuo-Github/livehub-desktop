# Local Stremio validation — 2026-10-18

## Environment

- LiveHub working tree based on `8bb77a3`; standalone addon version `0.1.28`.
- macOS, Node.js `v26.12.0`, loopback server on port `11471`.
- Vunio: local macOS Debug `1.0.2 (202610140002)`, built and launched with
  `./script/build_and_run.sh --preview` in the Vunio repository. The preview
  uses its existing isolated subscription/library store.
- This record covers local macOS behavior. No iOS/device, remote deployment,
  App Store or TestFlight validation was performed for this change.

## Results

In Vunio's **Add Protocol** sheet, importing
`http://127.0.0.1:11471/manifest.json` saved one **LiveHub** subscription.
Its catalog picker exposed all four platforms. Each row below was opened from
its catalog, searched by anchor name, and played through Vunio's stream picker.
Actual video was visually confirmed in each Vunio playback window.

| Platform | Search | Room | Selected option | Vunio video |
| --- | --- | --- | --- | --- |
| Douyin | 小涵宝 | `douyin-7697856139639524096` | FLV `origin` | Confirmed |
| Douyu | 超级小桀 | `douyu-74751` | FLV `source` | Confirmed |
| Huya | 神枪小子 | `huya-149721` | FLV `al_source` | Confirmed |
| Bilibili | 无畏契约赛事 | `bilibili-22908869` | FLV `source-1` | Confirmed |

An additional HTTP/FFmpeg probe at approximately 15:14 China Standard Time
requested catalogs, the second page (`skip=50`), search, metadata and streams
from the addon. It passed the supplied stream request headers to FFmpeg and
decoded a five-second sample. These are decoder checks independent of Vunio's
visual checks; they do not establish subjective audio quality or A/V sync.

| Platform | First page | Second page | Search hits | Stream options | Decoded frames | Audio decoded |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Douyin | 50 | 50 | 1 | 24 | 300 | Yes |
| Douyu | 50 | 50 | 4 | 1 | 147 | Yes |
| Huya | 50 | 50 | 1 | 15 | 41 | Yes |
| Bilibili | 50 | 50 | 1 | 2 | 147 | Yes |

The earlier probe received one HTTP 502 from Douyin's stream lookup. A fresh
lookup succeeded, and all four platforms passed the repeated probe. This is
an observed upstream lookup failure with successful retry, not evidence of
failure-free service. No expired category stream was used as a fallback.

## Automated checks

- `npm run typecheck`: passed.
- `npm test`: 19 tests passed, 0 failures (11 existing, 8 addon tests).
- `npm run build`: TypeScript and Vite production build passed.
- Vunio `./script/build_and_run.sh --preview`: `BUILD SUCCEEDED`.
- `git diff --check`: passed.

## Scope and remaining boundaries

- Default search covers the current featured index, not all rooms on a
  platform. `--full-sync` is available; a complete full-sync run was not part
  of this acceptance check.
- Room counts, stream options, live status and URLs change over time. The
  table records this run and should not be treated as current availability.
- Playback is direct to the CDN. Long-session URL renewal, all CDN/quality
  combinations, danmaku and favorite synchronization are outside this check.
