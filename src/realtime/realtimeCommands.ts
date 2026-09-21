
export type RealtimeCommand =
  | { type: "command"; commandId: string; name: "match.readyViewReady"; payload: { matchId: string; token: string } }
  | { type: "command"; commandId: string; name: "friends.sendRequest"; payload: { accountId: string } }
  | { type: "command"; commandId: string; name: "friends.acceptRequest"; payload: { requestId: string } }
  | { type: "command"; commandId: string; name: "friends.declineRequest"; payload: { requestId: string } }
  | { type: "command"; commandId: string; name: "friends.removeFriend"; payload: { friendshipId: string } }
  | { type: "command"; commandId: string; name: "party.create"; payload: Record<string, never> }
  | { type: "command"; commandId: string; name: "party.invite"; payload: { accountId: string } }
  | { type: "command"; commandId: string; name: "party.acceptInvite"; payload: { invitationId: string } }
  | { type: "command"; commandId: string; name: "party.declineInvite"; payload: { invitationId: string } }
  | { type: "command"; commandId: string; name: "party.ignoreInvite"; payload: { invitationId: string } }
  | { type: "command"; commandId: string; name: "party.leave"; payload: Record<string, never> }
  | { type: "command"; commandId: string; name: "party.beginMatchmaking"; payload: { dev?: boolean } }
  | { type: "command"; commandId: string; name: "party.preloadReady"; payload: { matchId: string; resourceVersion: string } }
  | { type: "command"; commandId: string; name: "party.cancelMatchmaking"; payload: Record<string, never> }
  | { type: "command"; commandId: string; name: "party.startMatchmaking"; payload: { dev?: boolean } }
  | { type: "command"; commandId: string; name: "matchmaking.acceptReady"; payload: Record<string, never> }
  | { type: "command"; commandId: string; name: "matchmaking.declineReady"; payload: Record<string, never> };

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
    code?: string;
    message: string;
    statusCode?: number;
  };
}

export type RealtimeCommandAck = RealtimeCommandAckSuccess | RealtimeCommandAckFailure;

export interface RealtimeCommandFriends {
  sendRequest(fromAccountId: string, toAccountId: string): Promise<unknown>;
  acceptRequest(accountId: string, requestId: string): Promise<unknown>;
  declineRequest(accountId: string, requestId: string): Promise<unknown>;
  removeFriend(accountId: string, friendshipId: string): Promise<unknown>;
}

export interface RealtimeCommandMatchmaking {
  acknowledgeReadyView(accountId: string, matchId: string, token: string, isConnectionActive?: () => boolean): Promise<void>;
  invalidateReadyPresentation(accountId: string): Promise<void>;
  createParty(ownerAccountId: string): Promise<unknown>;
  inviteToParty(ownerAccountId: string, toAccountId: string): Promise<unknown>;
  acceptPartyInvite(accountId: string, invitationId: string): Promise<unknown>;
  declinePartyInvite(accountId: string, invitationId: string): Promise<unknown>;
  ignorePartyInvite(accountId: string, invitationId: string): Promise<unknown>;
  leaveParty(accountId: string): Promise<unknown>;
  beginPartyMatchmaking(ownerAccountId: string, options?: { dev?: boolean }): Promise<unknown>;
  isMatchmakingParticipant(accountId: string): Promise<boolean>;
  acknowledgePreload(accountId: string, matchId: string, resourceVersion: string): Promise<void>;
  cancelPartyMatchmaking(ownerAccountId: string): Promise<unknown>;
  startPartyMatchmaking(ownerAccountId: string, options?: { dev?: boolean }): Promise<unknown>;
  acceptReady(accountId: string): Promise<unknown>;
  declineReady(accountId: string): Promise<unknown>;
}

export interface RealtimeCommandDeps {
  isConnectionActive?: () => boolean;
  friends?: RealtimeCommandFriends;
  matchmaking?: RealtimeCommandMatchmaking;
}

