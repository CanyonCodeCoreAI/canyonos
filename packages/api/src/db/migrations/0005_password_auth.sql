DROP TABLE "auth_challenges";
--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT "projects_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "created_by" DROP NOT NULL;
--> statement-breakpoint
UPDATE "projects" SET "created_by" = NULL;
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT "projects_company_id_companies_id_fk";
--> statement-breakpoint
DROP INDEX "idx_projects_company";
--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "company_id";
--> statement-breakpoint
ALTER TABLE "files" DROP CONSTRAINT "files_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "files" ALTER COLUMN "created_by" DROP NOT NULL;
--> statement-breakpoint
UPDATE "files" SET "created_by" = NULL;
--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "files" DROP CONSTRAINT "files_company_id_companies_id_fk";
--> statement-breakpoint
DROP INDEX "idx_files_company";
--> statement-breakpoint
ALTER TABLE "files" DROP COLUMN "company_id";
--> statement-breakpoint
ALTER TABLE "deploy_setups" DROP CONSTRAINT "deploy_setups_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "deploy_setups" ALTER COLUMN "created_by" DROP NOT NULL;
--> statement-breakpoint
UPDATE "deploy_setups" SET "created_by" = NULL;
--> statement-breakpoint
ALTER TABLE "deploy_setups" ADD CONSTRAINT "deploy_setups_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "deploy_setups" DROP CONSTRAINT "deploy_setups_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "deploy_setups" DROP COLUMN "company_id";
--> statement-breakpoint
ALTER TABLE "deployments" DROP CONSTRAINT "deployments_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "deployments" ALTER COLUMN "created_by" DROP NOT NULL;
--> statement-breakpoint
UPDATE "deployments" SET "created_by" = NULL;
--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "deployments" DROP CONSTRAINT "deployments_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "deployments" DROP COLUMN "company_id";
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_company_id_companies_id_fk";
--> statement-breakpoint
DROP TABLE "companies";
--> statement-breakpoint
DELETE FROM "users";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "company_id";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "name";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "status";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "activated_at";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "locked_at";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "locked_reason";
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_hash" text NOT NULL;