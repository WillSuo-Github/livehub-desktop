import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AppInfo,
  DanmakuKind,
  DanmakuKindFilter,
  LiveRoom,
  PlatformId,
  PlatformRoomsUpdate,
  PlayerState,
  UpdateStatus,
} from "../shared/types";
import { danmakuKindLabels, danmakuKinds, defaultDanmakuKindFilter } from "../shared/danmaku";
import { vupiloPlayerId } from "../shared/vupilo";
import { expireFavoriteStatuses, favoriteKey, favoriteCollectionKey, favoritesBackupKey, favoritesStorageKey, getFavoriteRooms, isFavoriteRoom, parseFavoriteCollection, toggleFavoriteCollection, updateFavoriteCollection, type FavoriteCollection } from "../shared/favorites";
import { createFavoriteRefresher } from "../shared/favorite-refresh";
import { matchesRoomQuery, mergeSearchRooms } from "../shared/room-search";
import { useRoomSearch } from "./use-room-search";
import { fullSyncToast } from "../shared/sync-status";

type PlatformFilter = "all" | PlatformId;
type ViewId = "rooms" | "favorites" | "settings";
type RoomSortMode = "online" | "popularity";
type RoomLayout = "grid" | "list";
interface CategoryOption {
  name: string;
  count: number;
  platforms: PlatformId[];
}

const platformMeta: Record<PlatformId, { label: string; short: string; accent: string }> = {
  douyin: { label: "抖音", short: "抖", accent: "#a78bfa" },
  douyu: { label: "斗鱼", short: "鱼", accent: "#ff9f6e" },
  huya: { label: "虎牙", short: "虎", accent: "#f7c65b" },
  bilibili: { label: "哔哩哔哩", short: "哔", accent: "#7dd3fc" },
};

const platformFilters: Array<{ id: PlatformFilter; label: string }> = [
  { id: "all", label: "全部平台" },
  { id: "douyin", label: "抖音" },
  { id: "douyu", label: "斗鱼" },
  { id: "huya", label: "虎牙" },
  { id: "bilibili", label: "哔哩哔哩" },
];

const formatViewers = (viewers: number): string => {
  if (viewers >= 10000) {
    return `${(viewers / 10000).toFixed(1)}万`;
  }

  return viewers.toLocaleString("zh-CN");
};

const displayViewers = (room: LiveRoom): string => room.viewerLabel ?? formatViewers(room.viewers);
const roomStatusLabel = (room: LiveRoom): string => room.status === "live" ? "直播中" : room.status === "offline" ? "未开播" : "状态待确认";
const roomStatusClass = (room: LiveRoom): string =>
  room.status === "live" ? "is-live" : room.status === "unknown" ? "not-live status-unknown" : "not-live";
const nonLiveSectionLabel = (roomsToLabel: LiveRoom[]): string => {
  const hasOffline = roomsToLabel.some((room) => room.status === "offline");
  const hasUnknown = roomsToLabel.some((room) => room.status === "unknown");
  if (hasOffline && hasUnknown) {
    return "未开播 · 待确认";
  }
  return hasUnknown ? "状态待确认" : "未开播";
};
const audienceValueLabel = (room: LiveRoom): string => {
  if (room.audienceMetric === "heat") {
    return "人气";
  }

  if (room.audienceMetric === "platform-online") {
    return "平台在线";
  }

  return "人观看";
};
const audienceStatLabel = (room: LiveRoom): string => {
  if (room.audienceMetric === "heat") {
    return "平台人气";
  }

  if (room.audienceMetric === "platform-online") {
    return "平台在线";
  }

  return "观看人数";
};
const roomPageSize = 120;
const isMacOS = navigator.platform.toLowerCase().includes("mac");

const platformTieBreakOrder: PlatformId[] = ["bilibili", "douyin", "douyu", "huya"];

const hasReportedOnlineMetric = (room: LiveRoom): boolean =>
  room.audienceMetric === "online" || room.audienceMetric === "platform-online";

function sortRoomsByNormalizedPopularity(rooms: LiveRoom[]): LiveRoom[] {
  const roomsByPlatform = new Map<PlatformId, LiveRoom[]>();
  for (const room of rooms) {
    const platformRooms = roomsByPlatform.get(room.platform) ?? [];
    platformRooms.push(room);
    roomsByPlatform.set(room.platform, platformRooms);
  }

  const percentileByRoomId = new Map<string, number>();
  for (const platformRooms of roomsByPlatform.values()) {
    const sortedPlatformRooms = [...platformRooms].sort((left, right) => {
      const viewerDifference = right.viewers - left.viewers;
      return viewerDifference || left.id.localeCompare(right.id);
    });
    const denominator = Math.max(1, sortedPlatformRooms.length - 1);

    sortedPlatformRooms.forEach((room, index) => {
      percentileByRoomId.set(
        room.id,
        sortedPlatformRooms.length === 1 ? 1 : 1 - index / denominator,
      );
    });
  }

  return [...rooms].sort((left, right) => {
    const popularityDifference = (percentileByRoomId.get(right.id) ?? 0) - (percentileByRoomId.get(left.id) ?? 0);
    if (popularityDifference !== 0) {
      return popularityDifference;
    }

    const platformDifference = platformTieBreakOrder.indexOf(left.platform) - platformTieBreakOrder.indexOf(right.platform);
    if (platformDifference !== 0) {
      return platformDifference;
    }

    return right.viewers - left.viewers || left.id.localeCompare(right.id);
  });
}

function sortRoomsByOnlineAudience(rooms: LiveRoom[]): LiveRoom[] {
  const onlineRooms = rooms.filter(hasReportedOnlineMetric).sort((left, right) => {
    const viewerDifference = right.viewers - left.viewers;
    if (viewerDifference !== 0) {
      return viewerDifference;
    }

    return platformTieBreakOrder.indexOf(left.platform) - platformTieBreakOrder.indexOf(right.platform)
      || left.id.localeCompare(right.id);
  });
  const unavailableRooms = rooms.filter((room) => !hasReportedOnlineMetric(room));

  return [
    ...onlineRooms,
    ...sortRoomsByNormalizedPopularity(unavailableRooms),
  ];
}

function sortRoomsForDisplay(rooms: LiveRoom[], mode: RoomSortMode): LiveRoom[] {
  const sorted = mode === "online" ? sortRoomsByOnlineAudience(rooms) : sortRoomsByNormalizedPopularity(rooms);
  return sorted.sort((left, right) => Number(right.status === "live") - Number(left.status === "live"));
}

const mergePlatformRooms = (currentRooms: LiveRoom[], update: PlatformRoomsUpdate): LiveRoom[] => [
  ...currentRooms.filter((room) => room.platform !== update.platform),
  ...update.rooms,
];