export function parseRealtimeCommand(message: unknown): RealtimeCommand | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const record = message as { type?: unknown; commandId?: unknown; name?: unknown; payload?: unknown };
  if (record.type !== "command" || typeof record.commandId !== "string" || typeof record.name !== "string") return undefined;
  const payload = typeof record.payload === "object" && record.payload !== null ? record.payload as Record<string, unknown> : {};
  switch (record.name) {
    case "match.readyViewReady":
      return typeof payload.matchId === "string" && payload.matchId.length > 0 && typeof payload.token === "string" && payload.token.length > 0
        ? { type: "command", commandId: record.commandId, name: record.name, payload: { matchId: payload.matchId, token: payload.token } }
        : undefined;
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
    case "friends.removeFriend":
      return typeof payload.friendshipId === "string"
        ? { type: "command", commandId: record.commandId, name: record.name, payload: { friendshipId: payload.friendshipId } }
        : undefined;
    case "party.acceptInvite":
    case "party.declineInvite":
    case "party.ignoreInvite":
      return typeof payload.invitationId === "string"
        ? { type: "command", commandId: record.commandId, name: record.name, payload: { invitationId: payload.invitationId } }
        : undefined;
    case "party.create":
    case "party.leave":
    case "party.cancelMatchmaking":
    case "matchmaking.acceptReady":
    case "matchmaking.declineReady":
      return { type: "command", commandId: record.commandId, name: record.name, payload: {} };
    case "party.beginMatchmaking":
    case "party.startMatchmaking":
      return {
        type: "command",
        commandId: record.commandId,
        name: record.name,
        payload: typeof payload.dev === "boolean" ? { dev: payload.dev } : {},
      };
    case "party.preloadReady":
      return typeof payload.matchId === "string" && typeof payload.resourceVersion === "string"
        ? { type: "command", commandId: record.commandId, name: record.name, payload: { matchId: payload.matchId, resourceVersion: payload.resourceVersion } }
        : undefined;
    default:
      return undefined;
  }
}

export async function executeRealtimeCommand(
  command: RealtimeCommand,
  accountId: string,
  deps: RealtimeCommandDeps,
  connectionId: string,
): Promise<RealtimeCommandAck> {
  const friends = deps.friends;
  const matchmaking = deps.matchmaking;

  try {
    switch (command.name) {
      case "match.readyViewReady":
        if (!matchmaking) return commandUnavailable(command.commandId);
        await matchmaking.acknowledgeReadyView(accountId, command.payload.matchId, command.payload.token, deps.isConnectionActive);
        return { type: "command_ack", commandId: command.commandId, ok: true, result: {} };
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
      case "friends.removeFriend":
        if (!friends) return commandUnavailable(command.commandId);
        await friends.removeFriend(accountId, command.payload.friendshipId);
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
      case "party.ignoreInvite":
        if (!matchmaking) return commandUnavailable(command.commandId);
        await matchmaking.ignorePartyInvite(accountId, command.payload.invitationId);
        return { type: "command_ack", commandId: command.commandId, ok: true, result: {} };
      case "party.leave":
        if (!matchmaking) return commandUnavailable(command.commandId);
        await matchmaking.leaveParty(accountId);
        return { type: "command_ack", commandId: command.commandId, ok: true, result: {} };
      case "party.beginMatchmaking":
        if (!matchmaking) return commandUnavailable(command.commandId);
        return { type: "command_ack", commandId: command.commandId, ok: true, result: { party: await matchmaking.beginPartyMatchmaking(accountId, { dev: command.payload.dev }) } };
      case "party.preloadReady":
        if (!matchmaking) return commandUnavailable(command.commandId);
        await matchmaking.acknowledgePreload(accountId, command.payload.matchId, command.payload.resourceVersion);
        return { type: "command_ack", commandId: command.commandId, ok: true, result: {} };
      case "party.cancelMatchmaking":
        if (!matchmaking) return commandUnavailable(command.commandId);
        return { type: "command_ack", commandId: command.commandId, ok: true, result: { party: await matchmaking.cancelPartyMatchmaking(accountId) } };
      case "party.startMatchmaking":
        if (!matchmaking) return commandUnavailable(command.commandId);
        return { type: "command_ack", commandId: command.commandId, ok: true, result: { room: await matchmaking.startPartyMatchmaking(accountId, { dev: command.payload.dev }) } };
      case "matchmaking.acceptReady":
        if (!matchmaking) return commandUnavailable(command.commandId);
        return { type: "command_ack", commandId: command.commandId, ok: true, result: { room: await matchmaking.acceptReady(accountId) } };
      case "matchmaking.declineReady":
        if (!matchmaking) return commandUnavailable(command.commandId);
        return { type: "command_ack", commandId: command.commandId, ok: true, result: { room: await matchmaking.declineReady(accountId) } };
    }
  } catch (error) {
    return {
      type: "command_ack",
      commandId: command.commandId,
      ok: false,
      error: {
        code: typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "bad_request",
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
    error: { code: "service_unavailable", message: "Realtime command unavailable", statusCode: 503 },
  };
}
