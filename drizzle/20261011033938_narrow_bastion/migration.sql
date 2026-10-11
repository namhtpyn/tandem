CREATE TABLE "tandem_projects" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"parent_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tandem_tasks" ADD COLUMN "project_id" text;--> statement-breakpoint
CREATE INDEX "tandem_projects_parent_idx" ON "tandem_projects" ("parent_id");--> statement-breakpoint
CREATE INDEX "tandem_tasks_project_idx" ON "tandem_tasks" ("project_id");--> statement-breakpoint
ALTER TABLE "tandem_projects" ADD CONSTRAINT "tandem_projects_parent_id_tandem_projects_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "tandem_projects"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tandem_tasks" ADD CONSTRAINT "tandem_tasks_project_id_tandem_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "tandem_projects"("id") ON DELETE SET NULL;