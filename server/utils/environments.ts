// Environment validation + serialization shared by the API routes.
import { z } from 'zod'

export const environmentInput = z.strictObject({
  name: z.string().min(1).max(64),
  host: z.string().min(1).max(253),
  port: z.string().regex(/^[1-9][0-9]{0,4}$/, 'port must be 1-65535')
    .refine(p => Number.parseInt(p, 10) <= 65535, 'port must be 1-65535')
    .default('22'),
  username: z.string().min(1).max(64),
})

export type EnvironmentInput = z.infer<typeof environmentInput>

export interface EnvironmentRow {
  id: string
  name: string
  host: string
  port: string
  username: string
  createdAt: string
  updatedAt: string
}
