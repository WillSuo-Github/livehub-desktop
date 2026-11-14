import type { LiveRoom } from "./types";

export const favoritesStorageKey = "livehub:favorites";
export const favoritesBackupKey = "livehub:favorites:backup:v1";
export const favoriteCollectionKey = "livehub:favorites:v2";

export interface FavoriteCollection {
  version: 2;
  ids: string[];
  rooms: LiveRoom[];
}

export function parseFavoriteCollection(value: string | null, legacyValue: string | null): FavoriteCollection {
  if (value === null) return { version: 2, ids: parseFavoriteIds(legacyValue), rooms: [] };
  const parsed = JSON.parse(value) as FavoriteCollection;
  if (!parsed || parsed.version !== 2 || !Array.isArray(parsed.ids) || !Array.isArray(parsed.rooms)) throw new Error("Invalid favorite collection");
  const ids = parseFavoriteIds(JSON.stringify(parsed.ids));
  if (!parsed.rooms.every((room) => room && typeof room.id === "string"
    && ["douyin", "douyu", "huya", "bilibili"].includes(room.platform)
    && [room.title, room.anchor, room.category, room.cover, room.updatedAt].every((value) => typeof value === "string")
    && Array.isArray(room.tags) && room.tags.every((tag) => typeof tag === "string")
    && typeof room.viewers === "number" && ["live", "offline", "unknown"].includes(room.status))) throw new Error("Invalid favorite rooms");
  // A previous launch cannot establish that a broadcast is still live.
  return { version: 2, ids, rooms: parsed.rooms.map((room) => ({ ...room, playback: undefined, status: "unknown", updatedAt: "等待更新", checkedAt: 0 })) };
}

export function updateFavoriteCollection(collection: FavoriteCollection, rooms: LiveRoom[]): FavoriteCollection {
  const updated = getFavoriteRooms(rooms, collection.ids, collection.rooms).map((room) => ({ ...room, playback: undefined }));
  return { ...collection, rooms: updated };
}

export function toggleFavoriteCollection(collection: FavoriteCollection, room: LiveRoom): FavoriteCollection {
  const ids = toggleFavoriteRoom(room, collection.ids);
  return updateFavoriteCollection({ ...collection, ids }, [room]);
}

export function parseFavoriteIds(value: string | null): string[] {
  const parsed: unknown = JSON.parse(value ?? "[]");
  if (!Array.isArray(parsed) || !parsed.every((id) => typeof id === "string" && id.length > 0)) {
    throw new Error("Invalid favorites data");
  }
  return parsed;
}

// Keep the session ID for playback and chat; only favorites use the stable web room ID.
export function favoriteKey(room: Pick<LiveRoom, "id" | "platform" | "webUrl">): string {
  if (room.platform === "douyin" && room.webUrl) {
    try {
      const url = new URL(room.webUrl);
      const match = url.pathname.match(/^\/(?:room\/)?([0-9]+)\/?$/);
      if (url.hostname === "live.douyin.com" && ["https:", "http:"].includes(url.protocol)
        && !url.username && !url.password && !url.port && match) {
        return `douyin-web-${match[1]}`;
      }
    } catch {
      // Legacy rooms without a usable web URL remain recoverable through migration.
    }
  }
  return room.id;
}

export function isFavoriteRoom(room: LiveRoom, ids: string[]): boolean {
  return ids.includes(favoriteKey(room)) || ids.includes(room.id);
}

export function getFavoriteRooms(rooms: LiveRoom[], ids: string[], saved: LiveRoom[] = []): LiveRoom[] {
  const unique = new Map<string, LiveRoom>();
  for (const room of [...saved, ...rooms]) {
    if (!isFavoriteRoom(room, ids)) continue;
    const key = favoriteKey(room);
    const current = unique.get(key);
    if (!current || (room.checkedAt ?? 0) > (current.checkedAt ?? 0)
      || ((room.checkedAt ?? 0) === (current.checkedAt ?? 0) && current.status !== "live" && room.status === "live")) unique.set(key, room);
  }
  for (const id of ids) {
    if ([...unique.values()].some((room) => isFavoriteRoom(room, [id]))) continue;
    const match = id.match(/^(douyin-web|douyin|douyu|huya|bilibili)-(\d{1,20})$/);
    if (!match) continue;
    const platform = match[1].startsWith("douyin") ? "douyin" : match[1] as LiveRoom["platform"];
    const origins = { douyin: "https://live.douyin.com/", douyu: "https://www.douyu.com/", huya: "https://www.huya.com/", bilibili: "https://live.bilibili.com/" };
    unique.set(id, {
      id, platform, title: "正在恢复主播资料", anchor: `直播间 ${match[2]}`, category: "直播", tags: [], viewers: 0,
      cover: "linear-gradient(135deg, #24334b, #695185)", status: "unknown", updatedAt: "等待更新", checkedAt: 0,
      webUrl: match[1] === "douyin" ? undefined : origins[platform] + match[2],
    });
  }
  return [...unique.values()];
}

export function toggleFavoriteRoom(room: LiveRoom, ids: string[]): string[] {
  const key = favoriteKey(room);
  return isFavoriteRoom(room, ids)
    ? ids.filter((id) => id !== key && id !== room.id)
    : [...ids, key];
}
