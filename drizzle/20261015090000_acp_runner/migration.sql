-- ACP runner: harness is gone (ACP is the only dispatch shape); executable
-- becomes the required "ACP executable" — the full command that starts an
-- ACP server on stdio in the environment. Existing rows migrate to `hermes acp`.
alter table tandem_ai_employees drop column harness;
update tandem_ai_employees set executable = 'hermes acp';
alter table tandem_ai_employees alter column executable drop default;
alter table tandem_ai_employees alter column executable set not null;

-- one ACP session per task, for the task's whole life: first dispatch creates
-- it, every later dispatch (answer, review round, re-dispatch) resumes it.
alter table tandem_tasks add column acp_session_id text;
