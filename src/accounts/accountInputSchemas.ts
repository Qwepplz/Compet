import { z } from "zod";

export const createAccountSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(8),
  steam64: z.string().default(""),
});

export const patchAccountSchema = z.object({
  steam64: z.string().optional(),
  enabled: z.boolean().optional(),
  dev: z.boolean().optional(),
});

export const passwordSchema = z.object({ password: z.string().min(8) });
export const accountIdSchema = z.string().min(1);
