// Row types derived from the typed oRPC client — single source of truth is the router
import type { InferClientOutputs } from '@orpc/client';
import type { RouterClient } from '@orpc/server';

import type { appRouter } from '#server/domains/app.router';

type Client = RouterClient<typeof appRouter>;
type Outputs = InferClientOutputs<Client>;

type VaultSecretList = Outputs['vault']['secrets']['list'];
export type VaultSecretRow = VaultSecretList['data'][number];
type VaultFolderList = Outputs['vault']['folders']['listPaged'];
export type FolderRow = VaultFolderList['folders'][number];
export type TaskStatusRow = Outputs['statuses']['list'][number];
export type EmployeeRow = Outputs['employees']['list'][number];
export type EnvironmentRow = Outputs['environments']['list'][number];
export type ProjectRow = Outputs['projects']['list'][number];
export type TaskRow = Outputs['tasks']['list'][number];
export type ApiKeyRow = Outputs['employees']['listApiKeys'][number];
export type ModelProviderRow = Outputs['providers']['list'][number];
export type ProviderSaveInput = Parameters<Client['providers']['save']>[0];
export type TitlesPayload = Outputs['employees']['titles']['list'];
export type TitleRow = TitlesPayload['titles'][number];
export type SettingsPayload = Outputs['settings']['list'];
export type ThreadRow = Outputs['tasks']['threadList'][number];
export type TaskRunRow = Outputs['tasks']['runsList'][number];
export type ReviewRow = Outputs['tasks']['reviews'][number];
export type SubtaskRow = Outputs['tasks']['subtasks']['items'][number];
export type ProposalRow = Outputs['tasks']['proposals']['items'][number];
export type AssignmentRow = Outputs['tasks']['assignments']['items'][number];
export type InboxItem = Outputs['tasks']['inbox']['items'][number];
