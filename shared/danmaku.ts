import type { DanmakuEvent, DanmakuKind, DanmakuKindFilter } from "./types";

export const danmakuKinds: DanmakuKind[] = ["text", "gift", "like", "member", "system"];

export const danmakuKindLabels: Record<DanmakuKind, string> = {
  text: "聊天",
  gift: "礼物",
  like: "点赞",
  member: "进场与分享",
  system: "直播间提示",
};

export const defaultDanmakuKindFilter: DanmakuKindFilter = {
  text: true,
  gift: false,
  like: false,
  member: false,
  system: true,
};

// Some room notices arrive on the chat channel, so the kind alone cannot separate them
// from real conversation. Every pattern here needs platform-generated wording, because a
// viewer typing a similar sentence should still reach the player.
const nonChatTextPatterns: RegExp[] = [
  /^(?:恭喜)?.{0,40}(?:加入|升级为).{0,10}(?:粉丝团|粉丝群|团)/,
  /^恭喜.{0,40}成为第\s?[\d,]+\s?名.{0,30}(?:成员|粉丝)/,
  /(?:关注|订阅)了主播/,
  /(?:分享|转发)了(?:本|该)?直播间/,
  /(?:进入|来到|来了)(?:本|该)?直播间/,
  /(?:购买|开通|续费).{0,10}(?:贵族|守护|舰长|提督|总督|粉丝牌)/,
  /(?:升级|晋升)(?:到|为|至).{0,6}(?:\d+级|等级|荣耀等级)/,
  /(?:点亮|点燃)了.{0,10}(?:粉丝灯牌|灯牌)/,
];

export function isNonChatText(text: string): boolean {
  const candidate = text.trim();
  if (!candidate) {
    return true;
  }
  return nonChatTextPatterns.some((pattern) => pattern.test(candidate));
}

export function normalizeDanmakuKindFilter(value: unknown): DanmakuKindFilter {
  if (!value || typeof value !== "object") {
    return { ...defaultDanmakuKindFilter };
  }

  const source = value as Partial<Record<DanmakuKind, unknown>>;
  const filter = { ...defaultDanmakuKindFilter };
  for (const kind of danmakuKinds) {
    if (typeof source[kind] === "boolean") {
      filter[kind] = source[kind] as boolean;
    }
  }
  return filter;
}

export function allowsDanmakuEvent(event: DanmakuEvent, filter: DanmakuKindFilter): boolean {
  if (!filter[event.kind]) {
    return false;
  }
  if (event.kind === "text" && !filter.member && isNonChatText(event.text)) {
    return false;
  }
  return true;
}
