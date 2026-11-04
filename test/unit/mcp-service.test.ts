// MCP domain units (SPEC "MCP (registry + per-agent bindings)"): the dispatch
// builder (decrypt-at-dispatch, name-sorted, empty-headers wire law), the
// probe verdict persistence (BOTH outcomes, first-error-line detail), the
// verdict invalidation rules (url change clears the server's bindings, a
// credential change clears its own), and the registry in-use guard. The live
// bind→dispatch→revoke loop is pinned by e2e mcp-registry.spec.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  serverRows: [] as Array<Record<string, unknown>>,
  bindingRows: [] as Array<Record<string, unknown>>,
  aiRows: [] as Array<Record<string, unknown>>,
  secretRows: [] as Array<Record<string, unknown>>,
  inserts: [] as Array<{ table: string; values: Record<string, unknown> }>,
  updates: [] as Array<{ table: string; set: Record<string, unknown> }>,
  deletes: [] as Array<{ table: string }>,
  published: [] as Array<[string, string]>,
}));

vi.mock('../../server/db/index', async () => {
  const schema = await import('../../server/db/schema');
  const tableName = (t: unknown) =>
    t === schema.mcpServers
      ? 'mcpServers'
      : t === schema.mcpServerBindings
        ? 'mcpServerBindings'
        : t === schema.vaultSecrets
          ? 'vaultSecrets'
          : 'other';
  const rowsForTable = (t: unknown) =>
    t === schema.mcpServers
      ? h.serverRows
      : t === schema.mcpServerBindings
        ? h.bindingRows
        : t === schema.vaultSecrets
          ? h.secretRows
          : [];
  const filterBindings = (args?: { where?: Record<string, { eq?: string }> }) =>
    h.bindingRows.filter((r) => {
      const w = args?.where ?? {};
      const emp = w.employeeId?.eq;
      const srv = w.serverId?.eq;
      const id = w.id?.eq;
      return (!emp || r.employeeId === emp) && (!srv || r.serverId === srv) && (!id || r.id === id);
    });
  const moduleDb = {
    // registryUpdate commits its writes in a transaction — the mock runs the
    // callback against the same scripted db object (self-reference at CALL time)
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(moduleDb as unknown),
    query: new Proxy(
      {},
      {
        get: (_t, table: string) => ({
          findMany: async (args?: { where?: Record<string, { eq?: string }> }) => {
            if (table === 'mcpServers') return h.serverRows;
            if (table === 'mcpServerBindings') return filterBindings(args);
            if (table === 'aiEmployees') return h.aiRows;
            if (table === 'vaultSecrets') return h.secretRows;
            return [];
          },
        }),
      },
    ),
    select: () => ({
      // select().from(<table>) — rows resolved by table identity (the eq
      // predicates are opaque drizzle objects; scripted tables answer instead)
      from: (table: unknown) => {
        const rows = rowsForTable(table);
        return {
          where: () => ({
            limit: async () => rows,
            then: (res: (v: Array<Record<string, unknown>>) => unknown, rej: (e: unknown) => unknown) =>
              Promise.resolve(rows).then(res, rej),
          }),
        };
      },
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        h.inserts.push({ table: tableName(table), values });
        // append to the scripted table — the service re-reads after write;
        // bindings get their nested refs resolved like the real RQB would
        const row: Record<string, unknown> = {
          ...values,
          id: values.id ?? 'srv-new',
          createdAt: new Date(0),
          updatedAt: new Date(0),
        };
        if (table === schema.mcpServerBindings)
          h.bindingRows.push({
            ...row,
            server: h.serverRows.find((s) => s.id === row.serverId) ?? { name: '?', url: '?' },
            secret: h.secretRows.find((s) => s.id === row.secretId) ?? null,
          });
        else if (table === schema.mcpServers) h.serverRows.push(row);
        return { returning: async () => [row] };
      },
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: () => {
          // record ONCE whether the caller awaits the where() or calls returning()
          let recorded = false;
          const record = () => {
            if (recorded) return;
            recorded = true;
            h.updates.push({ table: tableName(table), set });
          };
          const promise = Promise.resolve().then(record);
          return Object.assign(promise, {
            returning: async () => {
              record();
              const rows = rowsForTable(table);
              return rows.length ? [rows[0]] : [];
            },
          });
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: () => ({
        returning: async () => {
          h.deletes.push({ table: tableName(table) });
          const rows = rowsForTable(table);
          return rows.length ? [{ id: rows[0]!.id }] : [];
        },
      }),
    }),
  };
  return { asDb: (x: unknown) => x, db: moduleDb };
});

