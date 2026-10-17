// The 7 seeded task statuses carry FIXED uuidv7 ids — minted once (2026-10-17,
// in workflow order) and identical in every environment: the baseline migration
// seeds them, the uuid-status-ids remap moves existing DBs onto them, and this
// constant map is the single source the server and app code use instead of the
// old semantic strings ('todo', 'doing', …). Custom statuses minted via the
// admin UI get fresh uuidv7s from kernel/ids and are addressed by row, never by
// constant.
export const STATUS = {
  todo: '01a14743-43f4-7053-a698-5b4ef36ed046',
  doing: '01a14743-43f5-759d-a00e-9ccda502cc88',
  done: '01a14743-43f5-759d-a00e-a20a36faa315',
  waitingAnswer: '01a14743-43f5-759d-a00e-a424b478f2fa',
  inReview: '01a14743-43f5-759d-a00e-a90831248ea5',
  blocked: '01a14743-43f5-759d-a00e-ada27e46c2f8',
  cancelled: '01a14743-43f5-759d-a00e-b0f2a5a04f4c',
} as const
