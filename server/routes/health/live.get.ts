// GET /health/live — liveness: the process is up. Zero dependency checks so a
// DB blip can never trigger restart loops. Always 200.
import { defineEventHandler, setResponseStatus } from 'h3'

export default defineEventHandler((event) => {
  setResponseStatus(event, 200)
  return { ok: true }
})
