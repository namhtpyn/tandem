-- Vault folders: metadata-only categorization for secrets.
CREATE TABLE "tandem_vault_folders" (
  "id" text PRIMARY KEY,
  "name" text NOT NULL UNIQUE,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "tandem_vault_secrets"
  ADD COLUMN "folder_id" text REFERENCES "tandem_vault_folders"("id") ON DELETE SET NULL;
--> statement-breakpoint
-- Employee title catalog for the employee form picker.
CREATE TABLE "tandem_employee_titles" (
  "id" text PRIMARY KEY,
  "name" text NOT NULL UNIQUE,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
