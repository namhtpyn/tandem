// Boot: apply migrations, then seed the default admin when the instance has NO
// users. A brand-new deployment therefore always has a known login:
//   email    = env ADMIN_EMAIL    (default admin@tandem.local)
//   password = env ADMIN_PASSWORD (default tandem-admin)
// Skipped when any user row exists — restarts never overwrite real accounts.
import { db } from '../db'
import { user, account } from '../db/schema'
import { applyMigrations } from '../db'
import { uuidv7 } from '../domains/kernel/ids'

// Bun.serve idle timeout, in the code (was stack env). 255s = Bun's max: without it
// the default (10s) kills idle SSE feeds mid-stream. Runs before Bun.serve reads it
// (plugins init before the serve call in the generated entry). Env still wins if set.
process.env.NITRO_BUN_IDLE_TIMEOUT ||= '255'

export default defineNitroPlugin(async () => {
  const applied = await applyMigrations()
  if (applied.length > 0) console.log('[tandem] applied migrations:', applied.join(', '))

  // agent dispatcher: eligible tasks (ready + AI assignee) fire automatically.
  // Opt out with TANDEM_NO_DISPATCHER=1 (tests); fake runner with TANDEM_FAKE_RUNNER=1.
  const { maybeStartDispatcher } = await import('../domains/tasks/dispatcher.service')
  await maybeStartDispatcher()
  const { bridgeRedisChanges } = await import('../domains/kernel/change-bus')
  await bridgeRedisChanges()

  const existing = await db.select({ id: user.id }).from(user).limit(1)
  if (existing.length > 0) return

  const email = process.env.ADMIN_EMAIL || 'admin@tandem.local'
  const password = process.env.ADMIN_PASSWORD || 'tandem-admin'
  const id = uuidv7()
  const now = new Date()
  await db.insert(user).values({
    id,
    name: 'Admin',
    email,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
    role: 'admin',
  })
  // password hash via better-auth's own hasher for compatibility
  const { hashPassword } = await import('../domains/auth/auth-hash.util')
  await db.insert(account).values({
    id: uuidv7(),
    accountId: id,
    providerId: 'credential',
    userId: id,
    password: await hashPassword(password),
    createdAt: now,
    updatedAt: now,
  })
  console.log(`[tandem] seeded admin ${email} (change the password after first login)`)
})
