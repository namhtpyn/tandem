// Vault folders + employee title catalog: CRUD, guards, joins, rename cascade.
import { eq } from 'drizzle-orm';
import { describe, expect, it, beforeEach } from 'vitest';

import './helpers/pg';
import { ROLE } from '#shared/enums';
import { STATUS } from '#shared/status';

import './api-harness';

async function dbm() {
  return await import('#server/db');
}
async function schema() {
  return await import('#server/db/schema');
}

const admin = {
  user: {
    id: '00000000-0000-7000-8000-3f18cbc16519',
    name: 'Test Admin',
    email: 'test@tandem.local',
    role: ROLE.ADMIN,
  },
};

async function proc(path: string[], input?: unknown) {
  const { appRouter: router } = await import('#server/domains/app.router');
  const { buildServerContext } = await import('#server/domains/kernel/context');
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
  const { db } = await import('#server/db');
  const { user } = await import('#server/db/schema');
  await db
    .insert(user)
    .values({ id: admin.user.id, name: 'Admin', email: 'admin@tandem.local', role: ROLE.ADMIN, title: 'T' })
    .onConflictDoNothing();
});

describe('vault folders', () => {
  it('save creates, live lists with counts, remove clears', async () => {
    const { id } = (await proc(['vault', 'folders', 'save'], { name: 'Production keys' })) as { id: string };
    await proc(['vault', 'folders', 'save'], { name: 'CI tokens' });
    const listed = (await proc(['vault', 'folders', 'list'])) as
      | { folders: Array<{ name: string }> }
      | Array<{ name: string }>;
    const names = (Array.isArray(listed) ? listed : listed.folders).map((f) => f.name);
    const paged = (await proc(['vault', 'folders', 'listPaged'], { page: 1, pageSize: 5 })) as {
      folders: Array<{ name: string }>;
      total: number;
    };
    expect(paged.total).toBeGreaterThanOrEqual(2);
    expect(paged.folders.length).toBeLessThanOrEqual(5);
    const search = (await proc(['vault', 'folders', 'listPaged'], { page: 1, pageSize: 5, q: 'CI' })) as {
      folders: Array<{ name: string }>;
      total: number;
    };
    expect(search.folders.map((f) => f.name)).toEqual(['CI tokens']);
    expect(names).toEqual(['CI tokens', 'Production keys']);

    const options = (await proc(['vault', 'folders', 'options'], { page: 1, pageSize: 1 })) as {
      options: Array<{ id: string; name: string }>;
      total: number;
    };
    expect(options.total).toBe(2);
    expect(options.options.map((o) => o.name)).toEqual(['CI tokens']); // alphabetical, server-paged
    expect(options.options[0]).toEqual({ id: expect.any(String), name: 'CI tokens' }); // no secrets count key
    const searched = (await proc(['vault', 'folders', 'options'], { page: 1, pageSize: 5, q: 'PRODUC' })) as {
      options: Array<{ name: string }>;
      total: number;
    };
    expect(searched.total).toBe(1);
    expect(searched.options.map((o) => o.name)).toEqual(['Production keys']); // server-side q filter
    const page2 = (await proc(['vault', 'folders', 'options'], { page: 2, pageSize: 1 })) as {
      options: Array<{ name: string }>;
      total: number;
    };
    expect(page2.options.map((o) => o.name)).toEqual(['Production keys']);

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
    const snap = (await firstSnapshot(['vault', 'secrets', 'live'])) as {
      data: Array<{ id: string; folder: string | null }>;
    };
    let live = snap.data;
    expect(live.find((r) => r.id === created.id)?.folder).toBe('Prod');

    await proc(['vault', 'folders', 'remove'], { id });
    live = (
      (await firstSnapshot(['vault', 'secrets', 'live'])) as { data: Array<{ id: string; folder: string | null }> }
    ).data;
    expect(live.find((r) => r.id === created.id)?.folder).toBeNull();

    // update can move a secret into an existing folder
    const f2 = (await proc(['vault', 'folders', 'save'], { name: 'Other' })) as { id: string };
    await proc(['vault', 'secrets', 'update'], { id: created.id, name: 'aws-key', value: 'sk-2', folderId: f2.id });
    live = (
      (await firstSnapshot(['vault', 'secrets', 'live'])) as { data: Array<{ id: string; folder: string | null }> }
    ).data;
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
    expect(s.lastFour).toBe(''); // 8-char value: short secrets get NO hint
    const upd = (await proc(['vault', 'secrets', 'update'], { id: s.id, name: 'k-renamed', folderId: null })) as {
      lastFour: string;
    };
    expect(upd.lastFour).toBe(''); // hint unchanged => ciphertext untouched
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
    const live = (
      (await firstSnapshot(['vault', 'secrets', 'live'])) as { data: Array<{ id: string; folder: string | null }> }
    ).data;
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

describe('environments listPaged', () => {
  it('pages, searches (q over name/host/username), and reports total', async () => {
    for (const [i, name] of ['qa-alpha-host', 'qa-beta-host', 'unrelated'].entries()) {
      await proc(['environments', 'create'], {
        name,
        host: `10.0.0.${i + 1}`,
        port: '22',
        username: name === 'unrelated' ? 'deploy' : `qa${i}`,
      });
    }
    const page1 = (await proc(['environments', 'listPaged'], { page: 1, pageSize: 2 })) as {
      environments: Array<{ name: string }>;
      total: number;
    };
    expect(page1.total).toBe(3);
    expect(page1.environments).toHaveLength(2);

    const byName = (await proc(['environments', 'listPaged'], { page: 1, pageSize: 10, q: 'alpha' })) as {
      environments: Array<{ name: string }>;
      total: number;
    };
    expect(byName.total).toBe(1);
    expect(byName.environments[0]!.name).toBe('qa-alpha-host');

    const byHost = (await proc(['environments', 'listPaged'], { page: 1, pageSize: 10, q: '10.0.0.2' })) as {
      environments: Array<{ name: string }>;
      total: number;
    };
    expect(byHost.total).toBe(1);
    expect(byHost.environments[0]!.name).toBe('qa-beta-host');

    const byUser = (await proc(['environments', 'listPaged'], { page: 1, pageSize: 10, q: 'deploy' })) as {
      environments: Array<{ name: string }>;
      total: number;
    };
    expect(byUser.total).toBe(1);
    expect(byUser.environments[0]!.name).toBe('unrelated');

    const miss = (await proc(['environments', 'listPaged'], { page: 1, pageSize: 10, q: 'zzz' })) as { total: number };
    expect(miss.total).toBe(0);
  });

  it('environment input rejects ssh-unsafe usernames and hosts', async () => {
    // a leading dash would parse as an ssh option (-oProxyCommand=...)
    await expect(
      proc(['environments', 'create'], { name: 'evil', host: 'h', port: '22', username: '-oProxyCommand=x' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    // quotes/spaces in host would break argv + shell quoting downstream
    await expect(
      proc(['environments', 'create'], { name: 'evil', host: "ho'st sin", port: '22', username: 'u' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      proc(['environments', 'create'], { name: 'evil', host: '-bad-host', port: '22', username: 'u' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    // safe values still pass
    const ok = (await proc(['environments', 'create'], {
      name: 'safe',
      host: '10.0.0.9',
      port: '22',
      username: 'deploy.user',
    })) as { id: string };
    expect(ok.id).toBeTruthy();
  });
});

describe('employees listPaged', () => {
  it('pages, searches (q over name/email/title), and reports total', async () => {
    // the harness seeds a session admin user that would sit in every count — sweep users for exact totals
    const { db } = await import('#server/db');
    const { user } = await import('#server/db/schema');
    await db.delete(user);

    const { id: envId } = (await proc(['environments', 'create'], {
      name: 'pager-env',
      host: '10.9.9.9',
      port: '22',
      username: 'deploy',
    })) as { id: string };

    const alpha = (await proc(['employees', 'create'], {
      name: 'Page Alpha',
      email: 'alpha@t.local',
      title: 'Engineer',
      kind: 'human',
    })) as { id: string };
    await proc(['employees', 'create'], {
      name: 'Page Beta',
      email: 'beta-page@t.local',
      title: 'Designer',
      kind: 'human',
      supervisorIds: [alpha.id],
    });
    await proc(['employees', 'create'], {
      name: 'Gamma Rematch',
      email: 'gamma@t.local',
      title: 'Wizard',
      kind: 'ai',
      environmentId: envId,
      executable: 'hermes acp',
    });

    const page1 = (await proc(['employees', 'listPaged'], { page: 1, pageSize: 2 })) as {
      employees: Array<{ id: string }>;
      total: number;
    };
    expect(page1.total).toBe(3);
    expect(page1.employees).toHaveLength(2);

    const page2 = (await proc(['employees', 'listPaged'], { page: 2, pageSize: 2 })) as {
      employees: Array<{ id: string }>;
      total: number;
    };
    expect(page2.employees).toHaveLength(1);

    const byName = (await proc(['employees', 'listPaged'], { page: 1, pageSize: 10, q: 'alpha' })) as {
      employees: Array<{ name: string; kind: string }>;
      total: number;
    };
    expect(byName.total).toBe(1);
    expect(byName.employees[0]!.name).toBe('Page Alpha');

    const byEmail = (await proc(['employees', 'listPaged'], { page: 1, pageSize: 10, q: 'beta-page' })) as {
      employees: Array<{ name: string; supervisorIds: string[] }>;
      total: number;
    };
    expect(byEmail.total).toBe(1);
    expect(byEmail.employees[0]!.name).toBe('Page Beta');
    // paged rows carry the same supervision mapping as the snapshot
    expect(byEmail.employees[0]!.supervisorIds).toEqual([alpha.id]);

    const byTitle = (await proc(['employees', 'listPaged'], { page: 1, pageSize: 10, q: 'wizar' })) as {
      employees: Array<{ name: string; kind: string; executable: string | null }>;
      total: number;
    };
    expect(byTitle.total).toBe(1);
    expect(byTitle.employees[0]!.name).toBe('Gamma Rematch');
    // AI extension mapped identically on paged rows
    expect(byTitle.employees[0]!.kind).toBe('ai');
    expect(byTitle.employees[0]!.executable).toBe('hermes acp');

    const miss = (await proc(['employees', 'listPaged'], { page: 1, pageSize: 10, q: 'zzz' })) as { total: number };
    expect(miss.total).toBe(0);
  });
});

describe('tasks listPaged', () => {
  it('pages, searches (q over title/description), filters by status and inbox, and reports total', async () => {
    const alpha = (await proc(['tasks', 'create'], { title: 'Pager Alpha', description: 'first' })) as { id: string };
    // beta starts in doing WITH an assignee so `ask` can route a question to the owner (= admin)
    const beta = (await proc(['tasks', 'create'], {
      title: 'Pager Beta',
      description: 'zebra sweep',
      assigneeId: admin.user.id,
    })) as { id: string };
    // doing is workflow-only now: create lands in a ready status, then the test moves it directly
    {
      const { db } = await dbm();
      const { tasks } = await schema();
      await db.update(tasks).set({ status: STATUS.doing }).where(eq(tasks.id, beta.id));
    }
    await proc(['tasks', 'create'], { title: 'Unrelated note' });

    const page1 = (await proc(['tasks', 'listPaged'], { page: 1, pageSize: 2 })) as {
      data: Array<{ id: string }>;
      total: number;
    };
    expect(page1.total).toBe(3);
    expect(page1.data).toHaveLength(2);

    const byTitle = (await proc(['tasks', 'listPaged'], { page: 1, pageSize: 10, q: 'alpha' })) as {
      data: Array<{ id: string; title: string }>;
      total: number;
    };
    expect(byTitle.total).toBe(1);
    expect(byTitle.data[0]!.id).toBe(alpha.id);

    const byDescription = (await proc(['tasks', 'listPaged'], { page: 1, pageSize: 10, q: 'zebra' })) as {
      data: Array<{ id: string }>;
      total: number;
    };
    expect(byDescription.total).toBe(1);
    expect(byDescription.data[0]!.id).toBe(beta.id);

    const miss = (await proc(['tasks', 'listPaged'], { page: 1, pageSize: 10, q: 'zzz' })) as { total: number };
    expect(miss.total).toBe(0);

    const doing = (await proc(['tasks', 'listPaged'], { page: 1, pageSize: 10, statusId: STATUS.doing })) as {
      data: Array<{ id: string; assigneeName: string | null; reviewerNames: string[]; createdAt: string }>;
      total: number;
    };
    expect(doing.total).toBe(1);
    expect(doing.data.map((t) => t.id)).toEqual([beta.id]);
    // paged rows carry the same snapshot mapping (names joined, ISO dates)
    expect(doing.data[0]).toMatchObject({
      assigneeName: 'Admin',
      reviewerNames: [],
      createdAt: expect.any(String),
    });

    // combined filters land in the same AND group
    const combo = (await proc(['tasks', 'listPaged'], { q: 'Pager', statusId: STATUS.doing })) as { total: number };
    expect(combo.total).toBe(1);
    const comboMiss = (await proc(['tasks', 'listPaged'], { q: 'Unrelated', statusId: STATUS.doing })) as {
      total: number;
    };
    expect(comboMiss.total).toBe(0);

    // inboxOfMe with NO pending obligations on the caller → empty set short-circuit
    const emptyInbox = (await proc(['tasks', 'listPaged'], { page: 1, pageSize: 10, inboxOfMe: true })) as {
      data: unknown[];
      total: number;
    };
    expect(emptyInbox).toEqual({ data: [], total: 0 });

    // a pending obligation on the caller (beta is doing + assigned → ask spawns it on the owner)
    await proc(['tasks', 'ask'], { taskId: beta.id, body: 'which db?' });
    const inbox = (await proc(['tasks', 'listPaged'], { page: 1, pageSize: 10, inboxOfMe: true })) as {
      data: Array<{ id: string }>;
      total: number;
    };
    expect(inbox.total).toBe(1);
    expect(inbox.data.map((t) => t.id)).toEqual([beta.id]);
    // semantics equal the inbox proc's taskId set
    const inboxProc = (await proc(['tasks', 'inbox'])) as { items: Array<{ taskId: string }> };
    expect(new Set(inboxProc.items.map((i) => i.taskId))).toEqual(new Set(inbox.data.map((t) => t.id)));
  });
});
