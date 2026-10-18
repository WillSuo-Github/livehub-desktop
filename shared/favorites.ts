import type { LiveRoom } from "./types";

export const favoritesStorageKey = "livehub:favorites";
export const favoritesBackupKey = "livehub:favorites:backup:v1";

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

export function getFavoriteRooms(rooms: LiveRoom[], ids: string[]): LiveRoom[] {
  const unique = new Map<string, LiveRoom>();
  for (const room of rooms) {
    if (!isFavoriteRoom(room, ids)) continue;
    const key = favoriteKey(room);
    const current = unique.get(key);
    if (!current || (current.status !== "live" && room.status === "live")) unique.set(key, room);
  }
  return [...unique.values()];
}

export function toggleFavoriteRoom(room: LiveRoom, ids: string[]): string[] {
  const key = favoriteKey(room);
  return isFavoriteRoom(room, ids)
    ? ids.filter((id) => id !== key && id !== room.id)
    : [...ids, key];
}
