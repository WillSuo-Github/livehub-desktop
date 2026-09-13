import { useEffect, useMemo, useState } from "react";
import type { AppInfo, LiveRoom, PlatformId, PlatformRoomsUpdate, PlayerState, UpdateStatus } from "../shared/types";

type PlatformFilter = "all" | PlatformId;
type ViewId = "rooms" | "favorites" | "settings";
type RoomSortMode = "online" | "popularity";
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

    return platformTieBreakOrder.indexOf(left.platform) - platformTieBreakOrder.indexOf(right.platform);
  });
  const unavailableRooms = rooms.filter((room) => !hasReportedOnlineMetric(room));

  return [
    ...onlineRooms,
    ...sortRoomsByNormalizedPopularity(unavailableRooms),
  ];
}

function sortRoomsForDisplay(rooms: LiveRoom[], mode: RoomSortMode): LiveRoom[] {
  return mode === "online" ? sortRoomsByOnlineAudience(rooms) : sortRoomsByNormalizedPopularity(rooms);
}

const mergePlatformRooms = (currentRooms: LiveRoom[], update: PlatformRoomsUpdate): LiveRoom[] => sortRoomsByOnlineAudience([
  ...currentRooms.filter((room) => room.platform !== update.platform),
  ...update.rooms,
]);

