import WebSocket, { type RawData } from "ws";
import type { PlayerRealtimeConnection, PlayerRealtimeEvent } from "../shared/types.js";

interface WebSocketLike {
  readonly readyState: number;
  close(): void;
  send(data: string): void;
  terminate?(): void;
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: RawData) => void): this;
  on(event: "close", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}

interface PlayerRealtimeClientOptions {
  createSocket?: (url: string) => WebSocketLike;
  reconnectDelaysMs?: readonly number[];
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

type TimerHandle = ReturnType<typeof setTimeout>;
type PendingCommand = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: TimerHandle;
};

export interface RealtimeCommandServiceError extends Error {
  realtimeCommandServiceError: true;
  statusCode?: number;
}

const DEFAULT_RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000] as const;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 6_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 12_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 4_000;

export function isRealtimeCommandServiceError(error: unknown): error is RealtimeCommandServiceError {
  return typeof error === "object" && error !== null && (error as { realtimeCommandServiceError?: unknown }).realtimeCommandServiceError === true;
}

export class PlayerRealtimeClient {
  private readonly createSocket: (url: string) => WebSocketLike;
  private readonly reconnectDelaysMs: readonly number[];
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly eventListeners = new Set<(event: PlayerRealtimeEvent) => void>();
  private readonly statusListeners = new Set<(status: PlayerRealtimeConnection) => void>();
  private readonly pendingCommands = new Map<string, PendingCommand>();

  private baseUrl?: string;
  private token?: string;
  private socket?: WebSocketLike;
  private reconnectTimer?: TimerHandle;
  private heartbeatTimer?: TimerHandle;
  private heartbeatTimeoutTimer?: TimerHandle;
  private connectionReadyTimer?: TimerHandle;
  private reconnectAttempt = 0;
  private manualDisconnect = false;
  private connectionId = 0;
  private commandSeq = 0;
  private lastSeq = 0;