function App() {
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [rooms, setRooms] = useState<LiveRoom[]>([]);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [activeView, setActiveView] = useState<ViewId>(() =>
    new URLSearchParams(window.location.search).get("view") === "settings" ? "settings" : "rooms",
  );
  const [selectedPlatform, setSelectedPlatform] = useState<PlatformFilter>("all");
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [categoryQuery, setCategoryQuery] = useState("");
  const [categoryPickerOpen, setCategoryPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const search = useRoomSearch(query, selectedPlatform, activeView === "rooms");
  const [favoriteLoad] = useState(() => {
    try {
      return { collection: parseFavoriteCollection(localStorage.getItem(favoriteCollectionKey), localStorage.getItem(favoritesStorageKey)), failed: false };
    } catch {
      return { collection: { version: 2, ids: [], rooms: [] } as FavoriteCollection, failed: true };
    }
  });
  const [favoriteCollection, setFavoriteCollection] = useState(favoriteLoad.collection);
  const favoriteCollectionRef = useRef(favoriteCollection);
  const favorites = favoriteCollection.ids;
  const [favoritesReady, setFavoritesReady] = useState(false);
  const [selectedRoom, setSelectedRoom] = useState<LiveRoom | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [webOpeningId, setWebOpeningId] = useState<string | null>(null);
  const [playerState, setPlayerState] = useState<PlayerState | null>(null);
  const [selectedPlayerId, setSelectedPlayerId] = useState<string | null>(null);
  const [playerLoading, setPlayerLoading] = useState(true);
  const [vupiloPending, setVupiloPending] = useState(false);
  const [backgroundFullSyncEnabled, setBackgroundFullSyncEnabled] = useState(true);
  const [backgroundSyncSaving, setBackgroundSyncSaving] = useState(false);
  const [danmakuFilter, setDanmakuFilter] = useState<DanmakuKindFilter>(defaultDanmakuKindFilter);
  const [danmakuFilterSaving, setDanmakuFilterSaving] = useState(false);
  const [fullSyncing, setFullSyncing] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [sortMode, setSortMode] = useState<RoomSortMode>("popularity");
  const [roomLayout, setRoomLayout] = useState<RoomLayout>("grid");
  const [toast, setToast] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visibleRoomCount, setVisibleRoomCount] = useState(roomPageSize);

  const refreshRooms = async (announce = false): Promise<void> => {
    setLoading(true);
    if (announce) setManualRefreshing(true);
    setError(null);

    try {
      const [directory, favoriteResult] = await Promise.allSettled([
        (async () => {
          const nextRooms = await window.livehub.getRooms("all", "featured");
          const nextAppInfo = await window.livehub.getAppInfo();
          setRooms(nextRooms);
          setAppInfo(nextAppInfo);
        })(),
        announce && favoritesReady ? refreshFavoriteRooms() : Promise.resolve(0),
      ]);
      if (directory.status === "rejected") setError("直播列表加载失败，请重试。");
      if (announce) {
        const failures = favoriteResult.status === "fulfilled" ? favoriteResult.value : -1;
        setToast(failures < 0 ? "收藏状态更新未能保存，请检查磁盘空间。"
          : failures > 0 ? `收藏已刷新，${failures} 个房间状态暂不可用，请稍后重试。`
            : directory.status === "rejected" ? "收藏状态已更新，热门房间刷新失败，请重试。" : "热门房间和收藏状态已更新。");
      }
    } catch {
      setError("直播列表加载失败，请重启应用试试。");
    } finally {
      setLoading(false);
      if (announce) setManualRefreshing(false);
    }
  };

  useEffect(() => {
    const unsubscribe = window.livehub.onRoomsUpdate((update) => {
      setRooms((currentRooms) => mergePlatformRooms(currentRooms, update));
      setAppInfo((current) => current ? { ...current, [update.platform]: update.status } : current);
      setSelectedRoom((current) => {
        if (!current || current.platform !== update.platform) {
          return current;
        }

        return update.rooms.find((room) => room.id === current.id) ?? current;
      });
      if (update.mode === "featured") {
        setLoading(false);
      }
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    void refreshRooms();
  }, []);

  useEffect(() => {
    let active = true;
    void window.livehub.getBackgroundFullSyncEnabled().then((enabled) => {
      if (active) {
        setBackgroundFullSyncEnabled(enabled);
      }
    }).catch(() => undefined);

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    void window.livehub.getDanmakuKindFilter().then((filter) => {
      if (active) {
        setDanmakuFilter(filter);
      }
    }).catch(() => undefined);

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => window.livehub.onOpenSettings(() => {
    setActiveView("settings");
    setSelectedPlatform("all");
    setSelectedCategory(null);
    setCategoryPickerOpen(false);
  }), []);

  useEffect(() => {
    const handleSearchShortcut = (event: KeyboardEvent): void => {
      const isMac = navigator.platform.startsWith("Mac");
      const primaryModifierOnly = isMac
        ? event.metaKey && !event.ctrlKey
        : event.ctrlKey && !event.metaKey;
      if (!primaryModifierOnly || event.altKey || event.shiftKey) {
        return;
      }
      if (event.key.toLowerCase() !== "f" && event.key.toLowerCase() !== "k") {
        return;
      }
      event.preventDefault();
      setSelectedRoom(null);
      setActiveView("rooms");
      searchInputRef.current?.focus();
    };

    window.addEventListener("keydown", handleSearchShortcut);
    return () => window.removeEventListener("keydown", handleSearchShortcut);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const state = await window.livehub.getPlayerState();
        setPlayerState(state);
        setSelectedPlayerId(state.defaultPlayerId);
      } catch {
        setToast("播放器扫描失败，请在设置中重新扫描。");
      } finally {
        setPlayerLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    let active = true;
    const unsubscribe = window.livehub.onUpdateStatus((status) => {
      setUpdateStatus(status);
      if (status.state === "available" && status.version) {
        setToast(`发现新版本 ${status.version}，正在后台下载。`);
      }
      if (status.state === "downloaded" && status.version) {
        setToast(`新版本 ${status.version} 已下载完成，可以重启更新。`);
      }
    });

    void window.livehub.getUpdateStatus().then((status) => {
      if (active) {
        setUpdateStatus(status);
      }
    }).catch(() => undefined);

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let active = true;
    if (favoriteLoad.failed) {
      setToast("收藏数据读取失败，原始记录已保留，请勿清除应用数据。");
      return;
    }
    void (async () => {
      try {
        const result = await window.livehub.migrateFavorites(favoriteLoad.collection.ids);
        if (!active) return;
        if (JSON.stringify(result.ids) !== JSON.stringify(favoriteLoad.collection.ids)
          && localStorage.getItem(favoritesBackupKey) === null) {
          localStorage.setItem(favoritesBackupKey, JSON.stringify(favoriteLoad.collection.ids));
        }
        // Persist before enabling edits so a close during migration cannot undo recovery.
        const collection = updateFavoriteCollection({ ...favoriteLoad.collection, ids: result.ids }, []);
        localStorage.setItem(favoriteCollectionKey, JSON.stringify(collection));
        favoriteCollectionRef.current = collection;
        setFavoriteCollection(collection);
        setFavoritesReady(true);
        if (result.unresolvedCount > 0) {
          setToast(`有 ${result.unresolvedCount} 条旧收藏暂未恢复，记录已保留，下次启动会重试。`);
        } else if (result.migratedCount > 0) {
          setToast(`已恢复抖音收藏，合并 ${result.mergedCount} 条重复记录。`);
        }
      } catch {
        if (active) setToast("收藏恢复失败，原始记录已保留，请重新启动应用重试。");
      }
    })();
    return () => { active = false; };
  }, [favoriteLoad]);

  const saveFavoriteCollection = (value: FavoriteCollection): void => {
    const collection = expireFavoriteStatuses(value);
    if (JSON.stringify(collection) === JSON.stringify(favoriteCollectionRef.current)) return;
    // IDs and room snapshots commit together, including when storage is full.
    localStorage.setItem(favoriteCollectionKey, JSON.stringify(collection));
    favoriteCollectionRef.current = collection;
    setFavoriteCollection(collection);
  };

  const refreshFavoriteRooms = useMemo(() => createFavoriteRefresher({
    read: () => favoriteCollectionRef.current,
    save: saveFavoriteCollection,
    request: (ids) => window.livehub.refreshFavoriteRooms(ids),
  }), []);

  useEffect(() => {
    if (!favoritesReady) return;
    try {
      saveFavoriteCollection(updateFavoriteCollection(favoriteCollectionRef.current, [...rooms, ...search.pages.flatMap((page) => page.rooms)]));
    } catch { setToast("收藏资料更新未能保存，请检查磁盘空间。"); }
  }, [rooms, search.pages, favoritesReady]);

  const favoriteIdsKey = favorites.join("\n");
  useEffect(() => {
    if (!favoritesReady) return;
    let active = true;
    let timer: number | undefined;
    const refresh = async (): Promise<void> => {
      try { await refreshFavoriteRooms(); }
      catch { if (active) setToast("收藏资料更新未能保存，请检查磁盘空间。"); }
      if (active) timer = window.setTimeout(() => void refresh(), 5 * 60_000);
    };
    void refresh();
    const expiryTimer = window.setInterval(() => {
      try { saveFavoriteCollection(favoriteCollectionRef.current); }
      catch { setToast("收藏资料更新未能保存，请检查磁盘空间。"); }
    }, 30_000);
    return () => { active = false; window.clearTimeout(timer); window.clearInterval(expiryTimer); };
  }, [favoritesReady, favoriteIdsKey, refreshFavoriteRooms]);

  useEffect(() => {
    setSelectedRoom((current) => {
      if (!current) return null;
      return [...rooms, ...favoriteCollection.rooms, ...search.rooms].filter((room) => favoriteKey(room) === favoriteKey(current))
        .reduce((latest, room) => (room.checkedAt ?? 0) >= (latest.checkedAt ?? 0) ? room : latest, current);
    });
  }, [rooms, favoriteCollection.rooms, search.pages]);

  useEffect(() => {
    setVisibleRoomCount(roomPageSize);
  }, [activeView, query, selectedCategory, selectedPlatform]);

  useEffect(() => {
    if (!categoryPickerOpen) {
      setCategoryQuery("");
    }
  }, [categoryPickerOpen]);

  useEffect(() => {
    if (!toast) {
      return;
    }

    const timer = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!selectedRoom) {
      return;
    }

    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setSelectedRoom(null);
      }
    };

    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [selectedRoom]);

  const favoriteRooms = useMemo(() => getFavoriteRooms([], favorites, favoriteCollection.rooms), [favoriteCollection]);
  const liveFavoriteCount = useMemo(() => favoriteRooms.filter((room) => room.status === "live").length, [favoriteRooms]);
  const hasLiveFavorites = liveFavoriteCount > 0;

  const filteredRooms = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    const candidates = activeView === "favorites" ? favoriteRooms.filter((room) => matchesRoomQuery(room, normalizedQuery))
      : mergeSearchRooms(rooms, search.rooms, normalizedQuery);
    return candidates.filter((room) => {
      const matchesPlatform = selectedPlatform === "all" || selectedPlatform === room.platform;
      const matchesCategory = !selectedCategory || room.category === selectedCategory;
      return matchesPlatform && matchesCategory;
    });
  }, [activeView, favoriteRooms, query, rooms, selectedCategory, selectedPlatform, search.pages]);

  const categoryOptions = useMemo<CategoryOption[]>(() => {
    const optionMap = new Map<string, CategoryOption>();

    for (const room of rooms) {
      const name = room.category.trim() || "直播";
      const current = optionMap.get(name) ?? { name, count: 0, platforms: [] };
      if (selectedPlatform === "all" || selectedPlatform === room.platform) {
        current.count += 1;
      }
      if (!current.platforms.includes(room.platform)) {
        current.platforms.push(room.platform);
      }
      optionMap.set(name, current);
    }

    return Array.from(optionMap.values()).sort((left, right) => {
      if (left.count !== right.count) {
        return right.count - left.count;
      }
      return left.name.localeCompare(right.name, "zh-CN");
    });
  }, [rooms, selectedPlatform]);

  const visibleCategoryOptions = useMemo(() => {
    const normalizedQuery = categoryQuery.trim().toLowerCase();
    if (!normalizedQuery) {
      return categoryOptions;
    }

    return categoryOptions.filter((option) => option.name.toLowerCase().includes(normalizedQuery));
  }, [categoryOptions, categoryQuery]);

  const canSortByOnline = useMemo(() =>
    filteredRooms.length > 0 && filteredRooms.every(hasReportedOnlineMetric),
  [filteredRooms]);
  const effectiveSortMode: RoomSortMode = sortMode === "online" && canSortByOnline ? "online" : "popularity";
  const sortedRooms = useMemo(() => activeView === "rooms" && query.trim() ? filteredRooms : sortRoomsForDisplay(filteredRooms, effectiveSortMode), [filteredRooms, effectiveSortMode, activeView, query]);
  const visibleRooms = useMemo(() => sortedRooms.slice(0, visibleRoomCount), [sortedRooms, visibleRoomCount]);
  const favoriteLiveTotal = useMemo(
    () => activeView === "favorites" ? sortedRooms.filter((room) => room.status === "live").length : 0,
    [activeView, sortedRooms],
  );
  const favoriteNonLiveRooms = useMemo(
    () => activeView === "favorites" ? sortedRooms.filter((room) => room.status !== "live") : [],
    [activeView, sortedRooms],
  );
  const shouldGroupFavoritesByStatus = activeView === "favorites" && favoriteLiveTotal > 0 && favoriteNonLiveRooms.length > 0;
  const visibleLiveRooms = useMemo(
    () => shouldGroupFavoritesByStatus ? visibleRooms.filter((room) => room.status === "live") : [],
    [shouldGroupFavoritesByStatus, visibleRooms],
  );
  const visibleNonLiveRooms = useMemo(
    () => shouldGroupFavoritesByStatus ? visibleRooms.filter((room) => room.status !== "live") : [],
    [shouldGroupFavoritesByStatus, visibleRooms],
  );
  const listLoading = loading && activeView === "rooms" && !query.trim();
  const listError = activeView === "rooms" && !query.trim() ? error : null;

  const { totalViewers, audienceMetricCount, liveCount } = useMemo(() => {
    let totalViewers = 0;
    let liveCount = 0;
    const audienceMetrics = new Set<string>();
    for (const room of rooms) {
      totalViewers += room.viewers;
      if (room.status === "live") liveCount += 1;
      audienceMetrics.add(room.audienceMetric ?? "online");
    }
    return { totalViewers, audienceMetricCount: audienceMetrics.size, liveCount };
  }, [rooms]);
  const totalAudienceLabel = audienceMetricCount > 1 ? "平台指标合计" : "总观看人数";
  const totalAudienceHint = audienceMetricCount > 1 ? "平台口径混合" : "实时估算";
  const integrationStatuses = appInfo?.platforms.map((platform) => appInfo[platform]) ?? [];
  const connectedPlatformCount = integrationStatuses.filter((status) => status.state === "connected").length;
  const syncingPlatformCount = integrationStatuses.filter((status) => status.phase === "syncing").length;
  const isFullSyncRunning = fullSyncing || syncingPlatformCount > 0;
  const blockedDanmakuKinds = danmakuKinds.filter((kind) => !danmakuFilter[kind]);
  const danmakuFilterSummary = blockedDanmakuKinds.length === 0
    ? "播放器会收到全部弹幕，包含进场、点赞和礼物提示。"
    : `已屏蔽 ${blockedDanmakuKinds.map((kind) => danmakuKindLabels[kind]).join("、")}，播放器只收到勾选的类型。`;
  const hasPlatformIssue = integrationStatuses.some((status) => status.state === "error" || status.partial || status.complete === false);
  const allPlatformsConnected = integrationStatuses.length === Object.keys(platformMeta).length
    && integrationStatuses.every((status) => status.state === "connected" && !status.partial && status.complete !== false && status.phase !== "error");
  const platformSummary = appInfo
    ? appInfo.platforms.map((platform) => `${platformMeta[platform].label} ${appInfo[platform].roomCount ?? 0}`).join(" · ")
    : "正在连接四个平台…";
  const syncSummary = syncingPlatformCount > 0
    ? `${syncingPlatformCount} 个平台后台同步中`
    : allPlatformsConnected
      ? "四个平台实时数据"
      : `${connectedPlatformCount}/4 个平台已连接 · 部分目录未完整`;
  const platformScopedRoomCount = rooms.filter((room) =>
    selectedPlatform === "all" || selectedPlatform === room.platform,
  ).length;
  const selectedPlayer = playerState?.players.find((player) => player.id === selectedPlayerId)
    ?? playerState?.players.find((player) => player.id === playerState.defaultPlayerId);
  const vupiloInstalled = playerState?.players.some((player) => player.id === vupiloPlayerId) ?? false;
  const vupiloIsDefault = vupiloInstalled && selectedPlayer?.id === vupiloPlayerId;
  const vupiloButtonLabel = vupiloPending
    ? "处理中…"
    : !vupiloInstalled
      ? "下载 Vupilo 播放器"
      : vupiloIsDefault
        ? "Vupilo 已是默认播放器"
        : "切换到 Vupilo 播放器";
  const vupiloButtonHint = vupiloInstalled
    ? "直播弹幕直接叠在播放画面上"
    : "支持直播弹幕叠加，直连流播放";
  const updateButtonLabel = updateStatus?.state === "downloaded"
    ? "重启更新"
    : updateStatus?.state === "checking"
      ? "检查中…"
      : updateStatus?.state === "downloading"
        ? `下载中 ${updateStatus.percent ?? 0}%`
        : "检查更新";
  const updateDescription = updateStatus?.state === "downloaded" && updateStatus.version
    ? `新版本 ${updateStatus.version} 已准备好，重启应用即可完成更新。`
    : updateStatus?.state === "downloading"
      ? `正在后台下载 ${updateStatus.version ?? "新版本"}，不会打断当前播放。`
      : updateStatus?.state === "available"
        ? `发现新版本 ${updateStatus.version ?? ""}，正在准备下载。`
        : updateStatus?.state === "error"
          ? "暂时无法检查更新，请确认网络后重试。"
          : "启动后会自动检查 GitHub Release，有新版本时后台下载。";

  const toggleFavorite = (room: LiveRoom): void => {
    if (!favoritesReady) return;
    try {
      saveFavoriteCollection(toggleFavoriteCollection(favoriteCollectionRef.current, room));
    } catch {
      setToast("收藏保存失败，请检查磁盘空间后重试。");
    }
  };

  const selectPlatform = (platform: PlatformFilter): void => {
    if (selectedCategory && platform !== "all") {
      const categoryStillAvailable = rooms.some((room) =>
        room.category === selectedCategory && room.platform === platform,
      );
      if (!categoryStillAvailable) {
        setSelectedCategory(null);
        setToast(`已清除分类“${selectedCategory}”：这个平台暂无这个分类。`);
      }
    }

    setSelectedPlatform(platform);
  };

  const handlePlayerChange = async (playerId: string): Promise<void> => {
    if (!playerId) {
      return;
    }

    const previousPlayerId = playerState?.defaultPlayerId ?? null;
    setSelectedPlayerId(playerId);

    try {
      const nextState = await window.livehub.setDefaultPlayer(playerId);
      setPlayerState(nextState);
      setSelectedPlayerId(nextState.defaultPlayerId);
      const playerName = nextState.players.find((player) => player.id === nextState.defaultPlayerId)?.name ?? "播放器";
      setToast(`${playerName} 已设为默认播放器。`);
    } catch {
      setSelectedPlayerId(previousPlayerId);
      setToast("默认播放器设置失败，请重新扫描后再试。");
    }
  };

  const handleRefreshPlayers = async (): Promise<void> => {
    setPlayerLoading(true);

    try {
      const nextState = await window.livehub.refreshPlayers();
      setPlayerState(nextState);
      setSelectedPlayerId(nextState.defaultPlayerId);
      const mediaPlayerCount = nextState.players.filter((player) => player.kind === "media").length;
      setToast(mediaPlayerCount > 0
        ? `已扫描到 ${mediaPlayerCount} 个本机媒体播放器。`
        : "没有扫描到可用的本机媒体播放器。");
    } catch {
      setToast("播放器扫描失败，请稍后重试。");
    } finally {
      setPlayerLoading(false);
    }
  };

  // The scanned player list is cached for the whole session, so a Vupilo that was
  // installed after launch would still look missing. Rescan on click and decide
  // from that fresh result instead of the cached state.
  const handleVupiloAction = async (): Promise<void> => {
    if (vupiloPending) {
      return;
    }

    setVupiloPending(true);

    try {
      const scannedState = await window.livehub.refreshPlayers();
      setPlayerState(scannedState);
      setSelectedPlayerId((current) =>
        scannedState.players.some((player) => player.id === current)
          ? current
          : scannedState.defaultPlayerId);

      if (!scannedState.players.some((player) => player.id === vupiloPlayerId)) {
        const result = await window.livehub.openVupiloSite();
        setToast(result.message);
        return;
      }

      const nextState = await window.livehub.setDefaultPlayer(vupiloPlayerId);
      setPlayerState(nextState);
      setSelectedPlayerId(nextState.defaultPlayerId);
      setToast("Vupilo 已设为默认播放器。");
    } catch {
      setToast("Vupilo 暂时不可用，请稍后重试。");
    } finally {
      setVupiloPending(false);
    }
  };

  const handleBackgroundFullSyncToggle = async (): Promise<void> => {
    if (backgroundSyncSaving) {
      return;
    }

    const previousValue = backgroundFullSyncEnabled;
    const nextValue = !previousValue;
    setBackgroundFullSyncEnabled(nextValue);
    setBackgroundSyncSaving(true);

    try {
      const savedValue = await window.livehub.setBackgroundFullSyncEnabled(nextValue);
      setBackgroundFullSyncEnabled(savedValue);
      setToast(savedValue ? "后台全量同步已开启。" : "后台全量同步已暂停。热门房间仍会继续刷新。");
    } catch {
      setBackgroundFullSyncEnabled(previousValue);
      setToast("后台全量同步设置失败，请稍后重试。");
    } finally {
      setBackgroundSyncSaving(false);
    }
  };

  const handleDanmakuKindToggle = async (kind: DanmakuKind): Promise<void> => {
    if (danmakuFilterSaving) {
      return;
    }

    const previousFilter = danmakuFilter;
    const nextFilter = { ...previousFilter, [kind]: !previousFilter[kind] };
    setDanmakuFilter(nextFilter);
    setDanmakuFilterSaving(true);

    try {
      const savedFilter = await window.livehub.setDanmakuKindFilter(nextFilter);
      setDanmakuFilter(savedFilter);
      setToast(savedFilter[kind]
        ? `${danmakuKindLabels[kind]}弹幕已显示，播放中的直播间立即生效。`
        : `${danmakuKindLabels[kind]}弹幕已屏蔽，播放中的直播间立即生效。`);
    } catch {
      setDanmakuFilter(previousFilter);
      setToast("弹幕过滤设置失败，请稍后重试。");
    } finally {
      setDanmakuFilterSaving(false);
    }
  };

  const handleFullSync = async (): Promise<void> => {
    if (isFullSyncRunning) {
      return;
    }

    setFullSyncing(true);
    setToast("已开始全量同步，四个平台数据将在后台陆续更新…");

    try {
      const nextRooms = await window.livehub.getRooms("all", "full");
      const nextAppInfo = await window.livehub.getAppInfo();
      setRooms(nextRooms);
      setAppInfo(nextAppInfo);
      setSelectedRoom((current) => (current ? nextRooms.find((room) => room.id === current.id) ?? null : null));
      setToast(fullSyncToast(nextAppInfo, nextRooms.length));
    } catch {
      setToast("全量同步失败，请稍后重试。");
    } finally {
      setFullSyncing(false);
    }
  };

  const handleCheckForUpdates = async (): Promise<void> => {
    try {
      const status = await window.livehub.checkForUpdates();
      setUpdateStatus(status);
      if (status.state === "not-available") {
        setToast("当前已经是最新版本。");
      } else if (status.state === "error") {
        setToast("更新检查失败，请稍后重试。");
      }
    } catch {
      setToast("更新检查失败，请稍后重试。");
    }
  };

  const handleInstallUpdate = async (): Promise<void> => {
    try {
      await window.livehub.installUpdate();
    } catch {
      setToast("更新安装失败，请重新启动应用。");
    }
  };

  const handlePlay = async (room: LiveRoom): Promise<void> => {
    setPlayingId(room.id);

    try {
      const result = await window.livehub.requestPlay(room, selectedPlayerId ?? undefined);
      setToast(result.message);
    } catch {
      setToast("播放器启动失败，请检查播放器是否仍已安装。");
    } finally {
      setPlayingId(null);
    }
  };

  const handleOpenWeb = async (room: LiveRoom): Promise<void> => {
    setWebOpeningId(room.id);

    try {
      const result = await window.livehub.openWebRoom(room);
      setToast(result.message);
    } catch {
      setToast("网页打开失败，请检查系统浏览器是否可用。");
    } finally {
      setWebOpeningId(null);
    }
  };

  const selectView = (view: ViewId): void => {
    setActiveView(view);
    if (view !== "rooms") {
      setSelectedPlatform("all");
      setSelectedCategory(null);
    }
  };

  const renderRoomCard = (room: LiveRoom) => {
    const meta = platformMeta[room.platform];
    const isFavorite = isFavoriteRoom(room, favorites);
    const isLive = room.status === "live";

    return (
      <article
        className={`room-card ${isLive ? "room-live" : "room-not-live"} ${selectedRoom?.id === room.id ? "selected" : ""}`}
        key={room.id}
        onClick={() => setSelectedRoom(room)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            setSelectedRoom(room);
          }
        }}
        tabIndex={0}
      >
        <div className="room-cover">
          <div className="room-cover-media" style={{ background: room.cover }} aria-hidden="true" />
          <div className="cover-topline">
            <div className="cover-ident">
              <span className={`live-pill ${roomStatusClass(room)}`}><span />{roomStatusLabel(room)}</span>
            </div>
            <button
              className={`favorite-button ${isFavorite ? "favorite" : ""}`}
              disabled={!favoritesReady}
              title={!favoritesReady ? "正在恢复收藏…" : undefined}
              onClick={(event) => {
                event.stopPropagation();
                toggleFavorite(room);
              }}
              aria-label={isFavorite ? "取消收藏" : "收藏直播间"}
            >
              {isFavorite ? "★" : "☆"}
            </button>
          </div>
          <div className="cover-bottomline">
            <span className="cover-metric">{isLive ? `● ${displayViewers(room)} ${audienceValueLabel(room)}` : ""}</span>
            <span className="cover-category">{room.category}</span>
          </div>
        </div>
        <div className="room-card-body">
          <div className="room-title-row">
            <h3>{room.title}</h3>
            <span className="room-more">···</span>
          </div>
          <div className="room-anchor">
            <span className="anchor-avatar" style={{ background: meta.accent }}>{room.anchor.slice(0, 1)}</span>
            <span className="anchor-name">{room.anchor}</span>
            <span className="platform-name">{meta.label}</span>
          </div>
          <div className="tag-row">
            {room.tags.map((tag) => <span key={tag}>#{tag}</span>)}
            <span className="updated-at">{room.updatedAt}</span>
          </div>
        </div>
      </article>
    );
  };

  return (
    <div className={`app-shell ${isMacOS ? "mac-app-shell" : ""}`}>
      <aside className="sidebar">
          <div className="brand">
            <div className="brand-mark">LH</div>
            <div>
              <strong>LiveHub</strong>
              <span>跨平台直播</span>
            </div>
          </div>

        <div className="sidebar-section-label">工作台</div>
        <nav className="main-nav" aria-label="主导航">
          <button
            className={`nav-item ${activeView === "rooms" ? "active" : ""}`}
            onClick={() => selectView("rooms")}
          >
            <span className="nav-icon">◈</span>
            <span>直播大厅</span>
            <span className="nav-count">{rooms.length}</span>
          </button>
          <button
            className={`nav-item ${activeView === "favorites" ? "active" : ""}`}
            onClick={() => selectView("favorites")}
          >
            <span className="nav-icon">☆</span>
            <span>我的收藏</span>
            {hasLiveFavorites && (
              <span
                className="nav-live-dot"
                role="img"
                aria-label="收藏中有房间正在直播"
                title="收藏中有房间正在直播"
              />
            )}
            {liveFavoriteCount > 0 && <span className="nav-count">{liveFavoriteCount}</span>}
          </button>
          <button
            className={`nav-item ${activeView === "settings" ? "active" : ""}`}
            onClick={() => selectView("settings")}
          >
            <span className="nav-icon">⚙</span>
            <span>设置</span>
          </button>
        </nav>

        <div className="sidebar-section-label platform-label">平台</div>
        <div className="platform-list">
          {(Object.keys(platformMeta) as PlatformId[]).map((platform) => {
            const meta = platformMeta[platform];
            const count = rooms.filter((room) => room.platform === platform).length;

            return (
              <button
                className={`platform-item ${selectedPlatform === platform ? "selected" : ""}`}
                key={platform}
                aria-pressed={selectedPlatform === platform}
                onClick={() => {
                  setActiveView("rooms");
                  selectPlatform(platform);
                }}
              >
                <span className="platform-mini" style={{ background: meta.accent }}>
                  {meta.short}
                </span>
                <span>{meta.label}</span>
                <span className="platform-count">{count}</span>
              </button>
            );
          })}
        </div>

        <div className="sidebar-footer">
          <div className="connection-card">
            <span className={`connection-pulse ${hasPlatformIssue ? "error" : ""}`} />
            <div>
              <strong>{allPlatformsConnected ? "四个平台已连接" : `${connectedPlatformCount}/4 个平台已连接`}</strong>
              <span>{platformSummary}</span>
            </div>
            <span className="connection-arrow">›</span>
          </div>
          <div className="version-label">LiveHub {appInfo?.version ?? "0.1.0"}</div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb">
            <span>工作台</span>
            <span className="breadcrumb-separator">/</span>
            <strong>{activeView === "favorites" ? "我的收藏" : activeView === "settings" ? "设置" : "直播大厅"}</strong>
          </div>
          <label className="search-box">
            <span className="search-icon">⌕</span>
            <input
              ref={searchInputRef}
              value={query}
              onChange={(event) => { setQuery(event.target.value); setSelectedCategory(null); }}
              maxLength={50}
              placeholder={activeView === "favorites" ? "搜索已收藏的主播" : "搜索主播，包含未开播"}
              aria-label="搜索直播间"
            />
            <span className="search-shortcut">⌘ K</span>
          </label>
        </header>

        {activeView === "settings" ? (
          <section className="settings-view">
            <div className="page-heading">
              <div>
                <span className="eyebrow">PREFERENCES</span>
                <h1>设置</h1>
                <p>播放器、平台解析器和桌面行为会集中在这里。</p>
              </div>
            </div>
            <div className="settings-card">
              <div className="setting-row">
                <div>
                  <strong>默认播放器</strong>
                  <span>点击直播时优先使用这个播放器，选择后会自动保存。</span>
                </div>
                <select
                  className="settings-select"
                  value={selectedPlayerId ?? ""}
                  onChange={(event) => void handlePlayerChange(event.target.value)}
                  disabled={playerLoading || !playerState || playerState.players.length === 0}
                  aria-label="默认播放器"
                >
                  {playerLoading && <option value="">扫描播放器中…</option>}
                  {!playerLoading && playerState?.players.length === 0 && <option value="">未检测到播放器</option>}
                  {!playerLoading && playerState?.players.map((player) => (
                    <option key={player.id} value={player.id}>{player.name}</option>
                  ))}
                </select>
              </div>
              {isMacOS && (
                <div className="setting-row">
                  <div>
                    <strong>Vupilo 播放器</strong>
                    <span>
                      {vupiloInstalled
                        ? "已安装，设为默认后直播会带弹幕叠加在画面上。"
                        : "还没有安装，前往官网下载后即可直接播放直连流并叠加弹幕。"}
                    </span>
                  </div>
                  <button
                    className="secondary-button vupilo-secondary-button"
                    onClick={() => void handleVupiloAction()}
                    disabled={vupiloPending}
                  >
                    <span className="vupilo-mark">V</span>
                    {vupiloPending ? "处理中…" : vupiloInstalled ? "设为默认" : "前往官网"}
                  </button>
                </div>
              )}
              <div className="setting-row">
                <div>
                  <strong>本机播放器</strong>
                  <span>
                    {playerState
                      ? playerState.players.length > 0
                        ? `已发现 ${playerState.players.filter((player) => player.kind === "media").length} 个媒体播放器。`
                        : "没有检测到可用的本机媒体播放器。"
                      : "正在扫描本机已安装的播放器…"}
                  </span>
                </div>
                <button className="secondary-button" onClick={() => void handleRefreshPlayers()} disabled={playerLoading}>
                  {playerLoading ? "扫描中…" : "重新扫描"}
                </button>
              </div>
              <div className="setting-row">
                <div>
                  <strong>应用更新</strong>
                  <span>{updateDescription}</span>
                </div>
                {updateStatus?.state === "downloaded" && <span className="setting-status">已下载</span>}
                {updateStatus?.state === "error" && <span className="setting-status pending">待重试</span>}
                <button
                  className="secondary-button"
                  onClick={() => updateStatus?.state === "downloaded"
                    ? void handleInstallUpdate()
                    : void handleCheckForUpdates()}
                  disabled={updateStatus?.state === "checking"
                    || updateStatus?.state === "available"
                    || updateStatus?.state === "downloading"}
                >
                  {updateButtonLabel}
                </button>
              </div>
              <div className="setting-row">
                <div>
                  <strong>平台解析器</strong>
                  {appInfo ? appInfo.platforms.map((platform) => (
                    <span key={platform}>{platformMeta[platform].label}：{appInfo[platform].message}</span>
                  )) : <span>正在连接平台…</span>}
                </div>
                <span className="setting-status">已接入列表</span>
              </div>
              <div className="setting-row">
                <div>
                  <strong>后台全量同步</strong>
                  <span>{backgroundFullSyncEnabled
                    ? "热门房间先显示，启动后扩大收录范围，并每小时自动刷新；覆盖范围见平台状态。"
                    : "已暂停后台目录同步；热门房间仍会继续刷新。"}</span>
                </div>
                <span className={`setting-status ${backgroundFullSyncEnabled ? "" : "pending"}`}>
                  {backgroundFullSyncEnabled ? "运行中" : "已暂停"}
                </span>
                <button
                  className="secondary-button"
                  onClick={() => void handleFullSync()}
                  disabled={loading || isFullSyncRunning}
                >
                  {isFullSyncRunning ? "同步中…" : "立即同步"}
                </button>
                <button
                  className={`switch ${backgroundFullSyncEnabled ? "active" : ""}`}
                  onClick={() => void handleBackgroundFullSyncToggle()}
                  disabled={backgroundSyncSaving}
                  aria-label="后台全量同步状态"
                  aria-pressed={backgroundFullSyncEnabled}
                >
                  <span />
                </button>
              </div>
              <div className="setting-row">
                <div>
                  <strong>弹幕过滤</strong>
                  <span>{danmakuFilterSummary}</span>
                </div>
                <div className="filter-chips danmaku-kind-chips">
                  {danmakuKinds.map((kind) => (
                    <button
                      key={kind}
                      className={`filter-chip ${danmakuFilter[kind] ? "active" : ""}`}
                      onClick={() => void handleDanmakuKindToggle(kind)}
                      disabled={danmakuFilterSaving}
                      aria-pressed={danmakuFilter[kind]}
                    >
                      {danmakuKindLabels[kind]}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </section>
        ) : (
          <>
            <section className="stats-row" aria-label="直播统计">
              <div className="stat-card">
                <span className="stat-marker purple" aria-hidden="true" />
                <div>
                  <span>正在直播</span>
                  <strong>{liveCount}</strong>
                </div>
                <small>个房间</small>
              </div>
              <div className="stat-card">
                <span className="stat-marker orange" aria-hidden="true" />
                <div>
                  <span>{totalAudienceLabel}</span>
                  <strong>{formatViewers(totalViewers)}</strong>
                </div>
                <small>{totalAudienceHint}</small>
              </div>
              <div className="stat-card">
                <span className="stat-marker blue" aria-hidden="true" />
                <div>
                  <span>已连接平台</span>
                  <strong>{connectedPlatformCount}</strong>
                </div>
                <small>{connectedPlatformCount === 4 ? "全部实时" : "连接中"}</small>
              </div>
            </section>

            <section className="room-section">
              <div className="section-heading">
                <div>
                  <span className="eyebrow">{activeView === "favorites" ? "收藏的主播 · 下播也保留" : query.trim() ? "主播搜索 · 包含未开播" : "正在直播 · 精选内容"}</span>
                  <h2>{activeView === "favorites" ? "我的收藏" : "直播大厅"}<span>{filteredRooms.length}</span></h2>
                </div>
                <div className="section-heading-actions">
                  <span className="sync-note"><span className="demo-dot" /> {syncSummary}</span>
                  <button className="refresh-button" onClick={() => void refreshRooms(true)} disabled={loading || manualRefreshing || isFullSyncRunning} title="重新请求热门房间和所有收藏的直播状态">
                    <span>↻</span> {manualRefreshing ? "刷新中…" : activeView === "favorites" ? "刷新收藏" : "刷新"}
                  </button>
                  <button
                    className="sync-full-button"
                    onClick={() => void handleFullSync()}
                    disabled={loading || isFullSyncRunning}
                    title="遍历各平台公开目录，覆盖范围和未完成项目见平台状态"
                  >
                    <span className={isFullSyncRunning ? "sync-spin" : ""}>⟳</span>
                    {isFullSyncRunning ? "全量同步中…" : "全量同步"}
                  </button>
                  <div className="view-toggle">
                    <button
                      className={`view-button ${roomLayout === "grid" ? "active" : ""}`}
                      onClick={() => setRoomLayout("grid")}
                      aria-label="卡片视图"
                      aria-pressed={roomLayout === "grid"}
                    >
                      ▦
                    </button>
                    <button
                      className={`view-button ${roomLayout === "list" ? "active" : ""}`}
                      onClick={() => setRoomLayout("list")}
                      aria-label="列表视图"
                      aria-pressed={roomLayout === "list"}
                    >
                      ☷
                    </button>
                  </div>
                </div>
              </div>

              <div className="filter-stack">
                <div className="filter-row">
                  <div className="filter-group">
                    <span className="filter-label">平台</span>
                    <div className="filter-chips">
                      {platformFilters.map((filter) => {
                        const isActive = selectedPlatform === filter.id;

                        return (
                          <button
                            className={`filter-chip ${isActive ? "active" : ""}`}
                            key={filter.id}
                            aria-pressed={isActive}
                            onClick={() => selectPlatform(filter.id)}
                          >
                            {filter.id !== "all" && <span className="chip-dot" style={{ background: platformMeta[filter.id].accent }} />}
                            {filter.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <button
                    className="sort-button"
                    disabled={!canSortByOnline}
                    onClick={() => setSortMode(effectiveSortMode === "online" ? "popularity" : "online")}
                    title={!canSortByOnline
                      ? "B 站、斗鱼和虎牙只提供平台人气，无法和在线人数比较。只筛选抖音时可以按在线人数排序"
                      : effectiveSortMode === "online"
                        ? "当前按平台报告的在线人数排序，点击切换综合热度"
                        : "当前按各平台内部排名归一化，点击切换在线人数"}
                  >
                    {effectiveSortMode === "online" ? "在线人数" : "综合热度"} <span>↕</span>
                  </button>
                </div>

                <div className="filter-row category-filter-row">
                  <div className="filter-group">
                    <span className="filter-label">分类</span>
                    <div className="category-picker">
                      <button
                        className={`category-trigger ${selectedCategory ? "active" : ""}`}
                        onClick={() => setCategoryPickerOpen((open) => !open)}
                        aria-expanded={categoryPickerOpen}
                        aria-haspopup="listbox"
                      >
                        <span>{selectedCategory ?? "全部分类"}</span>
                        <span className="category-trigger-arrow">⌄</span>
                      </button>
                      {categoryPickerOpen && (
                        <div className="category-menu" role="listbox" aria-label="直播分类">
                          <label className="category-search">
                            <span>⌕</span>
                            <input
                              autoFocus
                              value={categoryQuery}
                              onChange={(event) => setCategoryQuery(event.target.value)}
                              placeholder="搜索分类"
                              aria-label="搜索直播分类"
                            />
                          </label>
                          <button
                            className={`category-option ${!selectedCategory ? "selected" : ""}`}
                            onClick={() => {
                              setSelectedCategory(null);
                              setCategoryPickerOpen(false);
                            }}
                            role="option"
                            aria-selected={!selectedCategory}
                          >
                            <span>全部分类</span>
                            <small>{platformScopedRoomCount.toLocaleString("zh-CN")}</small>
                          </button>
                          <div className="category-option-list">
                            {visibleCategoryOptions.map((option) => {
                              const isSelected = selectedCategory === option.name;
                              const relevantPlatforms = selectedPlatform === "all"
                                ? option.platforms
                                : option.platforms.filter((platform) => selectedPlatform === platform);
                              const platformLabels = relevantPlatforms
                                .map((platform) => platformMeta[platform].short)
                                .join(" · ") || "当前平台无直播";

                              return (
                                <button
                                  className={`category-option ${isSelected ? "selected" : ""}`}
                                  key={option.name}
                                  onClick={() => {
                                    setSelectedCategory(option.name);
                                    setCategoryPickerOpen(false);
                                  }}
                                  disabled={option.count === 0 && !isSelected}
                                  role="option"
                                  aria-selected={isSelected}
                                >
                                  <span>
                                    <strong>{option.name}</strong>
                                    <small>{platformLabels}</small>
                                  </span>
                                  <small>{option.count.toLocaleString("zh-CN")}</small>
                                </button>
                              );
                            })}
                          </div>
                          {visibleCategoryOptions.length === 0 && (
                            <div className="category-empty">没有匹配的分类</div>
                          )}
                        </div>
                      )}
                    </div>
                    {selectedCategory && (
                      <button
                        className="clear-filter-button"
                        onClick={() => setSelectedCategory(null)}
                        aria-label="清除分类筛选"
                      >
                        清除分类 ×
                      </button>
                    )}
                  </div>
                  <span className="filter-summary">
                    {selectedPlatform === "all" ? "全部平台" : platformMeta[selectedPlatform].label}
                  <span> · </span>
                  {filteredRooms.length.toLocaleString("zh-CN")} 个结果
                </span>
              </div>
            </div>

            <div className="content-grid">
              {activeView === "rooms" && appInfo && (
                <div className="directory-coverage" role="status" aria-live="polite">
                  {appInfo.platforms.filter((platform) => {
                    const status = appInfo[platform];
                    return (selectedPlatform === "all" || selectedPlatform === platform)
                      && (status.partial || status.complete === false || status.state === "error");
                  }).map((platform) => (
                    <p key={platform}>{platformMeta[platform].label}：{appInfo[platform].message}</p>
                  ))}
                </div>
              )}
              {activeView === "rooms" && query.trim() && (
                <div className="search-status" role="status" aria-live="polite">
                  <span>{selectedPlatform === "douyin" ? "抖音仅搜索已同步的直播间。" : search.loading ? "正在搜索主播，包含未开播的直播间…" : "已查询平台主播，包含未开播的直播间。"}</span>
                  {selectedPlatform === "all" && <span>抖音仅匹配已同步房间。</span>}
                  {search.pages.filter((page) => page.error).map((page) => <span className="search-error" key={page.platform}>{platformMeta[page.platform].label}搜索暂不可用。</span>)}
                </div>
              )}
              <div className={`room-grid ${roomLayout === "list" ? "list-layout" : ""}`}>
                {listLoading && <div className="empty-state">正在加载直播列表…</div>}
                {!listLoading && listError && <div className="empty-state error-state">{listError}</div>}
                {!listLoading && !listError && filteredRooms.length === 0 && (
                  <div className="empty-state">
                    <span className="empty-icon">⌁</span>
                    <strong>{search.loading ? "正在搜索主播…" : activeView === "favorites" ? query.trim() ? "没有匹配的收藏" : "还没有收藏主播" : query.trim() ? "没有找到匹配的主播" : "这里还没有直播"}</strong>
                    <span>{activeView === "favorites" && !query.trim() ? "在直播大厅搜索主播，未开播也能收藏。" : "换个平台或搜索词试试看吧。"}</span>
                  </div>
                )}
                {!listLoading && !listError && (shouldGroupFavoritesByStatus ? (
                  <>
                    {visibleLiveRooms.length > 0 && (
                      <>
                        <div className="room-section-header live">
                          <span className="room-section-dot" aria-hidden="true" />
                          <span>正在直播</span>
                          <span className="room-section-count">{favoriteLiveTotal}</span>
                          <span className="room-section-rule" aria-hidden="true" />
                        </div>
                        {visibleLiveRooms.map(renderRoomCard)}
                      </>
                    )}
                    {visibleNonLiveRooms.length > 0 && (
                      <>
                        <div className="room-section-header offline">
                          <span className="room-section-dot" aria-hidden="true" />
                          <span>{nonLiveSectionLabel(favoriteNonLiveRooms)}</span>
                          <span className="room-section-count">{favoriteNonLiveRooms.length}</span>
                          <span className="room-section-rule" aria-hidden="true" />
                        </div>
                        {visibleNonLiveRooms.map(renderRoomCard)}
                      </>
                    )}
                  </>
                ) : visibleRooms.map(renderRoomCard))}
                  {!listLoading && !listError && visibleRooms.length < filteredRooms.length && (
                    <button
                      className="load-more-button"
                      onClick={() => setVisibleRoomCount((count) => count + roomPageSize)}
                    >
                      加载更多 · 还剩 {filteredRooms.length - visibleRooms.length} 个
                    </button>
                  )}
                  {activeView === "rooms" && query.trim() && search.hasMore && visibleRooms.length >= filteredRooms.length && (
                    <button className="load-more-button" disabled={search.loading} onClick={() => void search.loadMore()}>
                      {search.loading ? "搜索中…" : search.pages.some((page) => page.error) ? "继续搜索 / 重试失败的平台" : "搜索更多主播"}
                    </button>
                  )}
                </div>

                {selectedRoom && (
                  <>
                    <button
                      className="room-detail-backdrop"
                      onClick={() => setSelectedRoom(null)}
                      aria-label="关闭直播间详情"
                    />
                    <aside
                      className="room-detail-panel"
                      role="dialog"
                      aria-modal="true"
                      aria-label="直播间详情"
                      onClick={(event) => event.stopPropagation()}
                    >
                    <>
                      <div className="detail-header">
                        <div className="detail-label">{selectedRoom.status === "live" ? "LIVE ROOM" : "主播直播间"}</div>
                        <button
                          className="detail-close"
                          onClick={() => setSelectedRoom(null)}
                          aria-label="关闭直播间详情"
                        >
                          ×
                        </button>
                      </div>
                      <div className="detail-preview" style={{ background: selectedRoom.cover }}>
                        <span className="preview-glow" />
                        <span className="preview-platform">{platformMeta[selectedRoom.platform].short}</span>
                        <span className="preview-play">{selectedRoom.status === "live" ? "▶" : "☾"}</span>
                        <span className={`preview-status ${roomStatusClass(selectedRoom)}`}><span />{roomStatusLabel(selectedRoom)}</span>
                      </div>
                      <div className="detail-content">
                        <div className="detail-title-row">
                          <div>
                            <span className="detail-platform">{platformMeta[selectedRoom.platform].label}</span>
                            <h3>{selectedRoom.title}</h3>
                          </div>
                          <button
                            className={`detail-star ${isFavoriteRoom(selectedRoom, favorites) ? "favorite" : ""}`}
                            disabled={!favoritesReady}
                            title={!favoritesReady ? "正在恢复收藏…" : undefined}
                            onClick={() => toggleFavorite(selectedRoom)}
                            aria-label={isFavoriteRoom(selectedRoom, favorites) ? "取消收藏当前直播间" : "收藏当前直播间"}
                          >
                            {isFavoriteRoom(selectedRoom, favorites) ? "★" : "☆"}
                          </button>
                        </div>
                        <div className="detail-anchor"><span className="anchor-avatar large">{selectedRoom.anchor.slice(0, 1)}</span><span className="anchor-name">{selectedRoom.anchor}</span></div>
                        <div className="detail-stats">
                          <div><span>{selectedRoom.status === "live" ? audienceStatLabel(selectedRoom) : "开播状态"}</span><strong>{selectedRoom.status === "live" ? displayViewers(selectedRoom) : roomStatusLabel(selectedRoom)}</strong></div>
                          <div><span>分类</span><strong>{selectedRoom.category}</strong></div>
                        </div>
                        <div className="detail-action-stack">
                          <div className="player-control-row">
                            <label className="player-select">
                              <span>播放器</span>
                              <select
                                value={selectedPlayerId ?? ""}
                                onChange={(event) => void handlePlayerChange(event.target.value)}
                                disabled={playerLoading || !playerState || playerState.players.length === 0}
                                aria-label="选择播放器"
                              >
                                {playerLoading && <option value="">扫描播放器中…</option>}
                                {!playerLoading && playerState?.players.length === 0 && <option value="">未检测到播放器</option>}
                                {!playerLoading && playerState?.players.map((player) => (
                                  <option key={player.id} value={player.id}>{player.name}</option>
                                ))}
                              </select>
                            </label>
                            <button className="play-button" onClick={() => void handlePlay(selectedRoom)} disabled={selectedRoom.status === "offline" || playingId === selectedRoom.id || playerLoading || !selectedPlayer}>
                              <span>{playingId === selectedRoom.id ? "…" : "▶"}</span>
                              {selectedRoom.status === "offline" ? "主播未开播" : playingId === selectedRoom.id
                                ? "准备中"
                                : selectedPlayer
                                  ? "使用播放器"
                                  : "未检测到播放器"}
                            </button>
                          </div>
                          <button
                            className="web-button"
                            onClick={() => void handleOpenWeb(selectedRoom)}
                            disabled={webOpeningId === selectedRoom.id || !selectedRoom.webUrl && !selectedRoom.url}
                          >
                            <span>{webOpeningId === selectedRoom.id ? "…" : "↗"}</span>
                            {webOpeningId === selectedRoom.id ? "正在打开" : "使用网页打开直播间"}
                          </button>
                          {isMacOS && (
                            <button
                              className={`vupilo-button ${vupiloIsDefault ? "active" : ""}`}
                              onClick={() => void handleVupiloAction()}
                              disabled={vupiloPending}
                              aria-label={`${vupiloInstalled ? "把 Vupilo 设为默认播放器" : "前往 Vupilo 官网下载"}，${vupiloButtonHint}`}
                            >
                              <span className="vupilo-mark">V</span>
                              <span className="vupilo-button-text">
                                <strong>{vupiloButtonLabel}</strong>
                                <span>{vupiloButtonHint}</span>
                              </span>
                            </button>
                          )}
                        </div>
                        <p className="detail-hint">
                          {selectedRoom.status === "offline" ? "主播尚未开播，收藏后会保留；也可以打开直播间网页。" : selectedRoom.status === "unknown" ? "暂时无法确认开播状态，收藏记录会保留，可以尝试播放或打开网页。" : selectedRoom.demo
                            ? "这是演示房间。"
                            : selectedPlayer
                              ? "播放器按钮只会获取直连流并打开播放器；网页按钮需要单独点击。"
                              : "未检测到播放器；网页按钮仍可用，播放器按钮需要先扫描媒体播放器。"}
                        </p>
                      </div>
                    </>
                    </aside>
                  </>
                )}
              </div>
            </section>
          </>
        )}
      </main>

      {toast && <div className="toast"><span>✦</span>{toast}</div>}
    </div>
  );
}

export default App;
