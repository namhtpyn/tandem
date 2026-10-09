// GET /health/ready — readiness: 200 only when Postgres answers SELECT 1 AND
// all migrations are applied. 503 otherwise (pull out of rotation, no restart).
import { defineEventHandler, setResponseStatus } from 'h3'
import { sqlClient } from '../../db'
import { applyMigrations } from '../../db'

let migrationsDone = false

export default defineEventHandler(async (event) => {
  try {
    await sqlClient`select 1`
    if (!migrationsDone) {
      const applied = await applyMigrations()
      if (applied.length > 0) console.log('[tandem] applied migrations:', applied.join(', '))
      migrationsDone = true
    }
    setResponseStatus(event, 200)
    return { ok: true, migrations: 'complete' }
  }
  catch (e) {
    setResponseStatus(event, 503)
    /* v8 ignore start -- postgres.js always throws typed errors */
    const message = e instanceof Error ? e.message : 'database unavailable'
    return { ok: false, error: message }
    /* v8 ignore stop */
  }
})
