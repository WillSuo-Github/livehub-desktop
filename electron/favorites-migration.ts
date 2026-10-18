import { mapWithConcurrency } from "./platform-http";
import type { FavoritesMigrationResult } from "../shared/types";

interface ReflowResponse {
  status_code?: number;
  data?: { room?: { id_str?: string; owner?: { web_rid?: string } } };
}

export async function resolveLegacyDouyinFavorite(roomId: string): Promise<string> {
  if (!/^\d{1,20}$/.test(roomId)) {
    throw new Error("Invalid legacy Douyin room ID");
  }
  const url = new URL("https://webcast.amemv.com/webcast/room/reflow/info/");
  url.search = new URLSearchParams({ type_id: "0", live_id: "1", room_id: roomId, app_id: "1128" }).toString();
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    headers: {
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 15_4_1 like Mac OS X) AppleWebKit/605.1.15 Version/15.4 Mobile/15E148 Safari/604.1",
      Referer: "https://live.douyin.com/",
    },
  });
  if (!response.ok) {
    throw new Error(`Douyin favorite lookup returned HTTP ${response.status}`);
  }
  const data = await response.json() as ReflowResponse;
  const room = data.data?.room;
  const webRid = room?.owner?.web_rid;
  if (data.status_code !== 0 || room?.id_str !== roomId || !webRid || !/^\d{1,20}$/.test(webRid)) {
    throw new Error("Douyin favorite lookup did not identify the requested room");
  }
  return `douyin-web-${webRid}`;
}

export async function migrateFavoriteIds(
  ids: string[],
  resolve = resolveLegacyDouyinFavorite,
): Promise<FavoritesMigrationResult> {
  if (!Array.isArray(ids) || ids.length > 10_000
    || !ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 100)) {
    throw new Error("Invalid favorites data");
  }
  let migratedCount = 0;
  let unresolvedCount = 0;
  const resolved = await mapWithConcurrency([...new Set(ids)], 3, async (id) => {
    const match = id.match(/^douyin-(\d{1,20})$/);
    if (!match) return id;
    try {
      const key = await resolve(match[1]);
      if (!/^douyin-web-\d{1,20}$/.test(key)) throw new Error("Invalid migrated favorite key");
      migratedCount += 1;
      return key;
    } catch {
      // Never delete a favorite because of a network or platform failure. Retry next launch.
      unresolvedCount += 1;
      return id;
    }
  });
  const unique = [...new Set(resolved)];
  return { ids: unique, migratedCount, unresolvedCount, mergedCount: ids.length - unique.length };
}
