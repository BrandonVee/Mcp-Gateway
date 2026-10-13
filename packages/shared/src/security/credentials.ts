import { z } from 'zod';

/** Shared by browser forms, control-plane writes and gateway credential validation. */
export const API_KEY_MAX_LENGTH = 4096;
export const API_KEY_PREFIX_MAX_LENGTH = 100;
export const API_KEY_HEADER = /^(authorization|x-[a-z0-9-]{1,60})$/i;
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;

export const apiKeySchema = z
  .string()
  .max(API_KEY_MAX_LENGTH)
  .refine((value) => Boolean(value.trim()) && !CONTROL_CHARACTERS.test(value));
export const apiKeyPrefixSchema = z
  .string()
  .max(API_KEY_PREFIX_MAX_LENGTH)
  .refine((value) => !CONTROL_CHARACTERS.test(value));

export function isValidApiKey(value: unknown): value is string {
  return apiKeySchema.safeParse(value).success;
}

export function isValidApiKeyPrefix(value: unknown): value is string {
  return apiKeyPrefixSchema.safeParse(value).success;
}

/** OAuth token lengths are upstream-defined; only API-key drafts have a size bound. */
export const credentialHeaderSchema = z.object({
  header: z.string().regex(API_KEY_HEADER),
  value: z
    .string()
    .min(1)
    .refine((value) => !CONTROL_CHARACTERS.test(value)),
});
export type CredentialHeader = z.infer<typeof credentialHeaderSchema>;

/** A missing credential is explicitly null; malformed broker responses fail closed. */
export const upstreamCredentialResponseSchema = z.object({
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  credential: credentialHeaderSchema.nullable(),
});
