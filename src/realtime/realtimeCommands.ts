export type RealtimeCommand =
  | { type: "command"; commandId: string; name: "matchmaking.acceptReady"; payload: Record<string, never> }
  | { type: "command"; commandId: string; name: "matchmaking.declineReady"; payload: Record<string, never> }
  | {
      type: "command";
      commandId: string;
      name: "matchRoom.entered";
      payload: { roomId: string };
    }
  | {
      type: "command";
      commandId: string;
      name: "matchRoom.applyVeto";
      payload: { roomId: string; action: "ban" | "pick"; map: string };
    }
  | {
      type: "command";
      commandId: string;
      name: "matchRoom.sendChatMessage";
      payload: { roomId: string; text: string };
    };

export interface RealtimeCommandAckSuccess {
  type: "command_ack";
  commandId: string;
  ok: true;
  result: unknown;
}

export interface RealtimeCommandAckFailure {
  type: "command_ack";
  commandId: string;
  ok: false;
  error: {
    message: string;
    statusCode?: number;
  };
}

export type RealtimeCommandAck = RealtimeCommandAckSuccess | RealtimeCommandAckFailure;

export interface RealtimeCommandMatchmaking {
  acceptReady(accountId: string): Promise<unknown>;
  declineReady(accountId: string): Promise<unknown>;
  ackReadyRoomEntered(roomId: string, accountId: string): Promise<unknown>;
  applyVeto(input: { roomId: string; accountId: string; action: "ban" | "pick"; map: string }): Promise<unknown>;
  sendMatchChatMessage(input: { roomId: string; accountId: string; text: string }): Promise<unknown>;
}

export interface RealtimeCommandDeps {
  matchmaking?: RealtimeCommandMatchmaking;
}

export function parseRealtimeCommand(message: unknown): RealtimeCommand | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const record = message as { type?: unknown; commandId?: unknown; name?: unknown; payload?: unknown };
  if (record.type !== "command" || typeof record.commandId !== "string" || typeof record.name !== "string") return undefined;
  const payload = typeof record.payload === "object" && record.payload !== null ? record.payload as Record<string, unknown> : {};
  switch (record.name) {
    case "matchmaking.acceptReady":
    case "matchmaking.declineReady":
      return { type: "command", commandId: record.commandId, name: record.name, payload: {} };
    case "matchRoom.entered":
      return typeof payload.roomId === "string"
        ? { type: "command", commandId: record.commandId, name: record.name, payload: { roomId: payload.roomId } }
        : undefined;
    case "matchRoom.applyVeto":
      return typeof payload.roomId === "string"
        && (payload.action === "ban" || payload.action === "pick")
        && typeof payload.map === "string"
        ? { type: "command", commandId: record.commandId, name: record.name, payload: { roomId: payload.roomId, action: payload.action, map: payload.map } }
        : undefined;
    case "matchRoom.sendChatMessage":
      return typeof payload.roomId === "string" && typeof payload.text === "string"
        ? { type: "command", commandId: record.commandId, name: record.name, payload: { roomId: payload.roomId, text: payload.text } }
        : undefined;
    default:
      return undefined;
  }
}

export async function executeRealtimeCommand(
  command: RealtimeCommand,
  accountId: string,
  deps: RealtimeCommandDeps,
): Promise<RealtimeCommandAck> {
  const matchmaking = deps.matchmaking;
  if (!matchmaking) {
    return {
      type: "command_ack",
      commandId: command.commandId,
      ok: false,
      error: { message: "Realtime command unavailable", statusCode: 503 },
    };
  }

  try {
    switch (command.name) {
      case "matchmaking.acceptReady":
        return { type: "command_ack", commandId: command.commandId, ok: true, result: { room: await matchmaking.acceptReady(accountId) } };
      case "matchmaking.declineReady":
        return { type: "command_ack", commandId: command.commandId, ok: true, result: { room: await matchmaking.declineReady(accountId) } };
      case "matchRoom.entered":
        return {
          type: "command_ack",
          commandId: command.commandId,
          ok: true,
          result: { room: await matchmaking.ackReadyRoomEntered(command.payload.roomId, accountId) },
        };
      case "matchRoom.applyVeto":
        return {
          type: "command_ack",
          commandId: command.commandId,
          ok: true,
          result: { room: await matchmaking.applyVeto({ roomId: command.payload.roomId, accountId, action: command.payload.action, map: command.payload.map }) },
        };
      case "matchRoom.sendChatMessage":
        return {
          type: "command_ack",
          commandId: command.commandId,
          ok: true,
          result: { message: await matchmaking.sendMatchChatMessage({ roomId: command.payload.roomId, accountId, text: command.payload.text }) },
        };
    }
  } catch (error) {
    return {
      type: "command_ack",
      commandId: command.commandId,
      ok: false,
      error: {
        message: error instanceof Error ? error.message : String(error),
        statusCode: typeof (error as { statusCode?: unknown })?.statusCode === "number" ? (error as { statusCode: number }).statusCode : 400,
      },
    };
  }
}
