import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Input, message as toast } from "antd";
import type {
  PlayerLiveMatchStateDto,
  PlayerMatchChatMessageDto,
  PlayerVetoHistoryEntryDto,
} from "../../../shared/types.js";
import { formatMapName } from "../mapDisplay.js";

interface MatchChatPanelProps {
  accountId: string;
  room: PlayerLiveMatchStateDto;
  onSendMessage?: (text: string) => Promise<void>;
}

type ChatItem = {
  id: string;
  kind: "system" | "player";
  text: string;
  createdAt: string;
  accountId?: string;
  displayName?: string;
};

export function MatchChatPanel({ accountId, room, onSendMessage }: MatchChatPanelProps) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const items = useMemo(() => {
    const chatItems = (room.chat ?? []).map((message) => chatMessageToItem(room, message));
    const vetoItems = (room.veto?.history ?? []).map((entry, index) => vetoEntryToItem(room, entry, index));
    return [...chatItems, ...vetoItems].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  }, [room]);

  useEffect(() => {
    const element = messagesRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [items.length]);

  async function submit() {
    const value = text.trim();
    if (!value || !onSendMessage || sending) return;
    setSending(true);
    try {
      await onSendMessage(value);
      setText("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "消息发送失败");
    } finally {
      setSending(false);
    }
  }
  return (
    <section className="match-chat-panel" aria-label="比赛聊天">
      <header className="match-chat-header">
        <strong>比赛聊天</strong>
        <span>{room.teamA.name} vs {room.teamB.name}</span>
      </header>

      <div className="match-chat-messages" ref={messagesRef}>
        {items.length === 0 ? <div className="match-chat-empty">暂无聊天消息</div> : null}
        {items.map((item) => (
          <article
            className={`match-chat-message match-chat-message--${item.kind}${item.accountId === accountId ? " match-chat-message--self" : ""}`}
            key={item.id}
          >
            {item.kind === "player" ? <strong>{item.displayName ?? "玩家"}</strong> : null}
            <p>{item.text}</p>
            <time>{formatTime(item.createdAt)}</time>
          </article>
        ))}
      </div>
      <div className="match-chat-compose">
        <Input
          allowClear
          disabled={!onSendMessage || sending}
          maxLength={300}
          placeholder="发送消息"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onPressEnter={() => void submit()}
        />
        <Button type="primary" loading={sending} disabled={!text.trim() || !onSendMessage} onClick={() => void submit()}>
          发送
        </Button>
      </div>
    </section>
  );
}

function chatMessageToItem(room: PlayerLiveMatchStateDto, message: PlayerMatchChatMessageDto): ChatItem {
  return {
    id: `chat:${message.id}`,
    kind: message.kind,
    text: message.text,
    createdAt: message.createdAt,
    accountId: message.accountId,
    displayName: steamNameForAccount(room, message.accountId),
  };
}

function steamNameForAccount(room: PlayerLiveMatchStateDto, accountId?: string): string | undefined {
  if (!accountId) return undefined;
  const participant = [...room.teamA.participants, ...room.teamB.participants].find((candidate) => candidate.accountId === accountId);
  return participant?.steamPersonaName?.trim() || participant?.steam64?.trim() || undefined;
}

function vetoEntryToItem(room: PlayerLiveMatchStateDto, entry: PlayerVetoHistoryEntryDto, index: number): ChatItem {
  const teamName = entry.actorTeamId === "teamA" ? room.teamA.name : room.teamB.name;
  const actionText = entry.action === "pick" ? "选择了" : "禁用了";
  return {
    id: `veto:${entry.at}:${entry.map}:${entry.action}:${index}`,
    kind: "system",
    text: `${teamName} ${actionText} ${formatMapName(entry.map)}`,
    createdAt: entry.at,
  };
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}
