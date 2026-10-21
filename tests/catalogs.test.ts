// Vault folders + employee title catalog: CRUD, guards, joins, rename cascade.
import { describe, expect, it, beforeEach } from 'vitest';

import './helpers/pg';
import { applyMigrations } from '../server/db/index';
import { ROLE } from '../shared/enums';
import './api-harness';
import { resetSchema } from './helpers/pg';

const admin = {
  user: {
    id: '00000000-0000-7000-8000-3f18cbc16519',
    name: 'Test Admin',
    email: 'test@tandem.local',
    role: ROLE.ADMIN,
  },
};

async function proc(path: string[], input?: unknown) {
  const { appRouter: router } = await import('../server/domains/app.router');
  const { buildServerContext } = await import('../server/domains/kernel/context');
  let node: Record<string, unknown> = router as unknown as Record<string, unknown>;
  for (const k of path) node = node[k] as Record<string, unknown>;
  const context = buildServerContext(new Headers());
  (context as unknown as { getSession: () => Promise<unknown> }).getSession = async () => admin;
  (context as unknown as { session: typeof admin }).session = admin;
  const { call } = await import('@orpc/server');
  return await call(node as unknown as Parameters<typeof call>[0], input ?? {}, {
    context,
    signal: new AbortController().signal,
  });
}

async function firstSnapshot(path: string[]) {
  const gen = (await proc(path)) as AsyncGenerator<unknown>;
  const first = (await gen.next()).value;
  await gen.return?.();
  return first;
}

beforeEach(async () => {
  await resetSchema();
  await applyMigrations();
  const { db } = await import('../server/db');
  const { user } = await import('../server/db/schema');
  await db
    .insert(user)
    .values({ id: admin.user.id, name: 'Admin', email: 'admin@tandem.local', role: ROLE.ADMIN, title: 'T' })
    .onConflictDoNothing();
});

