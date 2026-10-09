// GET /api/settings — app settings for the Settings page (session required).
import { getSettings } from '../../utils/settings'

export default defineEventHandler(async (event) => {
  await requireSession(event)
  return await getSettings()
})