vi.mock('../../server/domains/kernel/kernel', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/kernel/kernel')>();
  return {
    ...mod,
    publishChange: async (resource: string, action: string) => void h.published.push([resource, action]),
  };
});

vi.mock('../../server/domains/vault/secret/secret-crypto.service', () => ({
  decryptSecret: (ciphertext: string) => `dec:${ciphertext}`,
  encryptSecret: (v: string) => `enc:${v}`,
  lastFourHint: (v: string) => v.slice(-4),
}));

import { ORPCError } from '../../server/domains/kernel/kernel';
import {
  bindingsListByServer,
  bindingsRemove,
  bindingsSet,
  buildMcpServersFor,
  extractJsonRpc,
  mcpDispatchLine,
  probeMcpBinding,
  probeMcpHttp,
  registryCreate,
  registryRemove,
  registryUpdate,
} from '../../server/domains/mcp/mcp.service';

const server = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'srv-1',
  name: 'zeta',
  url: 'https://mcp.example/v1',
  notes: '',
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...over,
});

const binding = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'bnd-1',
  employeeId: 'ai-1',
  serverId: 'srv-1',
  secretId: 'sec-1',
  lastProbeOk: null,
  lastProbeDetail: null,
  lastProbeAt: null,
  server: { name: 'zeta', url: 'https://mcp.example/v1' },
  secret: { name: 'cred', lastFour: 'eken', ciphertext: 'cipher-1' },
  ...over,
});

beforeEach(() => {
  h.serverRows = [];
  h.bindingRows = [];
  h.aiRows = [];
  h.secretRows = [];
  h.inserts = [];
  h.updates = [];
  h.deletes = [];
  h.published = [];
});

describe('buildMcpServersFor (dispatch injection)', () => {
  it('no bindings = the spec-shape empty list', async () => {
    expect(await buildMcpServersFor('ai-1')).toEqual([]);
  });

  it('bindings serialize name-sorted http servers; credential decrypts verbatim into Authorization; uncredentialed = empty headers array', async () => {
    h.bindingRows = [
      binding({
        id: 'b-1',
        server: { name: 'zeta', url: 'https://z/v1' },
        secret: { name: 'c', lastFour: '1', ciphertext: 'zz' },
      }),
      binding({ id: 'b-2', serverId: 'srv-2', server: { name: 'alpha', url: 'https://a/v1' }, secret: null }),
    ];
    const out = await buildMcpServersFor('ai-1');
    expect(out.map((s) => s.name)).toEqual(['alpha', 'zeta']); // sorted asc
    expect(out[0]).toEqual({ type: 'http', name: 'alpha', url: 'https://a/v1', headers: [] });
    expect(out[1]).toEqual({
      type: 'http',
      name: 'zeta',
      url: 'https://z/v1',
      headers: [{ name: 'Authorization', value: 'dec:zz' }],
    });
  });

  it('mcpDispatchLine: null when empty, sorted names only (never credentials)', () => {
    expect(mcpDispatchLine([])).toBeNull();
    expect(mcpDispatchLine([{ name: 'b' }, { name: 'a' }])).toBe('[mcp] servers: a, b');
  });
});

