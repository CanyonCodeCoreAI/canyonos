import { z } from 'zod';

export enum UserStatusEnum {
  PENDING = 'PENDING',
  ONBOARDING = 'ONBOARDING',
  ACTIVE = 'ACTIVE',
  LOCKED = 'LOCKED',
}

export const UserSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string().nullable().optional(),
  company_id: z.string().nullable().optional(),
  status: z.nativeEnum(UserStatusEnum),
  activated_at: z.string().nullable().optional(),
  locked_at: z.string().nullable().optional(),
  created_at: z.string(),
});
export type User = z.infer<typeof UserSchema>;

export const ChallengeRequestSchema = z.object({ email: z.string().email() });
export type ChallengeRequest = z.infer<typeof ChallengeRequestSchema>;

export const ChallengeVerifySchema = z.object({
  email: z.string().email(),
  code: z.string(),
});
export type ChallengeVerify = z.infer<typeof ChallengeVerifySchema>;

export const AuthTokenSchema = z.object({
  token: z.string(),
  user: UserSchema,
});
export type AuthToken = z.infer<typeof AuthTokenSchema>;
