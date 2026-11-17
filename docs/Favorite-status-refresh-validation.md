# Favorite status refresh validation

Date: 2026-11-17 (Asia/Taipei)

## Problem and fix

Douyin stable favorite keys were excluded from both the renderer refresh filter
and the main-process favorite endpoint. A room disappearing from the directory
left its saved live state indefinitely.

- Favorite refresh now queries Douyin web room IDs alongside the other three
  platforms. It reads current status without requiring playable stream URLs and
  updates the session ID when a broadcast restarts.
- Startup, the five-minute timer, and the manual refresh button share the same
  refresh operation. Manual refresh requests both the featured directory and all
  favorites; partial directory failure does not cancel favorite updates.
- Failed lookup keys match stable Douyin identities, preserving the favorite
  while marking its state unknown. States older than ten minutes expire to
  unknown, checked every thirty seconds and whenever snapshots are saved.
- Overlapping refreshes share in-flight requests. Favorites added during a
  request are included; removed favorites stay removed. Missing artwork/category
  fields in status responses preserve existing metadata.

## Verification

- `npm run typecheck`: passed.
- `npm test`: 52 JavaScript tests passed; Go helper tests passed.
- `npm run build`: passed.
- `node_modules/.bin/electron scripts/qa-favorite-refresh.cjs`: passed using the
  built renderer, production preload/IPC, and real favorite service/parser with
  simulated provider responses and an isolated temporary user profile.
  It verifies manual requests for both directory and favorites, live-count
  decreases on offline results, session changes on restart, unknown state on
  failure, independent directory failure, and the busy button through an
  overlapping directory-update event. The script cleans up its profile on exit.
- Live network check at 22:41 queried the user's ten favorite IDs through the
  updated service: ten successful results, zero failed IDs, four live and six
  offline. The four stale live Douyin favorites from the investigation returned
  offline; the previously unresolved Douyin entry returned anchor metadata.
- An isolated renderer screenshot was inspected: an ended favorite remained in
  the collection, showed the offline badge, and no longer contributed to the
  sidebar live count.

## Source validation scope

At the time of source validation, the installed application was not replaced
and no release had been published. The fix is included in release v0.1.32. The live endpoint check and simulated UI check
are separate; this does not claim acceptance of an installed distribution build.
