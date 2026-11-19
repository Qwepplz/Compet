import { z } from "zod";

export const gameServerAttemptSchema = z.strictObject({
  id: z.uuid().refine(id => id === id.toLowerCase()),
  number: z.literal([1, 2, 3]),
});

export type GameServerAttempt = z.infer<typeof gameServerAttemptSchema>;

export function gameServerRecordKey(matchId: string, attempt?: GameServerAttempt): string {
  return attempt ? gameServerAttemptSchema.parse(attempt).id : matchId;
}
