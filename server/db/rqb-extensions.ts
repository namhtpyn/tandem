import {
  relationsFilterToSQL,
  SQL,
  sql,
  type AnyRelationsFilter,
  type AnyTableFilter,
  type EmptyFilter,
  type DBQueryConfig,
  type BuildQueryResult,
  type RelationsFilter,
  type TableRelationalConfig,
  type TablesRelationalConfig,
} from 'drizzle-orm';

export type FindManyAndCountResult<T> = {
  data: T[];
  total: number;
};

type CountQueryPromise = PromiseLike<number> & {
  toSQL: () => { params: unknown[]; sql: string };
};

type FindManyAndCountQueryPromise<T> = PromiseLike<FindManyAndCountResult<T>> & {
  toSQL: () => {
    count: { params: unknown[]; sql: string };
    findMany: { params: unknown[]; sql: string };
  };
};

type AnyBuilder = {
  table: Parameters<typeof relationsFilterToSQL>[0];
  dialect: { sqlToQuery: (q: unknown) => { params: unknown[]; sql: string } };
  session: { execute: (q: unknown) => Promise<{ count: string | number }[]> };
  findMany: (config: unknown) => { toSQL: () => { params: unknown[]; sql: string } } & PromiseLike<unknown[]>;
  count: (filter?: unknown) => CountQueryPromise;
};

type AnyFilter = AnyRelationsFilter | AnyTableFilter;

declare module 'drizzle-orm/pg-core/query-builders/query' {
  export interface RelationalQueryBuilder<
    TSchema extends TablesRelationalConfig,
    TFields extends TableRelationalConfig,
  > {
    count: (filter?: RelationsFilter<TFields, TSchema> | EmptyFilter) => CountQueryPromise;
    findManyAndCount: <TConfig extends DBQueryConfig<'many', TSchema, TFields>>(
      config?: TConfig,
    ) => FindManyAndCountQueryPromise<BuildQueryResult<TSchema, TFields, TConfig>>;
  }
}

function buildCountQuery(builder: AnyBuilder, filter?: AnyFilter) {
  const query = sql`select count(*) as count from ${builder.table}`;
  if (filter) {
    // rc.5: BuiltRelationsFilter { sql: SQLChunk[] | undefined, hasRelationFilters }
    const built = relationsFilterToSQL(builder.table, filter);
    /* v8 ignore next 1 -- drizzle's helper only returns empty for filter ASTs we never build */
    if (built.sql?.length) query.append(sql` where ${new SQL(built.sql)}`);
  }
  return query;
}

/**
 * Install count() + findManyAndCount() on the RelationalQueryBuilder prototype
 * the live db instance actually uses. MUST be called with the db instance —
 * nitro's chunker dropped the old import-side-effect patch from the graph.
 */
export function installRqbExtensions(query: Record<string, unknown>) {
  const first = Object.values(query)[0] as object | undefined;
  if (!first) return;
  const proto = Object.getPrototypeOf(first) as Record<string, unknown>;

  if (typeof proto.count !== 'function') {
    proto.count = function count(this: AnyBuilder, filter?: AnyFilter) {
      const query = buildCountQuery(this, filter);
      const { dialect, session } = this;
      return {
        // oxlint-disable-next-line no-thenable
        then<TResult1 = number, TResult2 = never>(
          onfulfilled?: ((value: number) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ): PromiseLike<TResult1 | TResult2> {
          return (
            session
              .execute(query)
              // oxlint-disable-next-line prefer-await-to-then
              .then((rows) => Number(rows[0]?.count ?? 0))
              // oxlint-disable-next-line prefer-await-to-then
              .then(
                onfulfilled as ((value: number) => TResult1 | PromiseLike<TResult1>) | null,
                onrejected as ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
              )
          );
        },
        toSQL: () => dialect.sqlToQuery(query),
      };
    };
  }

  if (typeof proto.findManyAndCount !== 'function') {
    proto.findManyAndCount = function findManyAndCount(
      this: AnyBuilder,
      config?: DBQueryConfig<'many', TablesRelationalConfig, TableRelationalConfig>,
    ) {
      const findManyQuery = this.findMany(config);
      const countQuery = this.count(config?.where as AnyFilter);
      const findManyPromise = Promise.resolve(findManyQuery);
      const { dialect } = this;
      return {
        // oxlint-disable-next-line no-thenable
        then<TResult1 = FindManyAndCountResult<unknown>, TResult2 = never>(
          onfulfilled?: ((value: FindManyAndCountResult<unknown>) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ): PromiseLike<TResult1 | TResult2> {
          return (
            Promise.all([findManyPromise, countQuery])
              // oxlint-disable-next-line prefer-await-to-then
              .then(([data, total]) => ({ data, total }) as FindManyAndCountResult<unknown>)
              // oxlint-disable-next-line prefer-await-to-then
              .then(
                onfulfilled as ((value: FindManyAndCountResult<unknown>) => TResult1 | PromiseLike<TResult1>) | null,
                onrejected as ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
              )
          );
        },
        toSQL: () => ({
          count: countQuery.toSQL(),
          findMany: findManyQuery.toSQL(),
        }),
      };
    };
  }
}
