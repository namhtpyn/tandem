// Root: redirect to /admin (SSR session-aware — no flash of login there).
import { defineEventHandler, sendRedirect } from 'h3'

export default defineEventHandler((event) => {
  return sendRedirect(event, '/admin', 302)
})