describe('vault folders', () => {
  it('save creates, live lists with counts, remove clears', async () => {
    const { id } = (await proc(['vault', 'folders', 'save'], { name: 'Production keys' })) as { id: string };
    await proc(['vault', 'folders', 'save'], { name: 'CI tokens' });
    const listed = (await proc(['vault', 'folders', 'list'])) as { folders: Array<{ name: string }> } | Array<{ name: string }>;
    const names = (Array.isArray(listed) ? listed : listed.folders).map((f) => f.name);
    expect(names).toEqual(['CI tokens', 'Production keys']);

    const live = (await firstSnapshot(['vault', 'folders', 'live'])) as {
      folders: Array<{ id: string; name: string; secrets: number }>;
    };
    expect(live.folders.map((f) => f.name)).toEqual(['CI tokens', 'Production keys']); // alphabetical
    expect(live.folders.every((f) => f.secrets === 0)).toBe(true);

    const secret = (await proc(['vault', 'secrets', 'create'], { name: 'aws', value: 'sk-1', folderId: id })) as {
      id: string;
    };
    void secret;
    const live2 = (await firstSnapshot(['vault', 'folders', 'live'])) as {
      folders: Array<{ name: string; secrets: number }>;
    };
    expect(live2.folders.find((f) => f.name === 'Production keys')?.secrets).toBe(1);

    await proc(['vault', 'folders', 'remove'], { id });
    const live3 = (await firstSnapshot(['vault', 'folders', 'live'])) as { folders: Array<{ name: string }> };
    expect(live3.folders.map((f) => f.name)).toEqual(['CI tokens']);
  });

  it('duplicate folder names ALLOWED; unknown ids rejected', async () => {
    await proc(['vault', 'folders', 'save'], { name: 'X' });
    // unique dropped (2026-10-16): same-name folders are two distinct rows
    const again = (await proc(['vault', 'folders', 'save'], { name: 'X' })) as { id: string };
    const live = (await firstSnapshot(['vault', 'folders', 'live'])) as {
      folders: Array<{ id: string; name: string }>;
    };
    expect(live.folders.filter((f) => f.name === 'X')).toHaveLength(2);
    await expect(proc(['vault', 'folders', 'save'], { id: 'ghost', name: 'Y' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(proc(['vault', 'folders', 'remove'], { id: 'ghost' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    void again;
  });

  it('secrets survive folder deletion (FK SET NULL) and live rows carry folder name', async () => {
    const { id } = (await proc(['vault', 'folders', 'save'], { name: 'Prod' })) as { id: string };
    const created = (await proc(['vault', 'secrets', 'create'], { name: 'aws-key', value: 'sk-1', folderId: id })) as {
      id: string;
    };
    const snap = (await firstSnapshot(['vault', 'secrets', 'live'])) as { data: Array<{ id: string; folder: string | null }> };
    let live = snap.data;
    expect(live.find((r) => r.id === created.id)?.folder).toBe('Prod');

    await proc(['vault', 'folders', 'remove'], { id });
    live = ((await firstSnapshot(['vault', 'secrets', 'live'])) as { data: Array<{ id: string; folder: string | null }> }).data;
    expect(live.find((r) => r.id === created.id)?.folder).toBeNull();

    // update can move a secret into an existing folder
    const f2 = (await proc(['vault', 'folders', 'save'], { name: 'Other' })) as { id: string };
    await proc(['vault', 'secrets', 'update'], { id: created.id, name: 'aws-key', value: 'sk-2', folderId: f2.id });
    live = ((await firstSnapshot(['vault', 'secrets', 'live'])) as { data: Array<{ id: string; folder: string | null }> }).data;
    expect(live.find((r) => r.id === created.id)?.folder).toBe('Other');
  });

  it('secret create/update reject a folderId that does not exist', async () => {
    await expect(
      proc(['vault', 'secrets', 'create'], { name: 'x', value: 'v', folderId: 'ghost' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const s = (await proc(['vault', 'secrets', 'create'], { name: 'y', value: 'v' })) as { id: string };
    await expect(
      proc(['vault', 'secrets', 'update'], { id: s.id, name: 'y', value: 'v2', folderId: 'ghost' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('metadata-only update keeps the stored secret (empty value)', async () => {
    const { id } = (await proc(['vault', 'folders', 'save'], { name: 'Keep' })) as { id: string };
    const s = (await proc(['vault', 'secrets', 'create'], { name: 'k', value: 'secret-1', folderId: id })) as {
      id: string;
      lastFour: string;
    };
    expect(s.lastFour).toBe('et-1');
    const upd = (await proc(['vault', 'secrets', 'update'], { id: s.id, name: 'k-renamed', folderId: null })) as {
      lastFour: string;
    };
    expect(upd.lastFour).toBe('et-1'); // hint unchanged => ciphertext untouched
    // rotating still works
    const rot = (await proc(['vault', 'secrets', 'update'], {
      id: s.id,
      name: 'k-renamed',
      value: 'secret-2-xyz',
      folderId: null,
    })) as { lastFour: string };
    expect(rot.lastFour).toBe('-xyz');
  });

  it('folder rename is reflected in joined secret rows', async () => {
    const { id } = (await proc(['vault', 'folders', 'save'], { name: 'Before' })) as { id: string };
    const s = (await proc(['vault', 'secrets', 'create'], { name: 'k', value: 'v', folderId: id })) as { id: string };
    await proc(['vault', 'folders', 'save'], { id, name: 'After' });
    const live = ((await firstSnapshot(['vault', 'secrets', 'live'])) as { data: Array<{ id: string; folder: string | null }> }).data;
    expect(live.find((r) => r.id === s.id)?.folder).toBe('After');
  });
});

describe('employee titles', () => {
  it('save creates, live lists with counts, remove clears', async () => {
    const { id } = (await proc(['employees', 'titles', 'save'], { name: 'Senior Engineer' })) as { id: string };
    await proc(['employees', 'titles', 'save'], { name: 'Accountant' });
    const live = (await firstSnapshot(['employees', 'titles', 'live'])) as {
      titles: Array<{ name: string; employees: number }>;
    };
    expect(live.titles.map((t) => t.name)).toEqual(['Accountant', 'Senior Engineer']);

    // one employee holding the title bumps the count
    const emp = (await proc(['employees', 'create'], {
      name: 'Jane',
      email: 'jane@t.local',
      title: 'Senior Engineer',
      kind: 'human',
    })) as { id: string };
    void emp;
    const live2 = (await firstSnapshot(['employees', 'titles', 'live'])) as {
      titles: Array<{ name: string; employees: number }>;
    };
    expect(live2.titles.find((t) => t.name === 'Senior Engineer')?.employees).toBe(1);

    await proc(['employees', 'titles', 'remove'], { id });
    const live3 = (await firstSnapshot(['employees', 'titles', 'live'])) as { titles: Array<{ name: string }> };
    expect(live3.titles.map((t) => t.name)).toEqual(['Accountant']);
    // employee keeps the free-text title after catalog removal
    const empLive = (await firstSnapshot(['employees', 'live'])) as Array<{ id: string; title: string | null }>;
    expect(empLive.find((e) => e.id === emp.id)?.title).toBe('Senior Engineer');
  });

  it('duplicate name rejected; unknown ids rejected', async () => {
    await proc(['employees', 'titles', 'save'], { name: 'X' });
    await expect(proc(['employees', 'titles', 'save'], { name: 'X' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(proc(['employees', 'titles', 'save'], { id: 'ghost', name: 'Y' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(proc(['employees', 'titles', 'remove'], { id: 'ghost' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rename cascades to employees holding the old title', async () => {
    const { id } = (await proc(['employees', 'titles', 'save'], { name: 'Old Title' })) as { id: string };
    const e1 = (await proc(['employees', 'create'], {
      name: 'A',
      email: 'a@t.local',
      title: 'Old Title',
      kind: 'human',
    })) as { id: string };
    const e2 = (await proc(['employees', 'create'], {
      name: 'B',
      email: 'b@t.local',
      title: 'Old Title',
      kind: 'human',
    })) as { id: string };
    await proc(['employees', 'titles', 'save'], { id, name: 'New Title' });
    const live = (await firstSnapshot(['employees', 'live'])) as Array<{ id: string; title: string | null }>;
    expect(live.find((e) => e.id === e1.id)?.title).toBe('New Title');
    expect(live.find((e) => e.id === e2.id)?.title).toBe('New Title');
    // employees with other/empty titles untouched
    const e3 = (await proc(['employees', 'create'], {
      name: 'C',
      email: 'c@t.local',
      title: 'Unrelated Role',
      kind: 'human',
    })) as { id: string };
    const live2 = (await firstSnapshot(['employees', 'live'])) as Array<{ id: string; title: string | null }>;
    expect(live2.find((e) => e.id === e3.id)?.title).toBe('Unrelated Role');
  });
});
