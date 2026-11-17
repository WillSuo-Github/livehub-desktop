import { favoriteKey, getFavoriteRooms, updateFavoriteCollection, type FavoriteCollection } from "./favorites";
import type { FavoriteRoomsRefresh, LiveRoom } from "./types";

export function createFavoriteRefresher(options: {
  read(): FavoriteCollection;
  save(collection: FavoriteCollection): void;
  request(ids: string[]): Promise<FavoriteRoomsRefresh>;
}): () => Promise<number> {
  let pending: Promise<number> | undefined;
  const run = async (): Promise<number> => {
    const requested = new Set<string>();
    let failures = 0;
    while (true) {
      const batch = [...new Set(options.read().ids)].filter((id) => !requested.has(id)
        && /^(bilibili|douyu|huya|douyin-web)-\d{1,20}$/.test(id)).slice(0, 100);
      if (batch.length === 0) break;
      batch.forEach((id) => requested.add(id));
      let result: FavoriteRoomsRefresh;
      try { result = await options.request(batch); }
      catch { result = { rooms: [], failedIds: batch }; }
      const current = options.read();
      const failed = new Set(result.failedIds);
      failures += failed.size;
      // Douyin's saved room ID is a session ID, but failures use the stable favorite key.
      const unavailable = getFavoriteRooms([], current.ids, current.rooms)
        .filter((room) => failed.has(favoriteKey(room)) || failed.has(room.id))
        .map((room): LiveRoom => ({ ...room, status: "unknown", updatedAt: "状态暂不可用", checkedAt: Date.now(), playback: undefined }));
      // Read again after each request so removing a favorite while refreshing stays removed.
      const rooms = result.rooms.map((room) => {
        const saved = current.rooms.find((candidate) => favoriteKey(candidate) === favoriteKey(room));
        // A status-only response may omit artwork and category metadata.
        return saved ? { ...room, cover: room.cover || saved.cover,
          category: room.category === "直播" ? saved.category : room.category,
          tags: room.tags.length ? room.tags : saved.tags } : room;
      });
      options.save(updateFavoriteCollection(current, [...rooms, ...unavailable]));
    }
    return failures;
  };
  return () => {
    if (!pending) pending = run().finally(() => { pending = undefined; });
    return pending;
  };
}
