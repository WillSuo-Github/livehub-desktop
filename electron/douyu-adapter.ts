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
const directoryPageConcurrency = 4;
// The all-directory list is not sorted by audience: strong rooms also sit on its last pages, so it is read in full.
const allCategory: DouyuCategory = { id: "0_0", name: "全部分类" };

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
  pagePath?: string;
}

interface DouyuCategory {
  id: string;
  name: string;
}

interface CategoryResult {
  rooms: PlatformRoomData[];
  failure?: PlatformCategoryFailure;
}

interface DirectoryResult {
  rooms: PlatformRoomData[];
  pageCount: number;
  failedPages: PlatformCategoryFailure[];
}

export class DouyuAdapter {
  async listFeaturedRooms(): Promise<PlatformListResult> {
    const directory = await this.listDirectoryRooms(allCategory);

    return {
      rooms: dedupeRooms(directory.rooms),
      categoryCount: directory.pageCount,
      successfulCategories: directory.pageCount - directory.failedPages.length,
      failedCategories: directory.failedPages,
      partial: directory.failedPages.length > 0,
      source: "douyu-directory-pagination",
      complete: directory.failedPages.length === 0,
    };
  }

  async listRooms(): Promise<PlatformListResult> {
    const categories = await this.listCategories();
    const directory = await this.listDirectoryRooms(allCategory).catch((error: unknown): DirectoryResult => ({
      rooms: [],
      pageCount: 1,
      failedPages: [{
        id: allCategory.id,
        name: allCategory.name,
        error: error instanceof Error ? error.message : String(error),
      }],
    }));
    const results = await mapWithConcurrency(categories, 6, (category) => this.listCategoryRooms(category));
    const failedCategories = [
      ...(directory.failedPages.length > 0
        ? [{
          id: allCategory.id,
          name: allCategory.name,
          error: `${directory.failedPages.length} 页失败：${directory.failedPages[0].error}`,
        }]
        : []),
      ...results.flatMap((result) => result.failure ? [result.failure] : []),
    ];
    const rooms = dedupeRooms([...directory.rooms, ...results.flatMap((result) => result.rooms)]);
    const categoryCount = categories.length + 1;

    return {
      rooms,
      categoryCount,
      successfulCategories: categoryCount - failedCategories.length,
      failedCategories,
      partial: failedCategories.length > 0,
      source: "douyu-directory-aggregation",
    };
  }

  private async listDirectoryRooms(category: DouyuCategory): Promise<DirectoryResult> {
    const firstPage = await this.fetchDirectoryPage(category, 1);
    const pageCount = Math.min(Math.max(1, firstPage.pageCount), maxPagesPerCategory);
    const laterPages = Array.from({ length: pageCount - 1 }, (_, index) => index + 2);
    const results = await mapWithConcurrency(laterPages, directoryPageConcurrency, async (page) => {
      try {
        return { rooms: (await this.fetchDirectoryPage(category, page)).rooms };
      } catch (error) {
        return {
          rooms: [] as PlatformRoomData[],
          failure: {
            id: `${category.id}-page-${page}`,
            name: `${category.name}第 ${page} 页`,
            error: error instanceof Error ? error.message : String(error),
          },
        };
      }
    });

    return {
      rooms: [...firstPage.rooms, ...results.flatMap((result) => result.rooms)],
      pageCount,
      failedPages: results.flatMap((result) => result.failure ? [result.failure] : []),
    };
  }

  private async fetchDirectoryPage(
    category: DouyuCategory,
    page: number,
  ): Promise<{ pageCount: number; rooms: PlatformRoomData[] }> {
    const response = await fetchJson<DouyuListResponse>(`${listUrl}/${category.id}/${page}`, requestHeaders);
    if (response.code !== 0 || !response.data) {
      throw new Error(response.msg || `Douyu category ${category.id} page ${page} request failed`);
    }

    return {
      pageCount: toNumber(response.data.pgcnt),
      rooms: (response.data.rl ?? []).map((room) => mapRoom(room, category)),
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

    for (const source of sourceCategories) {
      const id = directoryRouteKey(source);
      if (!id || id === allCategory.id) {
        continue;
      }

      categories.set(id, {
        id,
        name: source.cn2 || source.name || `分类 ${id}`,
      });
    }

    if (categories.size === 0) {
      throw new Error("Douyu directory category list is empty");
    }

    return Array.from(categories.values());
  }

  private async listCategoryRooms(
    category: DouyuCategory,
    pageLimit = maxPagesPerCategory,
  ): Promise<CategoryResult> {
    try {
      const rooms: PlatformRoomData[] = [];
      let totalPage = 0;
      const seenPages = new Set<string>();

      for (let page = 1; page <= Math.min(Math.max(1, totalPage), pageLimit); page += 1) {
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

        if (pageLimit === maxPagesPerCategory && page >= maxPagesPerCategory && totalPage > page) {
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

// Directory lists are routed as 2_<cid2>; cid1 is a business group whose key returns an empty list.
function directoryRouteKey(source: DouyuDirectoryCategory): string | null {
  const routeFromPath = source.pagePath?.match(/(\d+_\d+)\/?$/)?.[1];
  if (routeFromPath) {
    return routeFromPath;
  }

  return source.cid2 === undefined ? null : `2_${source.cid2}`;
}

function dedupeRooms(rooms: PlatformRoomData[]): PlatformRoomData[] {
  return Array.from(new Map(rooms.map((room) => [room.id, room])).values())
    .sort((left, right) => right.viewers - left.viewers);
}
