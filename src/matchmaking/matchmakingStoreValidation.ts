import { z } from "zod";
import type { QueueFile, PartiesFile, PartyInvitationsFile, RoomsFile } from "./matchmakingStore.js";

const participantSchema = z.object({
  id: z.string(),
  kind: z.enum(["human", "bot"]),
  displayName: z.string(),
  steam64: z.string().optional(),
  steamPersonaName: z.string().optional(),
  steamAvatarUrl: z.string().optional(),
  botProfileName: z.string().optional(),
  botCategory: z.literal("pro").optional(),
  rankmeStanding: z.object({
    score: z.number().nullable(),
    level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5),
      z.literal(6), z.literal(7), z.literal(8), z.literal(9), z.literal(10)]),
    rank: z.number().nullable(),
  }).optional(),
  isCaptain: z.boolean().optional(),
  accountId: z.string().optional(),
  identityMasked: z.boolean().optional(),
});

const teamSchema = z.object({
  id: z.enum(["teamA", "teamB"]),
  gameSide: z.enum(["t", "ct"]),
  name: z.string(),
  logo: z.string().optional(),
  logoImage: z.string().optional(),
  participants: z.array(participantSchema),
});

const mapContentSchema = z.object({
  mapPool: z.array(z.string()),
  reel: z.array(z.string()),
  finalMap: z.string(),
});

const queueFileSchema = z.object({
  queue: z.array(z.object({
    accountId: z.string(),
    partyId: z.string().optional(),
    queuedAt: z.string(),
    readyAcceptedAt: z.string().optional(),
  })),
});

const partiesFileSchema = z.object({
  parties: z.array(z.object({
    id: z.string(),
    ownerAccountId: z.string(),
    memberAccountIds: z.array(z.string()),
    createdAt: z.string(),
    updatedAt: z.string().optional(),
    status: z.enum(["open", "matchmaking", "in_match"]).optional(),
    lockedMatchId: z.string().optional(),
    matchmakingPendingAt: z.string().optional(),
    preload: z.object({
      cancelled: z.boolean().optional(),
      resourceVersion: z.string(),
      completedAccountIds: z.array(z.string()),
      deadlineAt: z.string(),
    }).optional(),
    matchmakingDev: z.boolean().optional(),
    draft: z.object({
      teamA: teamSchema,
      teamB: teamSchema,
      mapSelection: mapContentSchema,
    }).optional(),
  })),
});

const invitationsFileSchema = z.object({
  invitations: z.array(z.object({
    id: z.string(),
    partyId: z.string(),
    fromAccountId: z.string(),
    toAccountId: z.string(),
    status: z.enum(["pending", "accepted", "declined", "expired", "timed_out"]),
    createdAt: z.string(),
    resolvedAt: z.string().optional(),
  })),
});

const roomsFileSchema = z.object({
  rooms: z.array(z.object({
    id: z.string(),
    phase: z.enum(["queue", "ready", "match_room", "map_randomizing", "server_prepare",
      "connect", "live", "completed", "failed"]),
    dev: z.literal(true).optional(),
    databaseWriteStarted: z.boolean().optional(),
    databaseBackupSupersededBy: z.string().optional(),
    teamA: teamSchema,
    teamB: teamSchema,
    humanAccountIds: z.array(z.string()).optional(),
    botParticipantIds: z.array(z.string()).optional(),
    ready: z.array(z.object({
      accountId: z.string(),
      ready: z.boolean(),
      respondedAt: z.string().optional(),
    })).optional(),
    readyPresentation: z.object({
      token: z.string(),
      completedAccountIds: z.array(z.string()),
      deadlineAt: z.string(),
    }).optional(),
    readyStartsAt: z.string().optional(),
    readyDeadlineAt: z.string().optional(),
    partyId: z.string().optional(),
    mapSelection: z.union([
      mapContentSchema.extend({ startedAt: z.string(), revealAt: z.string() }),
      mapContentSchema.extend({ startedAt: z.undefined().optional(), revealAt: z.undefined().optional() }),
    ]).optional(),
    connect: z.object({
      matchId: z.string(),
      connectAddress: z.string(),
      connectPassword: z.string(),
      connectCommand: z.string(),
      connectUrl: z.string(),
      map: z.string(),
    }).optional(),
    createdAt: z.string(),
    terminalStateAt: z.string().optional(),
  })),
  pendingBackupCleanupMatchIds: z.array(z.string().min(1)).optional(),
  pendingMatchFailedEvents: z.array(z.object({
    eventId: z.string(),
    matchId: z.string(),
    accountIds: z.array(z.string()),
    error: z.unknown().optional(),
    readyDeclinedByDisplayName: z.string().optional(),
  })).optional(),
});

function assertFile<T>(schema: z.ZodType<T>, value: unknown, filename: string): asserts value is T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const field = result.error.issues[0]?.path.join(".") || "<root>";
    throw new Error("Invalid matchmaking " + filename + " at " + field);
  }
}

export function assertQueueFile(value: unknown): asserts value is QueueFile {
  assertFile<QueueFile>(queueFileSchema, value, "queue.json");
}

export function assertPartiesFile(value: unknown): asserts value is PartiesFile {
  assertFile<PartiesFile>(partiesFileSchema, value, "parties.json");
}

export function assertInvitationsFile(value: unknown): asserts value is PartyInvitationsFile {
  assertFile<PartyInvitationsFile>(invitationsFileSchema, value, "invitations.json");
}

export function assertRoomsFile(value: unknown): asserts value is RoomsFile {
  assertFile<RoomsFile>(roomsFileSchema, value, "rooms.json");
}
