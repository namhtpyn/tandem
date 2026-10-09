// GET /api/version — build version for the UI badge.
export default defineEventHandler(() => ({
  version: process.env.APP_VERSION || 'dev',
}))
