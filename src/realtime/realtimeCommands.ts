export type RealtimeCommand =
  | { type: "command"; commandId: string; name: "friends.sendRequest"; payload: { accountId: string } }
  | { type: "command"; commandId: string; name: "friends.acceptRequest"; payload: { requestId: string } }
  | { type: "command"; commandId: string; name: "friends.declineRequest"; payload: { requestId: string } }
  | { type: "command"; commandId: string; name: "party.create"; payload: Record<string, never> }
  | { type: "command"; commandId: string; name: "party.invite"; payload: { accountId: string } }
  | { type: "command"; commandId: string; name: "party.acceptInvite"; payload: { invitationId: string } }
  | { type: "command"; commandId: string; name: "party.declineInvite"; payload: { invitationId: string } }
  | { type: "command"; commandId: string; name: "party.leave"; payload: Record<string, never> }
  | { type: "command"; commandId: string; name: "party.startMatchmaking"; payload: { dev?: boolean } }
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

export interface RealtimeCommandFriends {
  sendRequest(fromAccountId: string, toAccountId: string): Promise<unknown>;
  acceptRequest(accountId: string, requestId: string): Promise<unknown>;
  declineRequest(accountId: string, requestId: string): Promise<unknown>;
}

export interface RealtimeCommandMatchmaking {
  createParty(ownerAccountId: string): Promise<unknown>;
  inviteToParty(ownerAccountId: string, toAccountId: string): Promise<unknown>;
  acceptPartyInvite(accountId: string, invitationId: string): Promise<unknown>;
  declinePartyInvite(accountId: string, invitationId: string): Promise<unknown>;
  leaveParty(accountId: string): Promise<unknown>;
  startPartyMatchmaking(ownerAccountId: string, options?: { dev?: boolean }): Promise<unknown>;
  acceptReady(accountId: string): Promise<unknown>;
  declineReady(accountId: string): Promise<unknown>;
  ackReadyRoomEntered(roomId: string, accountId: string): Promise<unknown>;
  sendMatchChatMessage(input: { roomId: string; accountId: string; text: string }): Promise<unknown>;
}

export interface RealtimeCommandDeps {
  friends?: RealtimeCommandFriends;
  matchmaking?: RealtimeCommandMatchmaking;
}

export function parseRealtimeCommand(message: unknown): RealtimeCommand | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const record = message as { type?: unknown; commandId?: unknown; name?: unknown; payload?: unknown };
  if (record.type !== "command" || typeof record.commandId !== "string" || typeof record.name !== "string") return undefined;
  const payload = typeof record.payload === "object" && record.payload !== null ? record.payload as Record<string, unknown> : {};
  switch (record.name) {
    case "friends.sendRequest":
    case "party.invite":
      return typeof payload.accountId === "string"
        ? { type: "command", commandId: record.commandId, name: record.name, payload: { accountId: payload.accountId } }
        : undefined;
    case "friends.acceptRequest":
    case "friends.declineRequest":
      return typeof payload.requestId === "string"
        ? { type: "command", commandId: record.commandId, name: record.name, payload: { requestId: payload.requestId } }
        : undefined;
    case "party.acceptInvite":
    case "party.declineInvite":
      return typeof payload.invitationId === "string"
        ? { type: "command", commandId: record.commandId, name: record.name, payload: { invitationId: payload.invitationId } }
        : undefined;
    case "party.create":
    case "party.leave":
    case "matchmaking.acceptReady":
    case "matchmaking.declineReady":
      return { type: "command", commandId: record.commandId, name: record.name, payload: {} };
    case "party.startMatchmaking":
      return {
        type: "command",
        commandId: record.commandId,
        name: record.name,
        payload: typeof payload.dev === "boolean" ? { dev: payload.dev } : {},
      };
    case "matchRoom.entered":
      return typeof payload.roomId === "string"
        ? { type: "command", commandId: record.commandId, name: record.name, payload: { roomId: payload.roomId } }
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
  const friends = deps.friends;
  const matchmaking = deps.matchmaking;

  try {
    switch (command.name) {
      case "friends.sendRequest":
        if (!friends) return commandUnavailable(command.commandId);
        return { type: "command_ack", commandId: command.commandId, ok: true, result: { request: await friends.sendRequest(accountId, command.payload.accountId) } };
      case "friends.acceptRequest":
        if (!friends) return commandUnavailable(command.commandId);
        return { type: "command_ack", commandId: command.commandId, ok: true, result: { friends: await friends.acceptRequest(accountId, command.payload.requestId) } };
      case "friends.declineRequest":
        if (!friends) return commandUnavailable(command.commandId);
        await friends.declineRequest(accountId, command.payload.requestId);
        return { type: "command_ack", commandId: command.commandId, ok: true, result: {} };
      case "party.create":
        if (!matchmaking) return commandUnavailable(command.commandId);
        return { type: "command_ack", commandId: command.commandId, ok: true, result: { party: await matchmaking.createParty(accountId) } };
      case "party.invite":
        if (!matchmaking) return commandUnavailable(command.commandId);
        return { type: "command_ack", commandId: command.commandId, ok: true, result: { invitation: await matchmaking.inviteToParty(accountId, command.payload.accountId) } };
      case "party.acceptInvite":
        if (!matchmaking) return commandUnavailable(command.commandId);
        return { type: "command_ack", commandId: command.commandId, ok: true, result: { party: await matchmaking.acceptPartyInvite(accountId, command.payload.invitationId) } };
      case "party.declineInvite":
        if (!matchmaking) return commandUnavailable(command.commandId);
        await matchmaking.declinePartyInvite(accountId, command.payload.invitationId);
        return { type: "command_ack", commandId: command.commandId, ok: true, result: {} };
      case "party.leave":
        if (!matchmaking) return commandUnavailable(command.commandId);
        await matchmaking.leaveParty(accountId);
        return { type: "command_ack", commandId: command.commandId, ok: true, result: {} };
      case "party.startMatchmaking":
        if (!matchmaking) return commandUnavailable(command.commandId);
        return { type: "command_ack", commandId: command.commandId, ok: true, result: { room: await matchmaking.startPartyMatchmaking(accountId, { dev: command.payload.dev }) } };
      case "matchmaking.acceptReady":
        if (!matchmaking) return commandUnavailable(command.commandId);
        return { type: "command_ack", commandId: command.commandId, ok: true, result: { room: await matchmaking.acceptReady(accountId) } };
      case "matchmaking.declineReady":
        if (!matchmaking) return commandUnavailable(command.commandId);
        return { type: "command_ack", commandId: command.commandId, ok: true, result: { room: await matchmaking.declineReady(accountId) } };
      case "matchRoom.entered":
        if (!matchmaking) return commandUnavailable(command.commandId);
        return {
          type: "command_ack",
          commandId: command.commandId,
          ok: true,
          result: { room: await matchmaking.ackReadyRoomEntered(command.payload.roomId, accountId) },
        };
      case "matchRoom.sendChatMessage":
        if (!matchmaking) return commandUnavailable(command.commandId);
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

function commandUnavailable(commandId: string): RealtimeCommandAckFailure {
  return {
    type: "command_ack",
    commandId,
    ok: false,
    error: { message: "Realtime command unavailable", statusCode: 503 },
  };
}
