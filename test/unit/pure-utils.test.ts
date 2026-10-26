// Pure helpers: vault secret picker grouping + avatar endpoint (REST).
import { beforeEach, describe, expect, it } from 'vitest';


import './api-harness';
import { groupedSecretOptions } from '../../app/utils/vault-options.ts';

beforeEach(async () => {
});

describe('groupedSecretOptions', () => {
  it('groups by folder, folders first alphabetically, loose secrets last', () => {
    const out = groupedSecretOptions([
      { id: 's2', name: 'aws', lastFour: '1234', folder: 'Prod' },
      { id: 's1', name: '00000000-0000-7000-8000-5821b64a4515', lastFour: '', folder: null },
      { id: 's3', name: 'anthropic', lastFour: '9999', folder: 'AI' },
    ]);
    expect(out).toEqual([
      { label: 'AI', type: 'label' },
      { label: 'anthropic (•••• 9999)', value: 's3' },
      { label: 'Prod', type: 'label' },
      { label: 'aws (•••• 1234)', value: 's2' },
      { label: 'No folder', type: 'label' },
      { label: '00000000-0000-7000-8000-5821b64a4515', value: 's1' },
    ]);
  });

  it('sorts secrets by name inside folders', () => {
    const out = groupedSecretOptions([
      { id: 'b', name: 'beta', lastFour: '', folder: 'F' },
      { id: 'a', name: 'alpha', lastFour: '', folder: 'F' },
    ]);
    expect(out.map((o) => ('value' in o ? o.value : o.label))).toEqual(['F', 'a', 'b']);
  });

  it('empty rows -> empty list', () => {
    expect(groupedSecretOptions([])).toEqual([]);
  });
});

