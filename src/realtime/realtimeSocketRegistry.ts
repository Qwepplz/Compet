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

  publish(event: RealtimeEvent): { targetedConnections: number; sentConnections: number } {
    const sockets = resolveAudience(event, this.socketsByAccount, this.accountBySocket);
    return {
      targetedConnections: sockets.size,
      sentConnections: sendJsonToSockets(sockets, event),
    };
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

function sendJsonToSockets(sockets: Set<WebSocket>, payload: unknown): number {
  const encoded = JSON.stringify(payload);
  let sentConnections = 0;
  for (const socket of sockets) {
    if (socket.readyState !== SOCKET_OPEN) continue;
    try {
      socket.send(encoded);
      sentConnections += 1;
    } catch {
      // The delivery summary records failed sends without stopping other sockets.
    }
  }
  return sentConnections;
}
