import type { ProjectStatus, SecretUsage } from './enums/index';
// Shared client/server types (importable from app/ and server/).
export type EnvironmentRow = {
  id: string;
  name: string;
  host: string;
  port: string;
  username: string;
  /** optional vault secret used for SSH auth (never the value itself) */
  secretId: string | null;
  /** how the linked secret is used */
  secretUsage: SecretUsage;
  /** last probe verdict (PROBE VERDICT LAW): null = never probed */
  lastProbeOk: boolean | null;
  lastProbeDetail: string | null;
  /** ISO timestamp of the last probe */
  lastProbeAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type EmployeeRow = {
  id: string;
  userId: string;
  name: string;
  email: string;
  /** avatar present — fetch via GET /api/employees/:id/avatar (cacheable) */
  hasAvatar: boolean;
  kind: 'human' | 'ai';
  title: string | null;
  supervisorIds: string[];
  /** ai only */
  environmentId: string | null;
  /** ai only */
  instructions: string | null;
  /** ai only — full command starting an ACP server on stdio (e.g. 'hermes acp'); required */
  executable: string | null;
  /** ai only — model provider registry id */
  providerId: string | null;
  /** ai only — model name for dispatch */
  model: string | null;
  /** ai only — vault secret holding the API key */
  apiKeySecretId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProjectRow = {
  id: string;
  name: string;
  description: string;
  /** project prompt — added to every brief of this project's tasks */
  prompt: string;
  status: ProjectStatus;
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TaskStatusRow = {
  id: string;
  name: string;
  color: string;
  position: number;
  category: 'backlog' | 'ready' | 'working' | 'paused' | 'waiting_answer' | 'in_review' | 'done' | 'cancelled';
  nextIds: string[];
};

export type TaskRow = {
  id: string;
  title: string;
  status: string;
  projectId: string | null;
  projectName: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  assigneeKind: 'human' | 'ai' | null;
  /** person responsible for questions/routing (creator by default; NOT necessarily supervisor) */
  ownerId: string | null;
  ownerName: string | null;
  /** unanimous approval gate; any mix of AI/human */
  reviewers: string[];
  reviewerNames: string[];
  /** reviewers who approved the current round */
  reviewApprovals: string[];
  /** who owes the answer while waiting (moves on forward) */
  questionHolderId: string | null;
  questionHolderName: string | null;
  /** subtask nesting: this task is a child of this parent (unlimited depth) */
  parentTaskId: string | null;
  /** earliest next dispatch (failure backoff); null = immediately eligible */
  dispatchAfter: string | null;
  /** consecutive failed runs; resets on success */
  failStreak: number;
  createdBy: string | null;
  creatorName: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TaskActivityRow = {
  id: string;
  taskId: string;
  kind: 'question' | 'answer' | 'forward' | 'note' | 'verdict' | 'status';
  authorId: string | null;
  authorName: string | null;
  body: string;
  meta: Record<string, unknown>;
  createdAt: string;
};

export type ApiKeyRow = {
  id: string;
  name: string | null;
  start: string | null;
  prefix: string | null;
  /** only set once, at creation */
  key?: string;
  expiresAt: string | null;
  createdAt: string;
};

export type VaultSecretRow = {
  id: string;
  name: string;
  description: string;
  /** display hint — last 4 chars of the plaintext, nothing more */
  lastFour: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** folder name joined server-side (null = uncategorized) */
  folder: string | null;
};
