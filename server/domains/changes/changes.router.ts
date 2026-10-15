import { os } from '@orpc/server'
// changes router — the SSE half of the SSE law: initial data comes from
// conventional GET list procs; THIS stream only tells clients WHAT changed so
// they invalidate + refetch. One connection per client, opened after mount.
import { changeBus, protectedProcedure } from '../kernel/kernel'

export const changesRouter = os.router({
  /** stream change events ({ resource, action }) — never carries data itself */
  live: protectedProcedure.handler(async function* () {
    for await (const evt of changeBus.subscribe('change')) {
      yield { resource: evt.resource, action: evt.action }
    }
  }),
})
