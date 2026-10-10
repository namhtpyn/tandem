// Shared client/server types (importable from app/ and server/).
export interface EnvironmentRow {
  id: string
  name: string
  host: string
  port: string
  username: string
  createdAt: string
  updatedAt: string
}

export interface EmployeeRow {
  id: string
  userId: string
  name: string
  email: string
  kind: 'human' | 'ai'
  title: string | null
  supervisorIds: string[]
  /** ai only */
  environmentId: string | null
  /** ai only */
  instructions: string | null
  createdAt: string
  updatedAt: string
}

export interface ApiKeyRow {
  id: string
  name: string | null
  start: string | null
  prefix: string | null
  /** only set once, at creation */
  key?: string
  expiresAt: string | null
  createdAt: string
}
