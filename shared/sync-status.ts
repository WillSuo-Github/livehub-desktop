import type { AppInfo } from "./types";

interface SyncCoverage {
  partial: boolean;
  complete?: boolean;
  coverageNote?: string;
  failedCategories?: unknown[];
}

export function roomSyncMessage(mode: "featured" | "full", fetched: number, total: number, result: SyncCoverage): string {
  const failures = result.failedCategories?.length ?? 0;
  const coverage = result.coverageNote
    ?? (result.partial ? failures > 0 ? `${failures} 个分类未完成` : "覆盖不完整" : "分类全部成功");
  if (mode === "featured") return `热门已刷新 ${fetched} 个，当前收录 ${total} 个房间，${coverage}`;
  const label = result.partial ? "同步未完成，当前收录" : result.complete === false ? "已同步收录" : "完整同步";
  return `${label} ${total} 个房间，${coverage}`;
}

export function fullSyncToast(info: AppInfo, roomCount: number): string {
  const limited = info.platforms.some((platform) => {
    const status = info[platform];
    return status.state !== "connected" || status.partial || status.complete === false;
  });
  return limited
    ? `本轮同步结束，当前收录 ${roomCount.toLocaleString("zh-CN")} 个直播间；部分平台未完成或覆盖有限，请查看平台状态。`
    : `全量同步完成，共获取 ${roomCount.toLocaleString("zh-CN")} 个直播间。`;
}
