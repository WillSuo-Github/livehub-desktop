import { cleanText, fetchJson, fetchText, mapWithConcurrency, toNumber } from "./platform-http";
import type {
  PlatformCategoryFailure,
  PlatformListResult,
  PlatformRoomData,
} from "./platform-adapter";

const listUrl = "https://www.douyu.com/gapi/rkc/directory/mixList";
const directoryUrl = "https://www.douyu.com/directory/all";
const requestHeaders = {
  Referer: "https://www.douyu.com/directory",
};
const maxPagesPerCategory = 100;

interface DouyuRoom {
  rid?: number | string;
  rn?: string;
  uid?: number | string;
  nn?: string;
  c1name?: string;
  c2name?: string;
  c3name?: string;
  ol?: number | string;
  rs1?: string;
  rs16?: string;
  url?: string;
}

interface DouyuListResponse {
  code: number;
  msg?: string;
  data?: {
    pgcnt?: number | string;
    rl?: DouyuRoom[];
  };
}

interface DouyuDirectoryData {
  cateTabList?: DouyuDirectoryCategory[];
  leftNav?: {
    cateList?: Array<{
      list?: DouyuDirectoryCategory[];
    }>;
  };
}

interface DouyuDirectoryCategory {
  cid1?: number | string;
  cid2?: number | string;
  name?: string;
  cn2?: string;
}

interface DouyuCategory {
  id: string;
  name: string;
}

interface CategoryResult {
  rooms: PlatformRoomData[];
  failure?: PlatformCategoryFailure;
}

export class DouyuAdapter {
  async listRooms(): Promise<PlatformListResult> {
    const categories = await this.listCategories();
    const results = await mapWithConcurrency(categories, 6, (category) => this.listCategoryRooms(category));
    const failedCategories = results.flatMap((result) => result.failure ? [result.failure] : []);
    const rooms = dedupeRooms(results.flatMap((result) => result.rooms));

    return {
      rooms,
      categoryCount: categories.length,
      successfulCategories: categories.length - failedCategories.length,
      failedCategories,
      partial: failedCategories.length > 0,
      source: "douyu-directory-aggregation",
    };
  }

  private async listCategories(): Promise<DouyuCategory[]> {
    const html = await fetchText(directoryUrl, requestHeaders);
    const marker = "var $DATA = ";
    const start = html.indexOf(marker);
    const end = start < 0 ? -1 : html.indexOf(";\n", start);
    if (start < 0 || end < 0) {
      throw new Error("Douyu directory data was not found");
    }

    let data: DouyuDirectoryData;
    try {
      data = JSON.parse(html.slice(start + marker.length, end)) as DouyuDirectoryData;
    } catch {
      throw new Error("Douyu directory data is invalid JSON");
    }

    const sourceCategories = [
      ...(data.cateTabList ?? []),
      ...(data.leftNav?.cateList ?? []).flatMap((group) => group.list ?? []),
    ];
    const categories = new Map<string, DouyuCategory>();
    categories.set("0_0", { id: "0_0", name: "全部分类" });

    for (const source of sourceCategories) {
      if (source.cid1 === undefined || source.cid2 === undefined) {
        continue;
      }

      const id = `${source.cid1}_${source.cid2}`;
      categories.set(id, {
        id,
        name: source.cn2 || source.name || `分类 ${id}`,
      });
    }

    if (categories.size <= 1) {
      throw new Error("Douyu directory category list is empty");
    }

    return Array.from(categories.values());
  }

  private async listCategoryRooms(category: DouyuCategory): Promise<CategoryResult> {
    try {
      const rooms: PlatformRoomData[] = [];
      let totalPage = 0;
      const seenPages = new Set<string>();

      for (let page = 1; page <= Math.min(Math.max(1, totalPage), maxPagesPerCategory); page += 1) {
        const response = await fetchJson<DouyuListResponse>(`${listUrl}/${category.id}/${page}`, requestHeaders);
        if (response.code !== 0 || !response.data) {
          throw new Error(response.msg || `Douyu category ${category.id} request failed`);
        }

        totalPage = toNumber(response.data.pgcnt);
        const pageRooms = response.data.rl ?? [];
        const pageKey = pageRooms.map((room) => room.rid).join(",");
        if (!pageKey || seenPages.has(pageKey)) {
          break;
        }
        seenPages.add(pageKey);
        rooms.push(...pageRooms.map((room) => mapRoom(room, category)));

        if (page >= maxPagesPerCategory && totalPage > page) {
          throw new Error(`page limit reached (${maxPagesPerCategory})`);
        }
      }

      return { rooms };
    } catch (error) {
      return {
        rooms: [],
        failure: {
          id: category.id,
          name: category.name,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
}

function mapRoom(
  room: DouyuRoom,
  category: DouyuCategory,
): PlatformRoomData {
  const id = String(room.rid ?? `${category.id}-${room.uid ?? room.nn ?? "room"}`);
  const viewers = toNumber(room.ol);
  const categoryName = room.c3name || room.c2name || room.c1name || category.name;

  return {
    id: `douyu-${id}`,
    title: cleanText(room.rn, "斗鱼直播"),
    anchor: cleanText(room.nn, "未知主播"),
    category: cleanText(categoryName, "直播"),
    viewers,
    viewerLabel: viewers.toLocaleString("zh-CN"),
    cover: room.rs16 || room.rs1 || "",
    webUrl: `https://www.douyu.com/${id}`,
    status: "live",
  };
}

function dedupeRooms(rooms: PlatformRoomData[]): PlatformRoomData[] {
  return Array.from(new Map(rooms.map((room) => [room.id, room])).values())
    .sort((left, right) => right.viewers - left.viewers);
}
