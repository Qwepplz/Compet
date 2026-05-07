import type { WebSocket } from "ws";
import type { RealtimeEvent } from "./realtimeTypes.js";

const SOCKET_OPEN = 1;

export class RealtimeSocketRegistry {
  private readonly socketsByAccount = new Map<string, Set<WebSocket>>();
  private readonly accountBySocket = new Map<WebSocket, string>();

  register(accountId: string, socket: WebSocket): void {
    const previousAccountId = this.accountBySocket.get(socket);
    if (previousAccountId === accountId) {
      this.socketsByAccount.get(accountId)?.add(socket);
      return;
    }
    if (previousAccountId) {
      this.unregister(socket);
    }

    let sockets = this.socketsByAccount.get(accountId);
    if (!sockets) {
      sockets = new Set<WebSocket>();
      this.socketsByAccount.set(accountId, sockets);
    }

    sockets.add(socket);
    this.accountBySocket.set(socket, accountId);
  }

  unregister(socket: WebSocket): void {
    const accountId = this.accountBySocket.get(socket);
    if (!accountId) return;

    this.accountBySocket.delete(socket);
    const sockets = this.socketsByAccount.get(accountId);
    if (!sockets) return;

    sockets.delete(socket);
    if (sockets.size === 0) {
      this.socketsByAccount.delete(accountId);
    }
  }

  publish(event: RealtimeEvent): void {
    const sockets = resolveAudience(event, this.socketsByAccount, this.accountBySocket);
    if (sockets.size === 0) return;
    sendJsonToSockets(sockets, event);
  }
}

function resolveAudience(
  event: RealtimeEvent,
  socketsByAccount: Map<string, Set<WebSocket>>,
  accountBySocket: Map<WebSocket, string>,
): Set<WebSocket> {
  if ("accountIds" in event && event.accountIds) {
    const sockets = new Set<WebSocket>();
    for (const accountId of event.accountIds) {
      const accountSockets = socketsByAccount.get(accountId);
      if (!accountSockets) continue;
      for (const socket of accountSockets) {
        sockets.add(socket);
      }
    }
    return sockets;
  }

  if ("accountId" in event) {
    return new Set(socketsByAccount.get(event.accountId) ?? []);
  }

  return new Set(accountBySocket.keys());
}

function sendJsonToSockets(sockets: Set<WebSocket>, payload: unknown): void {
  const encoded = JSON.stringify(payload);
  for (const socket of sockets) {
    if (socket.readyState === SOCKET_OPEN) {
      socket.send(encoded);
    }
  }
}