describe('avatar endpoint', () => {
  it('401s without a session before touching the database', async () => {
    const { default: avatarEndpoint } = await import('#server/routes/api/employees/[id]/avatar.get');
    const { buildServerContext } = await import('#server/domains/kernel/context');
    const { getAuth } = await import('#server/domains/auth/auth.service');
    // api-harness mocks getSession to a test admin — undo that for this case
    const auth = await getAuth();
    const realGetSession = auth.api.getSession;
    (auth.api as unknown as { getSession: unknown }).getSession = async () => null;
    const event = {
      context: { sessions: {} },
      node: {
        req: { method: 'GET', url: '/api/employees/00000000-0000-7000-8000-21b2d09f5631/avatar', headers: {} },
        res: {},
      },
      path: '/api/employees/x/avatar',
      params: { id: 'x' },
      headers: {},
      /* the handler reads headers via getRequestHeaders + builds its own context */
      get headers() {
        return {};
      },
      method: 'GET',
    };
    try {
      await expect(avatarEndpoint(event as never)).rejects.toMatchObject({ statusCode: 401 });
    } finally {
      (auth.api as unknown as { getSession: unknown }).getSession = realGetSession;
    }
    void buildServerContext;
  });

  it('serves the stored avatar with etag + 304 revalidation', async () => {
    const { default: avatarEndpoint } = await import('#server/routes/api/employees/[id]/avatar.get');
    const { db } = await import('#server/db');
    const { user } = await import('#server/db/schema');
    const png =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    await db.insert(user).values({
      id: '00000000-0000-7000-8000-e08464d93cf8',
      name: 'Av',
      email: 'av@tandem.local',
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      image: png,
    });
    const headersOut: Array<[string, string]> = [];
    const state = { status: 200 };
    const mkEvent = (headers: Record<string, string> = {}) => ({
      node: {
        req: { method: 'GET', url: '/api/employees/u-av/avatar', headers },
        res: {
          setHeader: (k: string, v: string) => {
            headersOut.push([k, String(v)]);
          },
          get statusCode() {
            return state.status;
          },
          set statusCode(code: number) {
            state.status = code;
          },
        },
      },
      context: { params: { id: '00000000-0000-7000-8000-e08464d93cf8' } },
      get headers() {
        return headers;
      },
      method: 'GET',
    });
    const h3 = await import('h3');
    void h3;
    // 200 first
    const body = await avatarEndpoint(mkEvent({}) as never);
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(body.length).toBeGreaterThan(10);
    const etag = headersOut.find(([k]) => k === 'etag')?.[1];
    expect(etag).toBeTruthy();
    expect(headersOut.some(([k, v]) => k === 'cache-control' && v.includes('immutable'))).toBe(true);
    // nosniff always rides success responses
    expect(headersOut.some(([k, v]) => k === 'x-content-type-options' && v === 'nosniff')).toBe(true);
    // 304 with matching If-None-Match
    headersOut.length = 0;
    state.status = 200;
    const empty = await avatarEndpoint(mkEvent({ 'if-none-match': etag! }) as never);
    expect(empty).toBe('');
    expect(state.status).toBe(304);
    expect(headersOut.some(([k, v]) => k === 'x-content-type-options' && v === 'nosniff')).toBe(true);
  });

  it('passes request headers through to the session lookup', async () => {
    const { default: avatarEndpoint } = await import('#server/routes/api/employees/[id]/avatar.get');
    const state = { status: 200 };
    const headersOut: Array<[string, string]> = [];
    const reqHeaders = { 'x-multi': ['a', 'b'], 'x-single': 'v' };
    const event = {
      req: { headers: reqHeaders },
      node: {
        req: { method: 'GET', url: '/api/employees/00000000-0000-7000-8000-21b2d09f5631/avatar', headers: reqHeaders },
        res: {
          setHeader: (k: string, v: string) => {
            headersOut.push([k, String(v)]);
          },
          get statusCode() {
            return state.status;
          },
          set statusCode(code: number) {
            state.status = code;
          },
        },
      },
      context: { params: { id: '00000000-0000-7000-8000-21b2d09f5631' } },
      get headers() {
        return { 'x-multi': ['a', 'b'], 'x-single': 'v' };
      },
      method: 'GET',
    };
    // harness session resolves (admin) — array headers joined fine, so we land past
    // the guard at the data lookup: unknown user -> 404 'no avatar'
    await expect(avatarEndpoint(event as never)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('404s on a missing avatar, a non-data-url image, and a non-raster (svg) type', async () => {
    const { default: avatarEndpoint } = await import('#server/routes/api/employees/[id]/avatar.get');
    const { db } = await import('#server/db');
    const { user } = await import('#server/db/schema');
    await db.insert(user).values({
      id: '00000000-0000-7000-8000-18e469eaa1e6',
      name: 'No',
      email: 'no@tandem.local',
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(user).values({
      id: '00000000-0000-7000-8000-debca3b3ac2b',
      name: 'Bad',
      email: 'bad@tandem.local',
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      image: 'http://example.com/x.png',
    });
    await db.insert(user).values({
      id: '00000000-0000-7000-8000-3f2dfe4447ca',
      name: 'Svg',
      email: 'svg@tandem.local',
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      image: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    });
    const mkEvent = (id: string) => ({
      node: { req: { method: 'GET', url: `/api/employees/${id}/avatar`, headers: {} }, res: {} },
      context: { params: { id } },
      get headers() {
        return {};
      },
      method: 'GET',
    });
    await expect(avatarEndpoint(mkEvent('00000000-0000-7000-8000-18e469eaa1e6') as never)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(avatarEndpoint(mkEvent('00000000-0000-7000-8000-debca3b3ac2b') as never)).rejects.toMatchObject({
      statusCode: 404,
    });
    // svg+xml (and every other non-raster type) is rejected at the serve edge too
    await expect(avatarEndpoint(mkEvent('00000000-0000-7000-8000-3f2dfe4447ca') as never)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(avatarEndpoint(mkEvent('00000000-0000-7000-8000-21b2d09f5631') as never)).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
