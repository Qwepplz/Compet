import { z } from "zod";
import { USERNAME_PATTERN } from "./accountTypes.js";

export const usernameSchema = z.string().regex(USERNAME_PATTERN, "Username must contain only letters and numbers");

export const createAccountSchema = z.object({
  username: usernameSchema,
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
