// Environment validation + serialization shared by the API routes.
import { z } from 'zod';

import { SECRET_USAGE } from '#shared/enums';

export const environmentInput = z.strictObject({
  name: z.string().min(1).max(64),
  host: z.string().regex(/^(?!-)[a-zA-Z0-9._-]{1,253}(?<!-)$/, 'ssh-safe host'),
  port: z
    .string()
    .regex(/^[1-9][0-9]{0,4}$/, 'port must be 1-65535')
    .refine((p) => Number.parseInt(p, 10) <= 65535, 'port must be 1-65535')
    .default('22'),
  username: z.string().regex(/^[a-zA-Z0-9._][a-zA-Z0-9._-]{0,63}$/, 'ssh-safe username'),
  secretId: z.string().min(1).nullable().default(null),
  secretUsage: z.enum(SECRET_USAGE).default(SECRET_USAGE.SSH_KEY),
});

/** update variant: optional keys — an omitted field keeps its stored value
 *  instead of silently resetting (port/secret) */
export const environmentUpdateInput = z.strictObject({
  id: z.string().min(1),
  name: environmentInput.shape.name.optional(),
  host: environmentInput.shape.host.optional(),
  port: environmentInput.shape.port.removeDefault().optional(),
  username: environmentInput.shape.username.optional(),
  secretId: environmentInput.shape.secretId.removeDefault().optional(),
  secretUsage: environmentInput.shape.secretUsage.removeDefault().optional(),
});
