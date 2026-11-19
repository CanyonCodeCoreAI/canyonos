ALTER TABLE "deploy_setups" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "deployment_events" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "deployment_files" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "deployments" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "deploy_setups" CASCADE;--> statement-breakpoint
DROP TABLE "deployment_events" CASCADE;--> statement-breakpoint
DROP TABLE "deployment_files" CASCADE;--> statement-breakpoint
DROP TABLE "deployments" CASCADE;--> statement-breakpoint
DROP FUNCTION IF EXISTS notify_deploy_job(), notify_deploy_event();--> statement-breakpoint
ALTER TABLE "files" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "system_prompts" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "workflows" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint
DROP TYPE "public"."deployment_status";