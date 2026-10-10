CREATE TABLE "tandem_tasks" (
	"id" text PRIMARY KEY,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'todo' NOT NULL,
	"assignee_id" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "tandem_tasks_assignee_idx" ON "tandem_tasks" ("assignee_id");--> statement-breakpoint
CREATE INDEX "tandem_tasks_status_idx" ON "tandem_tasks" ("status");--> statement-breakpoint
ALTER TABLE "tandem_tasks" ADD CONSTRAINT "tandem_tasks_assignee_id_tandem_user_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "tandem_user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tandem_tasks" ADD CONSTRAINT "tandem_tasks_created_by_tandem_user_id_fkey" FOREIGN KEY ("created_by") REFERENCES "tandem_user"("id") ON DELETE SET NULL;