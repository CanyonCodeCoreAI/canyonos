import { z } from 'zod';

export const RegisterProjectBody = z.object({ redis_port: z.number().int().min(1).max(65535) });

export const RegisteredProjectSchema = z.object({
  project_id: z.string().uuid(),
  name: z.string(),
});

export type RegisterProject = z.infer<typeof RegisterProjectBody>;
export type RegisteredProject = z.infer<typeof RegisteredProjectSchema>;
