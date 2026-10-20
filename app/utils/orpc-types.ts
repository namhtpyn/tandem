// Row types derived from the typed oRPC client — single source of truth is the router
import type { InferClientOutputs } from '@orpc/client';
import type { RouterClient } from '@orpc/server';

import type { appRouter } from '~/../server/domains/app.router';

type Client = RouterClient<typeof appRouter>;
type Outputs = InferClientOutputs<Client>;

export type VaultSecretRow = Outputs['vault']['secrets']['list'][number];
export type VaultFoldersSnapshot = Outputs['vault']['folders']['list'];
export type TaskStatusRow = Outputs['statuses']['list'][number];
export type EmployeeRow = Outputs['employees']['list'][number];
export type EnvironmentRow = Outputs['environments']['list'][number];
export type ProjectRow = Outputs['projects']['list'][number];
export type TaskRow = Outputs['tasks']['list'][number];
export type TaskActivityRow = Outputs['tasks']['activityList'][number];
export type ApiKeyRow = Outputs['employees']['listApiKeys'][number];
export type ModelProviderRow = Outputs['providers']['list'][number];
export type ProviderSaveInput = Parameters<Client['providers']['save']>[0];
