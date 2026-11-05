import { os } from '@orpc/server';
// channels router — admin settings surface for the `channels` settings key
// (SPEC: Channel settings UI). Validation lives in the channels service's
// per-entry inspection (single source of truth shared with the runtime
// parser); this file wires the procedures.
import { inArray } from 'drizzle-orm';
import { z } from 'zod';

import { CHANGE_ACTION, CHANGE_RESOURCE } from '#shared/enums';

import { db } from '../../db/index';
import { user as userTable, vaultSecrets as vaultSecretsTable } from '../../db/schema';
import { ORPCError, adminProcedure, publishChange } from '../kernel/kernel';
import { getSetting, setSetting } from '../settings/settings.service';
import { registeredChannelKinds } from './adapter';
import {
  CHANNELS_HEALTH_KEY,
  CHANNELS_KEY,
  channelConfigSchema,
  inspectChannelConfigs,
  onChannelsSettingsChanged,
} from './channels.service';

export const channelsRouter = os.router({
  /** stored entries with per-entry status (ok/dropped + reason), registered
   * kinds and the latest health stamp — dropped configs are visible in the
   * UI, not only in watchdog stamps. Admin-only (config is admin-managed). */
  list: adminProcedure.handler(async () => {
    const raw = await getSetting(CHANNELS_KEY);
    const insp = inspectChannelConfigs(raw);
    const healthRaw = await getSetting(CHANNELS_HEALTH_KEY);
    let health: unknown = null;
    if (healthRaw) {
      try {
        health = JSON.parse(healthRaw);
      } catch {
        health = null; // a corrupt stamp is the watchdog's problem, not the UI's
      }
    }
    return {
      kinds: registeredChannelKinds(),
      corrupt: insp.corrupt,
      entries: insp.entries.map((e) => ({ status: e.status, reason: e.reason, entry: e.cfg, raw: e.raw })),
      health,
    };
  }),

  /** REPLACE the whole stored array. STRICT admin-path validation: an invalid
   * entry is refused with its reason and NOTHING is written (the runtime
   * parser's tolerant skip is the safety net for hand-edited values, never
   * the UI path's behavior). Same rules, same inspection code path. */
  update: adminProcedure
    .input(z.strictObject({ channels: z.array(channelConfigSchema.strict()) }))
    .handler(async ({ input }) => {
      // ---- validate FIRST: no row is written until every check has passed ----
      // strict refuse rides the SAME inspection the runtime parser uses
      const insp = inspectChannelConfigs(JSON.stringify(input.channels));
      const dropped = insp.entries.filter((e) => e.status === 'dropped');
      if (dropped.length > 0) {
        throw new ORPCError('BAD_REQUEST', {
          message: dropped.map((e) => e.reason).join(' | '),
        });
      }
      const cfgs = insp.entries.flatMap((e) => (e.cfg ? [e.cfg] : []));

      // existence checks beyond parser parity: the token secret must exist in
      // the vault, binding user ids and the default assignee must be existing
      // users (a config the parser accepts but that can never route is refused)
      const secretIds = [...new Set(cfgs.map((c) => c.tokenSecretId))];
      const secRows = await db
        .select({ id: vaultSecretsTable.id })
        .from(vaultSecretsTable)
        .where(inArray(vaultSecretsTable.id, secretIds));
      const secSet = new Set(secRows.map((s) => s.id));
      const userIds = [
        ...new Set(
          cfgs.flatMap((c) => [
            ...c.bindings.map((b) => b.userId),
            ...(c.defaultAssigneeId ? [c.defaultAssigneeId] : []),
          ]),
        ),
      ];
      const userRows = userIds.length
        ? await db.select({ id: userTable.id }).from(userTable).where(inArray(userTable.id, userIds))
        : [];
      const userSet = new Set(userRows.map((u) => u.id));
      for (const [i, c] of cfgs.entries()) {
        if (!secSet.has(c.tokenSecretId)) {
          throw new ORPCError('BAD_REQUEST', {
            message: `channel ${i + 1} (${c.kind} @ ${c.homeserverUrl}): token secret not found in vault`,
          });
        }
        for (const b of c.bindings) {
          if (!userSet.has(b.userId)) {
            throw new ORPCError('BAD_REQUEST', {
              message: `channel ${i + 1} (${c.kind} @ ${c.homeserverUrl}): binding user ${b.userId} not found`,
            });
          }
        }
        if (c.defaultAssigneeId && !userSet.has(c.defaultAssigneeId)) {
          throw new ORPCError('BAD_REQUEST', {
            message: `channel ${i + 1} (${c.kind} @ ${c.homeserverUrl}): default assignee not found`,
          });
        }
      }

      // ---- commit: the canonicalized array is what runs, so it is what is
      // stored (integrity validator: every entry still matches the schema) ----
      await setSetting(CHANNELS_KEY, JSON.stringify(cfgs));

      // ---- side effects AFTER commit: adapters re-arm in-process against the
      // committed value; a config change never needs a restart ----
      await onChannelsSettingsChanged();
      await publishChange(CHANGE_RESOURCE.SETTINGS, CHANGE_ACTION.UPDATE);
      return { ok: true, channels: cfgs };
    }),
});
