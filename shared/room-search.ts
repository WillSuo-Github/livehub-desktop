import type { LiveRoom, RoomSearchPage } from "./types";

export function matchesRoomQuery(room: LiveRoom, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  return !normalized || [room.id, room.title, room.anchor, room.category, ...room.tags].some((value) => value.toLowerCase().includes(normalized));
}

export function mergeSearchRooms(local: LiveRoom[], remote: LiveRoom[], query: string): LiveRoom[] {
  const rooms = new Map(local.filter((room) => matchesRoomQuery(room, query)).map((room) => [room.id, room]));
  // Server search can match aliases and fuzzy names that do not contain the keyword.
  for (const room of remote) {
    const current = rooms.get(room.id);
    if (!current || (room.checkedAt ?? 0) >= (current.checkedAt ?? 0)) rooms.set(room.id, room);
  }
  return [...rooms.values()];
}

export function appendSearchPages(current: RoomSearchPage[], next: RoomSearchPage[]): RoomSearchPage[] {
  const pages = new Map(current.map((page) => [page.platform, page]));
  for (const page of next) {
    const previous = pages.get(page.platform);
    pages.set(page.platform, { ...page, rooms: mergeSearchRooms(previous?.rooms ?? [], page.rooms, "") });
  }
  return [...pages.values()];
}
