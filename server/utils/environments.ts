// Environment validation + serialization shared by the API routes.
import { z } from 'zod'

export const environmentInput = z.strictObject({
  name: z.string().min(1).max(64),
  host: z.string().min(1).max(253),
  port: z.string().regex(/^[1-9][0-9]{0,4}$/, 'port must be 1-65535')
    .refine(p => Number.parseInt(p, 10) <= 65535, 'port must be 1-65535')
    .default('22'),
  username: z.string().min(1).max(64),
  secretId: z.string().min(1).nullable().default(null),
  secretUsage: z.enum(['ssh-key', 'password']).default('ssh-key'),
})

export type EnvironmentInput = z.infer<typeof environmentInput>


