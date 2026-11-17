ALTER TABLE "deploy_setups" DROP CONSTRAINT "deploy_setups_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "deployments" DROP CONSTRAINT "deployments_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "files" DROP CONSTRAINT "files_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT "projects_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "deploy_setups" DROP COLUMN "created_by";
--> statement-breakpoint
ALTER TABLE "deployments" DROP COLUMN "created_by";
--> statement-breakpoint
ALTER TABLE "files" DROP COLUMN "created_by";
--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "created_by";
--> statement-breakpoint
DROP TABLE "users";
