// Shared client/server types (importable from app/ and server/).
export interface EnvironmentRow {
  id: string
  name: string
  host: string
  port: string
  username: string
  /** optional vault secret used for SSH auth (never the value itself) */
  secretId: string | null
  /** how the linked secret is used */
  secretUsage: 'ssh-key' | 'password'
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

export interface VaultSecretRow {
  id: string
  name: string
  description: string
  /** display hint — last 4 chars of the plaintext, nothing more */
  lastFour: string
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface VaultAuditRow {
  id: string
  secretId: string | null
  secretName: string
  action: 'create' | 'update' | 'delete' | 'use'
  actorId: string
  at: string
}