  constructor(options: PlayerRealtimeClientOptions = {}) {
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url, { rejectUnauthorized: false }));
    this.reconnectDelaysMs = options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
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
    this.lastSeq = 0;
    this.manualDisconnect = false;
    this.reconnectAttempt = 0;
    this.openSocket(true);
  }

  disconnect(): void {
    this.baseUrl = undefined;
    this.token = undefined;
    this.reconnectAttempt = 0;
    this.lastSeq = 0;
    this.manualDisconnect = true;
    this.closeSocket(false);
    this.emitStatus("disconnected");
  }

  sendCommand<T>(name: string, payload: unknown): Promise<T> {
    if (!this.socket || this.socket.readyState !== 1) {
      return Promise.reject(new Error("Realtime command unavailable"));
    }

    const commandId = `cmd_${Date.now()}_${++this.commandSeq}`;
    const message = JSON.stringify({ type: "command", commandId, name, payload });
    return new Promise<T>((resolve, reject) => {
      const timeout = this.setTimeoutFn(() => {
        this.pendingCommands.delete(commandId);
        reject(new Error("Realtime command timed out"));
      }, DEFAULT_COMMAND_TIMEOUT_MS);
      this.pendingCommands.set(commandId, { resolve: resolve as (value: unknown) => void, reject, timeout });
      try {
        this.socket?.send(message);
      } catch (error) {
        this.clearTimeoutFn(timeout);
        this.pendingCommands.delete(commandId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
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
    let connectionReady = false;
    const markConnectionReady = () => {
      if (connectionReady || connectionId !== this.connectionId || this.socket !== socket) {
        return;
      }
      connectionReady = true;
      this.clearConnectionReadyTimeout();
      this.reconnectAttempt = 0;
      this.emitStatus("connected");
      this.scheduleHeartbeat(socket, connectionId);
    };
    this.scheduleConnectionReadyTimeout(socket, connectionId);

    socket.on("message", (data) => {
      if (connectionId !== this.connectionId || this.socket !== socket) {
        return;
      }
      this.acknowledgeHeartbeat(socket, connectionId);
      const message = parseRealtimeMessage(data);
      if (isConnectionReadyMessage(message)) {
        markConnectionReady();
        return;
      }
      if (this.handleCommandAck(message)) {
        return;
      }
      const event = sanitizeRealtimeEvent(message);
      if (event) {
        if (typeof event.seq === "number" && event.seq > this.lastSeq) {
          this.lastSeq = event.seq;
        }
        this.emitEvent(event);
      }
    });

    socket.on("close", () => {
      if (connectionId !== this.connectionId || this.socket !== socket) {
        return;
      }
      this.clearConnectionReadyTimeout();
      this.clearHeartbeat();
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
    this.clearConnectionReadyTimeout();
    this.clearHeartbeat();

    const socket = this.socket;
    this.socket = undefined;
    this.connectionId += 1;
    if (socket) {
      socket.close();
    }
    this.rejectPendingCommands(new Error("Realtime command unavailable"));
    if (clearListeners) {
      this.eventListeners.clear();
      this.statusListeners.clear();
    }
  }

  private scheduleHeartbeat(socket: WebSocketLike, connectionId: number): void {
    if (connectionId !== this.connectionId || this.socket !== socket || this.heartbeatIntervalMs <= 0) {
      return;
    }
    if (this.heartbeatTimer) {
      this.clearTimeoutFn(this.heartbeatTimer);
    }
    this.heartbeatTimer = this.setTimeoutFn(() => {
      this.heartbeatTimer = undefined;
      this.sendHeartbeat(socket, connectionId);
    }, this.heartbeatIntervalMs);
  }

  private sendHeartbeat(socket: WebSocketLike, connectionId: number): void {
    if (connectionId !== this.connectionId || this.socket !== socket) {
      return;
    }
    try {
      socket.send(JSON.stringify({ type: "ping" }));
    } catch {
      this.forceDisconnect(socket, connectionId);
      return;
    }
    if (this.heartbeatTimeoutMs <= 0) {
      this.scheduleHeartbeat(socket, connectionId);
      return;
    }
    this.heartbeatTimeoutTimer = this.setTimeoutFn(() => {
      this.heartbeatTimeoutTimer = undefined;
      this.forceDisconnect(socket, connectionId);
    }, this.heartbeatTimeoutMs);
  }

  private acknowledgeHeartbeat(socket: WebSocketLike, connectionId: number): void {
    if (this.heartbeatTimeoutTimer) {
      this.clearTimeoutFn(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = undefined;
    }
    this.scheduleHeartbeat(socket, connectionId);
  }

  private forceDisconnect(socket: WebSocketLike, connectionId: number): void {
    if (connectionId !== this.connectionId || this.socket !== socket) {
      return;
    }
    this.clearConnectionReadyTimeout();
    this.clearHeartbeat();
    this.socket = undefined;
    this.connectionId += 1;
    socket.terminate?.();
    this.handleDisconnect();
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      this.clearTimeoutFn(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.heartbeatTimeoutTimer) {
      this.clearTimeoutFn(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = undefined;
    }
  }

  private scheduleConnectionReadyTimeout(socket: WebSocketLike, connectionId: number): void {
    if (this.heartbeatTimeoutMs <= 0) {
      return;
    }
    this.clearConnectionReadyTimeout();
    this.connectionReadyTimer = this.setTimeoutFn(() => {
      this.connectionReadyTimer = undefined;
      this.forceDisconnect(socket, connectionId);
    }, this.heartbeatTimeoutMs);
  }

  private clearConnectionReadyTimeout(): void {
    if (this.connectionReadyTimer) {
      this.clearTimeoutFn(this.connectionReadyTimer);
      this.connectionReadyTimer = undefined;
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
    if (this.lastSeq > 0) {
      url.searchParams.set("lastSeq", String(this.lastSeq));
    }
    return url.toString();
  }

  private handleCommandAck(message: unknown): boolean {
    if (typeof message !== "object" || message === null) return false;
    const ack = message as { type?: unknown; commandId?: unknown; ok?: unknown; result?: unknown; error?: { message?: unknown; statusCode?: unknown } };
    if (ack.type !== "command_ack" || typeof ack.commandId !== "string") return false;

    const pending = this.pendingCommands.get(ack.commandId);
    if (!pending) return true;
    this.pendingCommands.delete(ack.commandId);
    this.clearTimeoutFn(pending.timeout);
    if (ack.ok === true) {
      pending.resolve(ack.result);
      return true;
    }

    const error = new Error(typeof ack.error?.message === "string" ? ack.error.message : "Realtime command failed") as RealtimeCommandServiceError;
    error.realtimeCommandServiceError = true;
    if (typeof ack.error?.statusCode === "number") {
      error.statusCode = ack.error.statusCode;
    }
    pending.reject(error);
    return true;
  }

  private rejectPendingCommands(error: Error): void {
    for (const [commandId, pending] of this.pendingCommands) {
      this.clearTimeoutFn(pending.timeout);
      pending.reject(error);
      this.pendingCommands.delete(commandId);
    }
  }
}

function parseRealtimeMessage(payload: RawData): unknown {
  try {
    return JSON.parse(rawDataToString(payload)) as unknown;
  } catch {
    return undefined;
  }
}

function isConnectionReadyMessage(message: unknown): boolean {
  if (typeof message !== "object" || message === null) return false;
  const type = (message as { type?: unknown }).type;
  if (type === "hello") return true;
  return type === "server_status" && (message as { status?: unknown }).status === "online";
}

function sanitizeRealtimeEvent(message: unknown): PlayerRealtimeEvent | undefined {
  if (typeof message !== "object" || message === null || typeof (message as { type?: unknown }).type !== "string") {
    return undefined;
  }
  switch ((message as { type: string }).type) {
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
    case "match_chat_message":
    case "server_preparing":
    case "connect_ready":
    case "match_live":
    case "match_completed":
    case "match_failed":
      return stripAudience(message as { accountIds?: string[] }) as PlayerRealtimeEvent;
    default:
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
