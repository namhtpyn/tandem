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
