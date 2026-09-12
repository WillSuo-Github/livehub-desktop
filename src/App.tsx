import { useEffect, useMemo, useState } from "react";
import type { AppInfo, LiveRoom, PlatformId } from "../shared/types";

type PlatformFilter = "all" | PlatformId;
type ViewId = "rooms" | "favorites" | "settings";

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
const roomPageSize = 120;

function App() {
  const [rooms, setRooms] = useState<LiveRoom[]>([]);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [activeView, setActiveView] = useState<ViewId>("rooms");
  const [activePlatform, setActivePlatform] = useState<PlatformFilter>("all");
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
  const [toast, setToast] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [visibleRoomCount, setVisibleRoomCount] = useState(roomPageSize);

  const refreshRooms = async (announce = false): Promise<void> => {
    setLoading(true);
    setError(null);

    try {
      const nextRooms = await window.livehub.getRooms("all");
      const nextAppInfo = await window.livehub.getAppInfo();
      setRooms(nextRooms);
      setAppInfo(nextAppInfo);
      setSelectedRoom((current) => nextRooms.find((room) => room.id === current?.id) ?? nextRooms[0] ?? null);
      if (announce) {
        setToast("已刷新抖音实时列表，其他平台仍为演示数据。");
      }
    } catch {
      setError("直播列表加载失败，请重启应用试试。");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refreshRooms();
  }, []);

  useEffect(() => {
    localStorage.setItem("livehub:favorites", JSON.stringify(favorites));
  }, [favorites]);

  useEffect(() => {
    setVisibleRoomCount(roomPageSize);
  }, [activePlatform, activeView, query]);

  useEffect(() => {
    if (!toast) {
      return;
    }

    const timer = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const filteredRooms = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return rooms.filter((room) => {
      const matchesView = activeView !== "favorites" || favorites.includes(room.id);
      const matchesPlatform = activePlatform === "all" || room.platform === activePlatform;
      const matchesQuery =
        !normalizedQuery ||
        [room.title, room.anchor, room.category, ...room.tags].some((value) =>
          value.toLowerCase().includes(normalizedQuery),
        );

      return matchesView && matchesPlatform && matchesQuery;
    });
  }, [activePlatform, activeView, favorites, query, rooms]);

  const visibleRooms = filteredRooms.slice(0, visibleRoomCount);

  const totalViewers = rooms.reduce((total, room) => total + room.viewers, 0);
  const liveCount = rooms.filter((room) => room.status === "live").length;
  const douyinConnected = appInfo?.douyin.state === "connected";
  const douyinError = appInfo?.douyin.state === "error";
  const douyinPartial = appInfo?.douyin.partial === true;

  const toggleFavorite = (roomId: string): void => {
    setFavorites((current) =>
      current.includes(roomId)
        ? current.filter((favoriteId) => favoriteId !== roomId)
        : [...current, roomId],
    );
  };

  const handlePlay = async (room: LiveRoom): Promise<void> => {
    setPlayingId(room.id);

    try {
      const result = await window.livehub.requestPlay(room);
      setToast(result.message);
    } finally {
      setPlayingId(null);
    }
  };

  const selectView = (view: ViewId): void => {
    setActiveView(view);
    if (view !== "rooms") {
      setActivePlatform("all");
    }
  };

  return (
    <div className="app-shell">
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
                className={`platform-item ${activePlatform === platform ? "selected" : ""}`}
                key={platform}
                onClick={() => {
                  setActiveView("rooms");
                  setActivePlatform(platform);
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
            <span className={`connection-pulse ${douyinError ? "error" : ""}`} />
            <div>
              <strong>{douyinConnected ? douyinPartial ? "抖音已连接 · 部分失败" : "抖音已连接" : douyinError ? "抖音连接失败" : "正在连接抖音"}</strong>
              <span>{appInfo?.douyin.message ?? "准备解析器…"}</span>
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
          <div className="topbar-actions">
            <button className="icon-button" title="通知" aria-label="通知">
              ♢
              <span className="notification-dot" />
            </button>
            <div className="avatar">W</div>
          </div>
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
                  <strong>播放器</strong>
                  <span>后续支持系统播放器、mpv 和内置播放器。</span>
                </div>
                <span className="setting-status">待配置</span>
              </div>
              <div className="setting-row">
                <div>
                  <strong>平台解析器</strong>
                  <span>抖音、斗鱼、虎牙、哔哩哔哩。</span>
                </div>
                <span className="setting-status pending">开发中</span>
              </div>
              <div className="setting-row">
                <div>
                  <strong>启动时刷新</strong>
                  <span>打开应用后自动更新关注的直播间。</span>
                </div>
                <button className="switch" aria-label="启动时刷新开关">
                  <span />
                </button>
              </div>
            </div>
          </section>
        ) : (
          <>
            <section className="hero-section">
              <div className="hero-copy">
                <span className="eyebrow">LIVE STREAM CONTROL CENTER</span>
                <h1>今天看点什么？</h1>
                <p>把分散在不同平台的直播，收进一个安静好用的桌面工作台。</p>
                <div className="hero-actions">
                  <button className="primary-button" onClick={() => void refreshRooms(true)} disabled={loading}>
                    <span>↻</span> 刷新列表
                  </button>
                  <span className="demo-note"><span className="demo-dot" /> {douyinConnected ? "抖音实时数据 · 其他平台为演示数据" : "当前为演示/待连接数据"}</span>
                </div>
              </div>
              <div className="hero-orbit" aria-hidden="true">
                <div className="orbit-ring orbit-ring-one" />
                <div className="orbit-ring orbit-ring-two" />
                <div className="orbit-core">LH</div>
                <span className="orbit-spark spark-one" />
                <span className="orbit-spark spark-two" />
                <span className="orbit-spark spark-three" />
              </div>
            </section>

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
                  <span>总观看人数</span>
                  <strong>{formatViewers(totalViewers)}</strong>
                </div>
                <small>实时估算</small>
              </div>
              <div className="stat-card">
                <span className="stat-icon blue">◌</span>
                <div>
                  <span>已连接平台</span>
                  <strong>{douyinConnected ? 1 : 0}</strong>
                </div>
                <small>{douyinConnected ? "抖音实时" : "连接中"}</small>
              </div>
            </section>

            <section className="room-section">
              <div className="section-heading">
                <div>
                  <span className="eyebrow">DISCOVER</span>
                  <h2>{activeView === "favorites" ? "我的收藏" : "直播大厅"}<span>{filteredRooms.length}</span></h2>
                </div>
                <div className="view-toggle">
                  <button className="view-button active" aria-label="卡片视图">▦</button>
                  <button className="view-button" aria-label="列表视图">☷</button>
                </div>
              </div>

              <div className="filter-row">
                <div className="filter-chips">
                  {platformFilters.map((filter) => (
                    <button
                      className={`filter-chip ${activePlatform === filter.id ? "active" : ""}`}
                      key={filter.id}
                      onClick={() => setActivePlatform(filter.id)}
                    >
                      {filter.id !== "all" && <span className="chip-dot" style={{ background: platformMeta[filter.id].accent }} />}
                      {filter.label}
                    </button>
                  ))}
                </div>
                <button className="sort-button">热度排序 <span>⌄</span></button>
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
                            <span>● {displayViewers(room)} 人观看</span>
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

                <aside className="room-detail-panel">
                  {selectedRoom ? (
                    <>
                      <div className="detail-label">NOW PLAYING</div>
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
                          <div><span>观看人数</span><strong>{displayViewers(selectedRoom)}</strong></div>
                          <div><span>分类</span><strong>{selectedRoom.category}</strong></div>
                        </div>
                        <button className="play-button" onClick={() => handlePlay(selectedRoom)} disabled={playingId === selectedRoom.id}>
                          <span>{playingId === selectedRoom.id ? "…" : "▶"}</span>
                          {playingId === selectedRoom.id ? "准备中" : "打开播放器"}
                        </button>
                        <p className="detail-hint">{selectedRoom.demo ? "这是演示房间。真实平台接入后会在这里显示播放状态。" : "抖音实时房间已接入，播放器桥接将在下一步接上。"}</p>
                      </div>
                    </>
                  ) : (
                    <div className="detail-empty">选择一个直播间查看详情</div>
                  )}
                </aside>
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
