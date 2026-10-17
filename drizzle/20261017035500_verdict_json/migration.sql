-- Bootstrap data fix (one-time DML — drizzle-kit is DDL-only): convert every
-- historical run output's trailing [RESULT]/[QUESTION]/[BLOCKED] marker line
-- into the structured JSON verdict {"kind","body"} so the estate speaks one
-- format and the parser carries no marker fallback.
-- Greedy (.*) anchors on the LAST marker; \s*$ tolerates trailing newlines;
-- body is JSON-escaped (backslash + double quote); kinds are lowercase literals.
--> statement-breakpoint
update "tandem_task_runs"
   set "output" = regexp_replace("output",
     '^(.*)\[RESULT\][ ]?([^\n]*)(\s*)$',
     concat('\\1{"kind": "result", "body": "', replace(replace('\\2', '\', '\\'), '"', '\\"'), '"}\\3'),
     'n')
 where "output" ~ '\[RESULT\]';
--> statement-breakpoint
update "tandem_task_runs"
   set "output" = regexp_replace("output",
     '^(.*)\[QUESTION\][ ]?([^\n]*)(\s*)$',
     concat('\\1{"kind": "question", "body": "', replace(replace('\\2', '\', '\\'), '"', '\\"'), '"}\\3'),
     'n')
 where "output" ~ '\[QUESTION\]';
--> statement-breakpoint
update "tandem_task_runs"
   set "output" = regexp_replace("output",
     '^(.*)\[BLOCKED\][ ]?([^\n]*)(\s*)$',
     concat('\\1{"kind": "blocked", "body": "', replace(replace('\\2', '\', '\\'), '"', '\\"'), '"}\\3'),
     'n')
 where "output" ~ '\[BLOCKED\]';
