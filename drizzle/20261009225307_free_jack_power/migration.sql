CREATE TABLE "tandem_environments" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL UNIQUE,
	"host" text NOT NULL,
	"port" text DEFAULT '22' NOT NULL,
	"username" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
