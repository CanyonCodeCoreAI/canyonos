ALTER TABLE "project_workflows" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "project_workflows" CASCADE;--> statement-breakpoint
DROP FUNCTION enforce_project_workflow_source_kind();--> statement-breakpoint
DROP TRIGGER "files_workflow_source_invariant_trigger" ON "files";--> statement-breakpoint
DROP FUNCTION prevent_backing_file_reclassification();--> statement-breakpoint
ALTER TABLE "projects" RENAME TO "workflows";--> statement-breakpoint
ALTER TABLE "deployments" RENAME COLUMN "project_id" TO "workflow_id";--> statement-breakpoint
ALTER TABLE "files" RENAME COLUMN "project_id" TO "workflow_id";--> statement-breakpoint
ALTER TABLE "system_prompts" RENAME COLUMN "project_id" TO "workflow_id";--> statement-breakpoint
ALTER TABLE "files" DROP CONSTRAINT "uq_files_project_id_id";--> statement-breakpoint
ALTER TABLE "deployments" DROP CONSTRAINT "deployments_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "files" DROP CONSTRAINT "files_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "system_prompts" DROP CONSTRAINT "system_prompts_project_id_projects_id_fk";
--> statement-breakpoint
DROP INDEX "idx_deployments_project";--> statement-breakpoint
DROP INDEX "uq_deployments_active_per_project";--> statement-breakpoint
DROP INDEX "idx_files_project";--> statement-breakpoint
DROP INDEX "idx_files_project_component_path";--> statement-breakpoint
DROP INDEX "uq_files_project_path";--> statement-breakpoint
DROP INDEX "idx_otel_metric_rollups_project_name_bucket";--> statement-breakpoint
DROP INDEX "idx_otel_spans_project_start";--> statement-breakpoint
DROP INDEX "idx_system_prompts_project_name";--> statement-breakpoint
DROP INDEX "uq_system_prompts_project_name_version";--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "workflow_group_id" uuid;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_prompts" ADD CONSTRAINT "system_prompts_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_deployments_workflow" ON "deployments" USING btree ("workflow_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_deployments_active_per_workflow" ON "deployments" USING btree ("workflow_id") WHERE "deployments"."status" in ('pending', 'receiving_files', 'processing_files', 'provisioning_resources', 'launching_resources');--> statement-breakpoint
CREATE INDEX "idx_files_workflow" ON "files" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "idx_files_workflow_component_path" ON "files" USING btree ("workflow_id","component_kind","path");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_files_workflow_path" ON "files" USING btree ("workflow_id","path");--> statement-breakpoint
CREATE INDEX "idx_otel_metric_rollups_workflow_group_name_bucket" ON "otel_metric_rollups" USING btree (("resource_attributes" ->> 'canyonos.workflow_group.id'),"metric_name","bucket_start_unix_nano");--> statement-breakpoint
CREATE INDEX "idx_otel_spans_workflow_start" ON "otel_spans" USING btree (("attributes" ->> 'canyonos.workflow.id'),"start_time_unix_nano");--> statement-breakpoint
CREATE INDEX "idx_system_prompts_workflow_name" ON "system_prompts" USING btree ("workflow_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_system_prompts_workflow_name_version" ON "system_prompts" USING btree ("workflow_id","name","version");