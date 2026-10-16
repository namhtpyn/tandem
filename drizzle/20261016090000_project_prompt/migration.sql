-- project prompt: added to every brief of this project's tasks
alter table "tandem_projects" add column "prompt" text not null default '';
