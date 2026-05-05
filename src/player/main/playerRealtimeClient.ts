import WebSocket, { type RawData } from "ws";
import type { PlayerRealtimeConnection, PlayerRealtimeEvent } from "../shared/types.js";

interface WebSocketLike {
  close(): void;
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: RawData) => void): this;
  on(event: "close", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}

interface PlayerRealtimeClientOptions {
  createSocket?: (url: string) => WebSocketLike;
  reconnectDelaysMs?: readonly number[];
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

type TimerHandle = ReturnType<typeof setTimeout>;

const DEFAULT_RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000] as const;

export class PlayerRealtimeClient {
  private readonly createSocket: (url: string) => WebSocketLike;
  private readonly reconnectDelaysMs: readonly number[];
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly eventListeners = new Set<(event: PlayerRealtimeEvent) => void>();
  private readonly statusListeners = new Set<(status: PlayerRealtimeConnection) => void>();

  private baseUrl?: string;
  private token?: string;
  private socket?: WebSocketLike;
  private reconnectTimer?: TimerHandle;
  private reconnectAttempt = 0;
  private manualDisconnect = false;
  private connectionId = 0;

  constructor(options: PlayerRealtimeClientOptions = {}) {
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url, { rejectUnauthorized: false }));
    this.reconnectDelaysMs = options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  }

  connect(baseUrl: string, token: string): void {
    if (this.baseUrl === baseUrl && this.token === token && (this.socket || this.reconnectTimer)) {
      return;
    }

    this.closeSocket(false);
    this.baseUrl = baseUrl;
    this.token = token;
    this.manualDisconnect = false;
    this.reconnectAttempt = 0;
    this.openSocket(true);
  }

  disconnect(): void {
    this.baseUrl = undefined;
    this.token = undefined;
    this.reconnectAttempt = 0;
    this.manualDisconnect = true;
    this.closeSocket(false);
    this.emitStatus("disconnected");
  }

  onEvent(listener: (event: PlayerRealtimeEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  onStatus(listener: (status: PlayerRealtimeConnection) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  private openSocket(announceConnecting: boolean): void {
    if (!this.baseUrl || !this.token) {
      return;
    }

    if (announceConnecting) {
      this.emitStatus("connecting");
    }

    const connectionId = ++this.connectionId;
    const socket = this.createSocket(this.buildRealtimeUrl(this.baseUrl, this.token));
    this.socket = socket;

    socket.on("open", () => {
      if (connectionId !== this.connectionId || this.socket !== socket) {
        return;
      }
      this.reconnectAttempt = 0;
      this.emitStatus("connected");
    });

    socket.on("message", (data) => {
      if (connectionId !== this.connectionId || this.socket !== socket) {
        return;
      }
      const event = sanitizeRealtimeEvent(data);
      if (event) {
        this.emitEvent(event);
      }
    });

    socket.on("close", () => {
      if (connectionId !== this.connectionId || this.socket !== socket) {
        return;
      }
      this.socket = undefined;
      this.handleDisconnect();
    });

    socket.on("error", () => {
      if (connectionId !== this.connectionId || this.socket !== socket) {
        return;
      }
    });
  }

  private handleDisconnect(): void {
    if (this.manualDisconnect || !this.baseUrl || !this.token) {
      this.emitStatus("disconnected");
      return;
    }

    const delay = this.reconnectDelaysMs[this.reconnectAttempt];
    if (delay === undefined) {
      this.emitStatus("disconnected");
      return;
    }

    this.reconnectAttempt += 1;
    this.emitStatus("connecting");
    this.reconnectTimer = this.setTimeoutFn(() => {
      this.reconnectTimer = undefined;
      this.openSocket(false);
    }, delay);
  }

  private closeSocket(clearListeners: boolean): void {
    if (this.reconnectTimer) {
      this.clearTimeoutFn(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    const socket = this.socket;
    this.socket = undefined;
    this.connectionId += 1;
    if (socket) {
      socket.close();
    }
    if (clearListeners) {
      this.eventListeners.clear();
      this.statusListeners.clear();
    }
  }

  private emitEvent(event: PlayerRealtimeEvent): void {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }

  private emitStatus(status: PlayerRealtimeConnection): void {
    for (const listener of this.statusListeners) {
      listener(status);
    }
  }

  private buildRealtimeUrl(baseUrl: string, token: string): string {
    const url = new URL("/ws", baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("token", token);
    return url.toString();
  }
}

function sanitizeRealtimeEvent(payload: RawData): PlayerRealtimeEvent | undefined {
  const text = rawDataToString(payload);
  try {
    const message = JSON.parse(text) as Record<string, unknown>;
    if (typeof message.type !== "string") {
      return undefined;
    }
    switch (message.type) {
      case "presence_updated":
      case "friend_list_refresh":
        return message as PlayerRealtimeEvent;
      case "friend_request_received":
      case "friend_request_resolved":
      case "party_updated":
      case "party_invite_received":
      case "party_invite_resolved":
      case "queue_updated":
      case "ready_check_started":
      case "ready_check_updated":
      case "match_room_created":
      case "teams_assigned":
      case "veto_started":
      case "veto_tick":
      case "map_banned":
      case "map_picked":
      case "server_preparing":
      case "connect_ready":
      case "match_live":
      case "match_completed":
      case "match_failed":
        return stripAudience(message) as PlayerRealtimeEvent;
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

function stripAudience<T extends { accountIds?: string[] }>(message: T): Omit<T, "accountIds"> {
  const { accountIds: _accountIds, ...rest } = message;
  return rest;
}

function rawDataToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return Buffer.concat(data.map((chunk) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Buffer.from(data as ArrayBufferLike).toString("utf8");
}
