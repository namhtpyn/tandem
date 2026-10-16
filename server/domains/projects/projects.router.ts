import { os } from '@orpc/server'
// projects router — business logic lives in services/utils; this file only wires procedures
import { asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../db'
import {
  projects as projectsTable,
} from '../../db/schema'
import { base, protectedProcedure, liveGenerator, publishChange, ORPCError } from '../kernel/kernel'
import type { ProjectRow } from '../../../shared/types'
import { uuidv7 } from '../kernel/ids'

export const projectsRouter = os.router({
  /** live list — flat rows; nesting resolved client-side from parentId */
  list: protectedProcedure.handler(async (): Promise<ProjectRow[]> => {
    const rows = await db.select().from(projectsTable).orderBy(asc(projectsTable.name))
    return rows.map(r => ({
      id: r.id,
      name: r.name,
      description: r.description,
      prompt: r.prompt,
      status: r.status as 'active' | 'archived',
      parentId: r.parentId,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }))
  }),

  live: protectedProcedure.handler(() => liveGenerator(['projects'], async (): Promise<ProjectRow[]> => {
    const rows = await db.select().from(projectsTable).orderBy(asc(projectsTable.name))
    return rows.map(r => ({
      id: r.id,
      name: r.name,
      description: r.description,
      prompt: r.prompt,
      status: r.status as 'active' | 'archived',
      parentId: r.parentId,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }))
  })),

  /** create */
  create: protectedProcedure
    .input(z.strictObject({
      name: z.string().min(1).max(120),
      description: z.string().max(2000).default(''),
      prompt: z.string().max(8000).default(''),
      parentId: z.string().min(1).nullable().optional(),
    }))
    .handler(async ({ input }) => {
      if (input.parentId) {
        const p = await db.select({ id: projectsTable.id }).from(projectsTable).where(eq(projectsTable.id, input.parentId))
        if (p.length === 0) throw new ORPCError('BAD_REQUEST', { message: 'parent project does not exist' })
      }
      const id = uuidv7()
      await db.insert(projectsTable).values({ id, name: input.name, description: input.description, prompt: input.prompt, parentId: input.parentId ?? null })
      await publishChange('projects', 'create')
      return { id }
    }),

  /** update (name/description/status/parent — cycle-guarded) */
  update: protectedProcedure
    .input(z.strictObject({
      id: z.string().min(1),
      name: z.string().min(1).max(120).optional(),
      description: z.string().max(2000).optional(),
      prompt: z.string().max(8000).optional(),
      status: z.enum(['active', 'archived']).optional(),
      parentId: z.string().min(1).nullable().optional(),
    }))
    .handler(async ({ input }) => {
      const patch: { name?: string, description?: string, prompt?: string, status?: string, parentId?: string | null, updatedAt: Date } = { updatedAt: new Date() }
      if (input.name !== undefined) patch.name = input.name
      if (input.description !== undefined) patch.description = input.description
      if (input.prompt !== undefined) patch.prompt = input.prompt
      if (input.status !== undefined) patch.status = input.status
      if (input.parentId !== undefined) {
        if (input.parentId === null) {
          patch.parentId = null
        }
        else {
          if (input.parentId === input.id) throw new ORPCError('BAD_REQUEST', { message: 'project cannot be its own parent' })
          // walk ancestors; hitting self = cycle
          let cursor: string | null = input.parentId
          for (let depth = 0; depth < 100 && cursor; depth++) {
            if (cursor === input.id) throw new ORPCError('BAD_REQUEST', { message: 'cannot nest a project under its own descendant' })
            const rows: Array<{ parentId: string | null }> = await db.select({ parentId: projectsTable.parentId }).from(projectsTable).where(eq(projectsTable.id, cursor))
            cursor = rows[0]?.parentId ?? null
          }
          const p = await db.select({ id: projectsTable.id }).from(projectsTable).where(eq(projectsTable.id, input.parentId))
          if (p.length === 0) throw new ORPCError('BAD_REQUEST', { message: 'parent project does not exist' })
          patch.parentId = input.parentId
        }
      }
      await db.update(projectsTable).set(patch).where(eq(projectsTable.id, input.id))
      await publishChange('projects', 'update')
      return { ok: true }
    }),

  /** delete — tasks orphan to no-project (set null); children orphan to root (set null) */
  remove: protectedProcedure
    .input(z.strictObject({ id: z.string().min(1) }))
    .handler(async ({ input }) => {
      await db.delete(projectsTable).where(eq(projectsTable.id, input.id))
      await publishChange('projects', 'remove')
      return { ok: true }
    }),
})
