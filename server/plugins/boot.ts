// Boot: apply migrations, then seed the default admin when the instance has NO
// users. A brand-new deployment therefore always has a known login:
//   email    = env ADMIN_EMAIL    (default admin@tandem.local)
//   password = env ADMIN_PASSWORD (default tandem-admin)
// Skipped when any user row exists — restarts never overwrite real accounts.
import { db } from '../db'
import { user, account } from '../db/schema'
import { applyMigrations } from '../db'

export default defineNitroPlugin(async () => {
  const applied = await applyMigrations()
  if (applied.length > 0) console.log('[tandem] applied migrations:', applied.join(', '))

  const existing = await db.select({ id: user.id }).from(user).limit(1)
  if (existing.length > 0) return

  const email = process.env.ADMIN_EMAIL || 'admin@tandem.local'
  const password = process.env.ADMIN_PASSWORD || 'tandem-admin'
  const id = crypto.randomUUID()
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
  const { hashPassword } = await import('../utils/auth-hash')
  await db.insert(account).values({
    id: crypto.randomUUID(),
    accountId: id,
    providerId: 'credential',
    userId: id,
    password: await hashPassword(password),
    createdAt: now,
    updatedAt: now,
  })
  console.log(`[tandem] seeded admin ${email} (change the password after first login)`)
})