function App() {
  const [rooms, setRooms] = useState<LiveRoom[]>([]);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [activeView, setActiveView] = useState<ViewId>("rooms");
  const [selectedPlatforms, setSelectedPlatforms] = useState<PlatformId[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [categoryQuery, setCategoryQuery] = useState("");
  const [categoryPickerOpen, setCategoryPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [favorites, setFavorites] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("livehub:favorites") ?? "[]") as string[];
    } catch {
      return [];
    }
  });
  const [selectedRoom, setSelectedRoom] = useState<LiveRoom | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [webOpeningId, setWebOpeningId] = useState<string | null>(null);
  const [playerState, setPlayerState] = useState<PlayerState | null>(null);
  const [selectedPlayerId, setSelectedPlayerId] = useState<string | null>(null);
  const [playerLoading, setPlayerLoading] = useState(true);
  const [backgroundFullSyncEnabled, setBackgroundFullSyncEnabled] = useState(true);
  const [backgroundSyncSaving, setBackgroundSyncSaving] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [sortMode, setSortMode] = useState<RoomSortMode>("online");
  const [toast, setToast] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [visibleRoomCount, setVisibleRoomCount] = useState(roomPageSize);

  const refreshRooms = async (announce = false): Promise<void> => {
    setLoading(true);
    setError(null);

    try {
      const nextRooms = await window.livehub.getRooms("all", "featured");
      const nextAppInfo = await window.livehub.getAppInfo();
      setRooms(sortRoomsByOnlineAudience(nextRooms));
      setAppInfo(nextAppInfo);
      setSelectedRoom((current) => current ? nextRooms.find((room) => room.id === current.id) ?? null : null);
      if (announce) {
        setToast("热门房间已更新，完整列表会在后台继续同步。");
      }
    } catch {
      setError("直播列表加载失败，请重启应用试试。");
    } finally {
      setLoading(false);
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

        return update.rooms.find((room) => room.id === current.id) ?? null;
      });
      if (update.mode === "featured") {
        setLoading(false);
      }
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    setSelectedRoom((current) => current && rooms.some((room) => room.id === current.id) ? current : null);
  }, [rooms]);

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

  useEffect(() => window.livehub.onOpenSettings(() => {
    setActiveView("settings");
    setSelectedPlatforms([]);
    setSelectedCategory(null);
    setCategoryPickerOpen(false);
  }), []);

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
    localStorage.setItem("livehub:favorites", JSON.stringify(favorites));
  }, [favorites]);

  useEffect(() => {
    setVisibleRoomCount(roomPageSize);
  }, [activeView, query, selectedCategory, selectedPlatforms]);

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

  const filteredRooms = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return rooms.filter((room) => {
      const matchesView = activeView !== "favorites" || favorites.includes(room.id);
      const matchesPlatform = selectedPlatforms.length === 0 || selectedPlatforms.includes(room.platform);
      const matchesCategory = !selectedCategory || room.category === selectedCategory;
      const matchesQuery =
        !normalizedQuery ||
        [room.title, room.anchor, room.category, ...room.tags].some((value) =>
          value.toLowerCase().includes(normalizedQuery),
        );

      return matchesView && matchesPlatform && matchesCategory && matchesQuery;
    });
  }, [activeView, favorites, query, rooms, selectedCategory, selectedPlatforms]);

  const categoryOptions = useMemo<CategoryOption[]>(() => {
    const optionMap = new Map<string, CategoryOption>();

    for (const room of rooms) {
      const name = room.category.trim() || "直播";
      const current = optionMap.get(name) ?? { name, count: 0, platforms: [] };
      if (selectedPlatforms.length === 0 || selectedPlatforms.includes(room.platform)) {
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
  }, [rooms, selectedPlatforms]);

  const visibleCategoryOptions = useMemo(() => {
    const normalizedQuery = categoryQuery.trim().toLowerCase();
    if (!normalizedQuery) {
      return categoryOptions;
    }

    return categoryOptions.filter((option) => option.name.toLowerCase().includes(normalizedQuery));
  }, [categoryOptions, categoryQuery]);

  const visibleRooms = sortRoomsForDisplay(filteredRooms, sortMode).slice(0, visibleRoomCount);

  const totalViewers = rooms.reduce((total, room) => total + room.viewers, 0);
  const audienceMetricCount = new Set(rooms.map((room) => room.audienceMetric ?? "online")).size;
  const totalAudienceLabel = audienceMetricCount > 1 ? "平台指标合计" : "总观看人数";
  const totalAudienceHint = audienceMetricCount > 1 ? "平台口径混合" : "实时估算";
  const liveCount = rooms.filter((room) => room.status === "live").length;
  const integrationStatuses = appInfo?.platforms.map((platform) => appInfo[platform]) ?? [];
  const connectedPlatformCount = integrationStatuses.filter((status) => status.state === "connected").length;
  const syncingPlatformCount = integrationStatuses.filter((status) => status.phase === "syncing").length;
  const hasPlatformIssue = integrationStatuses.some((status) => status.state === "error" || status.partial);
  const allPlatformsConnected = integrationStatuses.length === Object.keys(platformMeta).length
    && integrationStatuses.every((status) => status.state === "connected" && !status.partial && status.phase !== "error");
  const platformSummary = appInfo
    ? appInfo.platforms.map((platform) => `${platformMeta[platform].label} ${appInfo[platform].roomCount ?? 0}`).join(" · ")
    : "正在连接四个平台…";
  const syncSummary = syncingPlatformCount > 0
    ? `${syncingPlatformCount} 个平台后台同步中`
    : allPlatformsConnected
      ? "四个平台实时数据"
      : `${connectedPlatformCount}/4 个平台已连接 · 显示平台原始数据`;
  const platformScopedRoomCount = rooms.filter((room) =>
    selectedPlatforms.length === 0 || selectedPlatforms.includes(room.platform),
  ).length;
  const selectedPlayer = playerState?.players.find((player) => player.id === selectedPlayerId)
    ?? playerState?.players.find((player) => player.id === playerState.defaultPlayerId);
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

  const toggleFavorite = (roomId: string): void => {
    setFavorites((current) =>
      current.includes(roomId)
        ? current.filter((favoriteId) => favoriteId !== roomId)
        : [...current, roomId],
    );
  };

  const togglePlatform = (platform: PlatformId): void => {
    const next = selectedPlatforms.includes(platform)
      ? selectedPlatforms.filter((item) => item !== platform)
      : [...selectedPlatforms, platform];

    if (selectedCategory && next.length > 0) {
      const categoryStillAvailable = rooms.some((room) =>
        room.category === selectedCategory && next.includes(room.platform),
      );
      if (!categoryStillAvailable) {
        setSelectedCategory(null);
        setToast(`已清除分类“${selectedCategory}”：选中的平台暂无这个分类。`);
      }
    }

    setSelectedPlatforms(next);
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
      setSelectedPlatforms([]);
      setSelectedCategory(null);
    }
  };

  return (
    <div className={`app-shell ${isMacOS ? "mac-app-shell" : ""}`}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">LH</div>
          <div>
            <strong>LiveHub</strong>
            <span>STREAM DESK</span>
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
            {favorites.length > 0 && <span className="nav-count">{favorites.length}</span>}
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
                className={`platform-item ${selectedPlatforms.includes(platform) ? "selected" : ""}`}
                key={platform}
                aria-pressed={selectedPlatforms.includes(platform)}
                onClick={() => {
                  setActiveView("rooms");
                  togglePlatform(platform);
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
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索主播、房间或分类"
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
                  <span>抖音、斗鱼、虎牙、哔哩哔哩。</span>
                </div>
                <span className="setting-status">已接入列表</span>
              </div>
              <div className="setting-row">
                <div>
                  <strong>后台全量同步</strong>
                  <span>{backgroundFullSyncEnabled
                    ? "热门房间先显示，完整列表启动后同步，并每小时自动刷新。"
                    : "已暂停完整列表同步；热门房间仍会继续刷新。"}</span>
                </div>
                <span className={`setting-status ${backgroundFullSyncEnabled ? "" : "pending"}`}>
                  {backgroundFullSyncEnabled ? "运行中" : "已暂停"}
                </span>
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
            </div>
          </section>
        ) : (
          <>
            <section className="stats-row" aria-label="直播统计">
              <div className="stat-card">
                <span className="stat-icon purple">◈</span>
                <div>
                  <span>正在直播</span>
                  <strong>{liveCount}</strong>
                </div>
                <small>个房间</small>
              </div>
              <div className="stat-card">
                <span className="stat-icon orange">◉</span>
                <div>
                  <span>{totalAudienceLabel}</span>
                  <strong>{formatViewers(totalViewers)}</strong>
                </div>
                <small>{totalAudienceHint}</small>
              </div>
              <div className="stat-card">
                <span className="stat-icon blue">◌</span>
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
                  <span className="eyebrow">DISCOVER</span>
                  <h2>{activeView === "favorites" ? "我的收藏" : "直播大厅"}<span>{filteredRooms.length}</span></h2>
                </div>
                <div className="section-heading-actions">
                  <span className="sync-note"><span className="demo-dot" /> {syncSummary}</span>
                  <button className="refresh-button" onClick={() => void refreshRooms(true)} disabled={loading || syncingPlatformCount > 0}>
                    <span>↻</span> 刷新热门
                  </button>
                  <div className="view-toggle">
                    <button className="view-button active" aria-label="卡片视图">▦</button>
                    <button className="view-button" aria-label="列表视图">☷</button>
                  </div>
                </div>
              </div>

              <div className="filter-stack">
                <div className="filter-row">
                  <div className="filter-group">
                    <span className="filter-label">平台</span>
                    <div className="filter-chips">
                      {platformFilters.map((filter) => {
                        const isActive = filter.id === "all"
                          ? selectedPlatforms.length === 0
                          : selectedPlatforms.includes(filter.id);

                        return (
                          <button
                            className={`filter-chip ${isActive ? "active" : ""}`}
                            key={filter.id}
                            aria-pressed={isActive}
                            onClick={() => {
                              if (filter.id === "all") {
                                setSelectedPlatforms([]);
                                return;
                              }
                              togglePlatform(filter.id);
                            }}
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
                    onClick={() => setSortMode((current) => current === "online" ? "popularity" : "online")}
                    title={sortMode === "online"
                      ? "当前优先使用平台报告的在线人数；斗鱼和虎牙暂无可比并发人数，点击切换综合热度"
                      : "当前按各平台内部排名归一化，点击切换在线人数优先"}
                  >
                    {sortMode === "online" ? "在线人数优先" : "综合热度"} <span>↕</span>
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
                              const relevantPlatforms = selectedPlatforms.length === 0
                                ? option.platforms
                                : option.platforms.filter((platform) => selectedPlatforms.includes(platform));
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
                    {selectedPlatforms.length === 0 ? "全部平台" : `已选 ${selectedPlatforms.length} 个平台`}
                    <span> · </span>
                    {filteredRooms.length.toLocaleString("zh-CN")} 个结果
                  </span>
                </div>
              </div>

              <div className="content-grid">
                <div className="room-grid">
                  {loading && <div className="empty-state">正在加载直播列表…</div>}
                  {!loading && error && <div className="empty-state error-state">{error}</div>}
                  {!loading && !error && filteredRooms.length === 0 && (
                    <div className="empty-state">
                      <span className="empty-icon">⌁</span>
                      <strong>这里还没有直播</strong>
                      <span>换个平台或搜索词试试看吧。</span>
                    </div>
                  )}
                  {!loading && !error && visibleRooms.map((room) => {
                    const meta = platformMeta[room.platform];
                    const isFavorite = favorites.includes(room.id);

                    return (
                      <article
                        className={`room-card ${selectedRoom?.id === room.id ? "selected" : ""}`}
                        key={room.id}
                        onClick={() => setSelectedRoom(room)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            setSelectedRoom(room);
                          }
                        }}
                        tabIndex={0}
                      >
                        <div className="room-cover" style={{ background: room.cover }}>
                          <div className="cover-topline">
                            <span className="live-pill"><span />直播中</span>
                            <button
                              className={`favorite-button ${isFavorite ? "favorite" : ""}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                toggleFavorite(room.id);
                              }}
                              aria-label={isFavorite ? "取消收藏" : "收藏直播间"}
                            >
                              {isFavorite ? "★" : "☆"}
                            </button>
                          </div>
                          <span className="platform-stamp" style={{ color: meta.accent }}>
                            {meta.short}
                          </span>
                          <div className="cover-bottomline">
                            <span>● {displayViewers(room)} {audienceValueLabel(room)}</span>
                            <span>{room.category}</span>
                          </div>
                        </div>
                        <div className="room-card-body">
                          <div className="room-title-row">
                            <h3>{room.title}</h3>
                            <span className="room-more">···</span>
                          </div>
                          <div className="room-anchor">
                            <span className="anchor-avatar" style={{ background: meta.accent }}>{room.anchor.slice(0, 1)}</span>
                            <span>{room.anchor}</span>
                            <span className="platform-name">{meta.label}</span>
                          </div>
                          <div className="tag-row">
                            {room.tags.map((tag) => <span key={tag}>#{tag}</span>)}
                            <span className="updated-at">{room.updatedAt}</span>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                  {!loading && !error && visibleRooms.length < filteredRooms.length && (
                    <button
                      className="load-more-button"
                      onClick={() => setVisibleRoomCount((count) => count + roomPageSize)}
                    >
                      加载更多 · 还剩 {filteredRooms.length - visibleRooms.length} 个
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
                        <div className="detail-label">NOW PLAYING</div>
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
                        <span className="preview-play">▶</span>
                        <span className="preview-status"><span />LIVE</span>
                      </div>
                      <div className="detail-content">
                        <div className="detail-title-row">
                          <div>
                            <span className="detail-platform">{platformMeta[selectedRoom.platform].label}</span>
                            <h3>{selectedRoom.title}</h3>
                          </div>
                          <button
                            className={`detail-star ${favorites.includes(selectedRoom.id) ? "favorite" : ""}`}
                            onClick={() => toggleFavorite(selectedRoom.id)}
                            aria-label="收藏当前直播间"
                          >
                            {favorites.includes(selectedRoom.id) ? "★" : "☆"}
                          </button>
                        </div>
                        <div className="detail-anchor"><span className="anchor-avatar large">{selectedRoom.anchor.slice(0, 1)}</span><span>{selectedRoom.anchor}</span></div>
                        <div className="detail-stats">
                          <div><span>{audienceStatLabel(selectedRoom)}</span><strong>{displayViewers(selectedRoom)}</strong></div>
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
                            <button className="play-button" onClick={() => void handlePlay(selectedRoom)} disabled={playingId === selectedRoom.id || playerLoading || !selectedPlayer}>
                              <span>{playingId === selectedRoom.id ? "…" : "▶"}</span>
                              {playingId === selectedRoom.id
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
                        </div>
                        <p className="detail-hint">
                          {selectedRoom.demo
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
