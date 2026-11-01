import { ORPCError, os } from '@orpc/server';
import { z } from 'zod';

import { CHANGE_RESOURCE } from '#shared/enums';

// auth router — business logic lives in services/utils; this file only wires procedures
import { base, liveGenerator, lockedSessionProcedure } from '../kernel/kernel';

async function resolveAuthConfig() {
  const { resolveAuthPolicy } = await import('./auth.service');
  const { getSettings } = await import('../settings/settings.service');
  const [p, s] = await Promise.all([resolveAuthPolicy(), getSettings()]);
  return {
    passwordEnabled: p.passwordEnabled,
    oidcEnabled: p.oidcEnabled,
    providers: p.oidcProviders.map((x) => ({ id: x.id, label: x.label })),
    companyName: s.companyName,
  };
}

export const authRouter = os.router({
  /** public auth capabilities (plain GET — first-load data per the SSE law) */
  config: base.handler(() => resolveAuthConfig()),

  /** live auth capabilities (SSE updater only) */
  configLive: base.handler(() => liveGenerator([CHANGE_RESOURCE.SETTINGS, CHANGE_RESOURCE.OIDC], resolveAuthConfig)),

  /** current session (null when anonymous) */
  session: base.handler(async ({ context }) => {
    const session = await context.getSession();
    return session;
  }),

  /**
   * ROTATION LOCK completion (SPEC "Boot seed law") — the one procedure a
   * rotation-locked session may call: verifies the current credential, sets
   * the new one and clears must_change_password in one transaction.
   */
  changeMyPassword: lockedSessionProcedure
    .input(
      z.object({
        currentPassword: z.string().min(1),
        newPassword: z.string().min(8),
      }),
    )
    .handler(async ({ context, input }) => {
      const { changeMyPassword } = await import('./auth.service');
      const session = await context.getSession();
      if (!session) throw new ORPCError('UNAUTHORIZED', { message: 'authentication required' });
      const result = await changeMyPassword({
        userId: session.user.id,
        currentPassword: input.currentPassword,
        newPassword: input.newPassword,
      });
      if (!result.ok) {
        if (result.reason === 'WRONG_PASSWORD' || result.reason === 'NO_CREDENTIAL') {
          throw new ORPCError('FORBIDDEN', { message: 'current password is incorrect' });
        }
        throw new ORPCError('BAD_REQUEST', { message: 'new password must be at least 8 characters' });
      }
      return { ok: true };
    }),
});
