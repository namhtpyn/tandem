import {
  relationsFilterToSQL,
  sql,
  type AnyRelationsFilter,
  type AnyTableFilter,
  type DBQueryConfig,
  type BuildQueryResult,
  type KnownKeysOnly,
  type RelationsFilter,
  type TableRelationalConfig,
  type TablesRelationalConfig,
} from 'drizzle-orm'
import { RelationalQueryBuilder } from 'drizzle-orm/pg-core/query-builders/query'

export interface FindManyAndCountResult<T> {
  data: T[]
  total: number
}

interface CountQueryPromise extends PromiseLike<number> {
  toSQL: () => { params: unknown[], sql: string }
}

interface FindManyAndCountQueryPromise<T> extends PromiseLike<FindManyAndCountResult<T>> {
  toSQL: () => {
    count: { params: unknown[], sql: string },
    findMany: { params: unknown[], sql: string },
  }
}

type AnyBuilder = RelationalQueryBuilder<TablesRelationalConfig, TableRelationalConfig>
type AnyFilter = AnyRelationsFilter | AnyTableFilter

declare module 'drizzle-orm/pg-core/query-builders/query' {
  export interface RelationalQueryBuilder<
    TSchema extends TablesRelationalConfig,
    TFields extends TableRelationalConfig,
  > {
    count: (filter?: RelationsFilter<TFields, TSchema>) => CountQueryPromise
    findManyAndCount: <TConfig extends DBQueryConfig<'many', TSchema, TFields>>(
      config?: KnownKeysOnly<TConfig, DBQueryConfig<'many', TSchema, TFields>>,
    ) => FindManyAndCountQueryPromise<BuildQueryResult<TSchema, TFields, TConfig>>
  }
}

interface BuilderCtx {
  table: Parameters<typeof relationsFilterToSQL>[0],
  dialect: { sqlToQuery: (q: unknown) => { params: unknown[], sql: string } },
  session: { execute: (q: unknown) => Promise<{ count: string | number }[]> },
  findMany: (config: unknown) => { toSQL: () => { params: unknown[], sql: string } } & PromiseLike<unknown[]>,
  count: (filter?: unknown) => CountQueryPromise,
}

function toCtx(builder: AnyBuilder) {
  return builder as unknown as BuilderCtx
}

function buildCountQuery(ctx: BuilderCtx, filter?: AnyFilter) {
  const query = sql`select count(*) as count from ${ctx.table}`
  if (filter) {
    const filterSQL = relationsFilterToSQL(ctx.table, filter)
    if (filterSQL) query.append(sql` where ${filterSQL}`)
  }
  return query
}

RelationalQueryBuilder.prototype.count = function count(this: AnyBuilder, filter?: AnyFilter) {
  const ctx = toCtx(this)
  const query = buildCountQuery(ctx, filter)
  const { dialect, session } = ctx
  return {
    // oxlint-disable-next-line no-thenable
    then<TResult1 = number, TResult2 = never>(
      onfulfilled?: ((value: number) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
      return session.execute(query)
        // oxlint-disable-next-line prefer-await-to-then
        .then(rows => Number(rows[0]?.count ?? 0))
        // oxlint-disable-next-line prefer-await-to-then
        .then(onfulfilled as ((value: number) => TResult1 | PromiseLike<TResult1>) | null, onrejected as ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null)
    },
    toSQL: () => dialect.sqlToQuery(query),
  }
}

RelationalQueryBuilder.prototype.findManyAndCount = (function findManyAndCount(
  this: AnyBuilder,
  config?: DBQueryConfig<'many', TablesRelationalConfig, TableRelationalConfig>,
) {
  const ctx = toCtx(this)
  const findManyQuery = ctx.findMany(config)
  const countQuery = ctx.count(config?.where)
  const findManyPromise = Promise.resolve(findManyQuery)
  const { dialect } = ctx
  return {
    // oxlint-disable-next-line no-thenable
    then<TResult1 = FindManyAndCountResult<unknown>, TResult2 = never>(
      onfulfilled?: ((value: FindManyAndCountResult<unknown>) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
      return Promise.all([findManyPromise, countQuery])
        // oxlint-disable-next-line prefer-await-to-then
        .then(([data, total]) => ({ data, total } as FindManyAndCountResult<unknown>))
        // oxlint-disable-next-line prefer-await-to-then
        .then(onfulfilled as ((value: FindManyAndCountResult<unknown>) => TResult1 | PromiseLike<TResult1>) | null, onrejected as ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null)
    },
    toSQL: () => ({
      count: countQuery.toSQL(),
      findMany: findManyQuery.toSQL(),
    }),
  }
}) as unknown as AnyBuilder['findManyAndCount']
