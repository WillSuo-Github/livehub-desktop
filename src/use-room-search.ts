import { useEffect, useRef, useState } from "react";
import type { PlatformId, RoomSearchPage } from "../shared/types";
import { appendSearchPages } from "../shared/room-search";

export function useRoomSearch(query: string, platform: PlatformId | "all", enabled: boolean) {
  const keyword = query.trim();
  const key = enabled && keyword && platform !== "douyin" ? `${platform}:${keyword}` : "";
  const generation = useRef(0);
  const [state, setState] = useState<{ key: string; pages: RoomSearchPage[]; loading: boolean }>({ key: "", pages: [], loading: false });

  useEffect(() => {
    const request = ++generation.current;
    setState({ key, pages: [], loading: Boolean(key) });
    if (!key) return;
    const timer = window.setTimeout(() => {
      void window.livehub.searchRooms(keyword, platform).then((pages) => {
        if (generation.current === request) setState({ key, pages, loading: false });
      }).catch(() => {
        if (generation.current === request) setState({ key, loading: false, pages: (platform === "all" ? ["bilibili", "douyu", "huya"] as const : [platform as "bilibili" | "douyu" | "huya"]).map((target) => ({ platform: target, page: 0, rooms: [], hasMore: false, error: "主播搜索失败，请重试。" })) });
      });
    }, 400);
    return () => { window.clearTimeout(timer); generation.current += 1; };
  }, [key, keyword, platform]);

  const current = state.key === key ? state : { key, pages: [], loading: Boolean(key) };
  const loadMore = async (): Promise<void> => {
    if (!key || current.loading) return;
    const request = generation.current;
    const targets = current.pages.filter((page) => page.hasMore || page.error);
    setState((previous) => ({ ...previous, loading: true }));
    const pages = await Promise.all(targets.map(async (page) => {
      try { return await window.livehub.searchRooms(keyword, page.platform, page.page + 1); }
      catch { return [{ ...page, rooms: [], error: "主播搜索失败，请重试。" }]; }
    }));
    if (generation.current === request) setState((previous) => ({ key, pages: appendSearchPages(previous.pages, pages.flat()), loading: false }));
  };

  return { ...current, loadMore, rooms: current.pages.flatMap((page) => page.rooms), hasMore: current.pages.some((page) => page.hasMore || page.error) };
}
