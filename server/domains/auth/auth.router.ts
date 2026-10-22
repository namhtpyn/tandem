import { os } from '@orpc/server';

import { CHANGE_RESOURCE } from '#shared/enums';

// auth router — business logic lives in services/utils; this file only wires procedures
import { base, liveGenerator } from '../kernel/kernel';

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
});