describe('registry CRUD + guards', () => {
  it('create: 409 on name clash; insert + publish + mapped row', async () => {
    h.serverRows = [server()];
    await expect(registryCreate({ name: 'zeta', url: 'https://x/v1', notes: '' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    h.serverRows = [];
    const row = await registryCreate({ name: 'zeta', url: 'https://x/v1', notes: 'n' });
    expect(h.inserts).toHaveLength(1);
    expect(h.published).toEqual([['MCP', 'CREATE']]);
    expect(row).toMatchObject({ name: 'zeta', url: 'https://x/v1', notes: 'n', bindingCount: 0 });
  });

  it('update: url change clears every binding verdict of that server; name/notes-only edit keeps them', async () => {
    h.serverRows = [server()];
    h.bindingRows = [binding({ lastProbeOk: true, lastProbeDetail: 'initialize ok' })];
    await registryUpdate({ id: 'srv-1', url: 'https://moved/v1' });
    const clear = h.updates.find((u) => u.table === 'mcpServerBindings');
    expect(clear).toBeTruthy();
    expect(clear!.set).toEqual({ lastProbeOk: null, lastProbeDetail: null, lastProbeAt: null });
    expect(h.published).toEqual([['MCP', 'UPDATE']]);

    h.updates = [];
    h.published = [];
    await registryUpdate({ id: 'srv-1', notes: 'new note' });
    expect(h.updates.find((u) => u.table === 'mcpServerBindings')).toBeUndefined();
  });

  it('update: 404 when missing', async () => {
    await expect(registryUpdate({ id: 'gone', notes: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('remove: 400 while bindings exist (in-use guard); deletes + publishes when free; 404 when missing', async () => {
    h.serverRows = [server()];
    h.bindingRows = [binding()];
    await expect(registryRemove({ id: 'srv-1' })).rejects.toThrow('unbind first');
    expect(h.deletes).toHaveLength(0);
    h.bindingRows = [];
    expect(await registryRemove({ id: 'srv-1' })).toEqual({ ok: true });
    expect(h.published).toEqual([['MCP', 'DELETE']]);
    h.serverRows = [];
    await expect(registryRemove({ id: 'srv-1' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('bindings (upsert + unbind)', () => {
  it('set on a non-AI employee 400s', async () => {
    await expect(bindingsSet({ employeeId: 'human-1', serverId: 'srv-1' })).rejects.toThrow('not an AI agent');
  });

  it('set: new binding inserts; credential change clears the verdict; same credential keeps it', async () => {
    h.aiRows = [{ userId: 'ai-1' }];
    h.serverRows = [server()];
    h.secretRows = [{ id: 'sec-1' }];
    h.bindingRows = [];
    await bindingsSet({ employeeId: 'ai-1', serverId: 'srv-1', secretId: 'sec-1' });
    expect(h.inserts).toHaveLength(1);

    h.bindingRows = [binding({ lastProbeOk: true, lastProbeDetail: 'initialize ok' })];
    await bindingsSet({ employeeId: 'ai-1', serverId: 'srv-1', secretId: 'sec-2' });
    const cleared = h.updates.find((u) => u.table === 'mcpServerBindings');
    expect(cleared).toBeTruthy();
    expect(cleared!.set).toMatchObject({ secretId: 'sec-2', lastProbeOk: null, lastProbeDetail: null });

    h.updates = [];
    // the mock's update() records but doesn't mutate rows — apply the second
    // call's credential change by hand before the same-credential call
    (h.bindingRows[0] as Record<string, unknown>).secretId = 'sec-2';
    await bindingsSet({ employeeId: 'ai-1', serverId: 'srv-1', secretId: 'sec-2' });
    const kept = h.updates.filter((u) => u.table === 'mcpServerBindings').at(-1);
    expect(kept).toBeTruthy();
    expect(kept!.set.lastProbeOk).toBeUndefined();
  });

  it('set: unknown server/secret rejected', async () => {
    h.aiRows = [{ userId: 'ai-1' }];
    await expect(bindingsSet({ employeeId: 'ai-1', serverId: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    h.serverRows = [server()];
    await expect(bindingsSet({ employeeId: 'ai-1', serverId: 'srv-1', secretId: 'nope' })).rejects.toThrow(
      'credential secret not found',
    );
  });

  it('remove: unbind deletes + publishes; 404 when absent (unbind = revoke at next dispatch)', async () => {
    h.bindingRows = [binding()];
    expect(await bindingsRemove({ employeeId: 'ai-1', serverId: 'srv-1' })).toEqual({ ok: true });
    expect(h.published).toEqual([['MCP', 'DELETE']]);
    h.bindingRows = [];
    await expect(bindingsRemove({ employeeId: 'ai-1', serverId: 'srv-1' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('bindingsListByServer (per-server read, #274 registry-page surface)', () => {
  it("lists one server's bindings across agents keyed by employee name; other servers' rows excluded", async () => {
    h.bindingRows = [
      binding({ employee: { id: 'ai-1', name: 'Ash' } }),
      binding({
        id: 'bnd-2',
        employeeId: 'ai-2',
        secretId: null,
        secret: null,
        employee: { id: 'ai-2', name: 'Zed' },
      }),
      binding({ id: 'bnd-3', serverId: 'srv-9', employee: { id: 'ai-1', name: 'Ash' } }),
    ];
    const res = await bindingsListByServer('srv-1');
    expect(res.data.map((r) => [r.employeeName, r.secretName, r.lastFour])).toEqual([
      ['Ash', 'cred', 'eken'],
      ['Zed', null, null],
    ]);
    // write-only vault law: the masked read never carries the plaintext
    expect(JSON.stringify(res)).not.toContain('cipher-1');
  });
});

describe('probe (binding-level PROBE VERDICT LAW)', () => {
  it('200 JSON result: ok verdict persisted; Authorization rides the decrypted credential', async () => {
    h.bindingRows = [binding()];
    const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'ctx', version: '7' } } }), {
          status: 200,
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const r = await probeMcpBinding({ employeeId: 'ai-1', serverId: 'srv-1' });
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('initialize ok');
    expect(r.detail).toContain('ctx');
    const call = fetchMock.mock.calls[0];
    expect(call).toBeTruthy();
    const [url, init] = call!;
    expect(url).toBe('https://mcp.example/v1');
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('dec:cipher-1');
    expect(headers.accept).toBe('application/json, text/event-stream');
    expect(JSON.parse(String(init?.body)).method).toBe('initialize');
    const verdict = h.updates.find((u) => u.table === 'mcpServerBindings');
    expect(verdict?.set).toMatchObject({ lastProbeOk: true });
    expect(h.published).toEqual([['MCP', 'UPDATE']]);
  });

  it('SSE data-frame result parses; no credential bound = no authorization header', async () => {
    h.bindingRows = [binding({ secret: null })];
    const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(
        new Response('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"s"}}}\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const ok = await probeMcpBinding({ employeeId: 'ai-1', serverId: 'srv-1' });
    expect(ok.ok).toBe(true);
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    expect(h.updates.find((u) => u.table === 'mcpServerBindings')?.set).toMatchObject({ lastProbeOk: true });
  });

  it('failure verdicts persist too: HTTP 401, transport error first line, JSON-RPC error frame', async () => {
    h.bindingRows = [binding()];
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('denied', { status: 401 }))),
    );
    const denied = await probeMcpBinding({ employeeId: 'ai-1', serverId: 'srv-1' });
    expect(denied.ok).toBe(false);
    expect(denied.detail).toBe('HTTP 401');
    expect(h.updates.find((u) => u.table === 'mcpServerBindings')?.set).toMatchObject({ lastProbeOk: false });

    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('fetch failed\n    at Bun.swift'))),
    );
    const dead = await probeMcpBinding({ employeeId: 'ai-1', serverId: 'srv-1' });
    expect(dead.ok).toBe(false);
    expect(dead.detail).toBe('fetch failed'); // first line only — never a bare "unreachable"

    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'bad handshake' } }), {
            status: 200,
          }),
        ),
      ),
    );
    const refused = await probeMcpBinding({ employeeId: 'ai-1', serverId: 'srv-1' });
    expect(refused.ok).toBe(false);
    expect(refused.detail).toContain('bad handshake');
  });

  it('binding-less probe 404s; body without a JSON-RPC payload fails honestly', async () => {
    h.bindingRows = [];
    await expect(probeMcpBinding({ employeeId: 'ai-1', serverId: 'srv-1' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('<html>hello</html>', { status: 200 }))),
    );
    const r = await probeMcpHttp('https://mcp.example/v1');
    expect(r).toEqual({ ok: false, detail: 'no JSON-RPC payload in response' });
  });
});

describe('extractJsonRpc', () => {
  it('plain JSON, SSE frames, garbage', () => {
    expect(extractJsonRpc('{"jsonrpc":"2.0","id":1,"result":{}}')).toMatchObject({ result: {} });
    expect(extractJsonRpc('event: x\ndata: {"jsonrpc":"2.0","id":1,"error":{"code":1,"message":"m"}}')).toMatchObject({
      error: { message: 'm' },
    });
    expect(extractJsonRpc('<html/>')).toBeNull();
    expect(extractJsonRpc('data: {broken')).toBeNull();
  });
});

describe('ORPCError import sanity', () => {
  it('the kernel mock keeps the real error class', () => {
    expect(new ORPCError('NOT_FOUND', { message: 'x' }).code).toBe('NOT_FOUND');
  });
});
