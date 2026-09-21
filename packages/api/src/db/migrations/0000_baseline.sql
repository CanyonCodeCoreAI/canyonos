CREATE TYPE "public"."deployment_status" AS ENUM('pending', 'receiving_files', 'processing_files', 'provisioning_resources', 'launching_resources', 'success', 'failed', 'stopping', 'stopped', 'stop_failed');--> statement-breakpoint
CREATE TYPE "public"."file_component_kind" AS ENUM('workflow', 'agent', 'tool', 'other');--> statement-breakpoint
CREATE TABLE "auth_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"destination" text NOT NULL,
	"purpose" varchar(64) NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deploy_setups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"provider" text DEFAULT 'AWS' NOT NULL,
	"company_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"region" text NOT NULL,
	"ami_id" text NOT NULL,
	"instance_type" text NOT NULL,
	"subnet_id" text NOT NULL,
	"security_group_ids" text NOT NULL,
	"ssh_user" text NOT NULL,
	"ssh_private_key_path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"status" "deployment_status" NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployment_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_id" uuid NOT NULL,
	"path" text NOT NULL,
	"content_hash" text NOT NULL,
	"byte_size" integer NOT NULL,
	"component_kind" "file_component_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"deploy_setup_id" uuid NOT NULL,
	"status" "deployment_status" DEFAULT 'pending' NOT NULL,
	"address" text,
	"error" text,
	"controller_instance_id" text,
	"controller_ip" text,
	"stop_claimed_at" timestamp with time zone,
	"stop_error" text,
	"claimed_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"worker_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "file_blobs" (
	"content_hash" text PRIMARY KEY NOT NULL,
	"byte_size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid,
	"created_by" uuid NOT NULL,
	"path" text NOT NULL,
	"name" text NOT NULL,
	"content_hash" text NOT NULL,
	"language" text NOT NULL,
	"byte_size" integer NOT NULL,
	"component_kind" "file_component_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_files_project_id_id" UNIQUE("project_id","id")
);
--> statement-breakpoint
CREATE TABLE "otel_spans" (
	"span_id" text PRIMARY KEY NOT NULL,
	"trace_id" text NOT NULL,
	"parent_span_id" text,
	"name" text NOT NULL,
	"kind" text DEFAULT 'SPAN_KIND_UNSPECIFIED' NOT NULL,
	"start_time_unix_nano" bigint NOT NULL,
	"end_time_unix_nano" bigint NOT NULL,
	"status_code" text DEFAULT 'STATUS_CODE_UNSET' NOT NULL,
	"status_message" text,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"input" text,
	"output" text
);
--> statement-breakpoint
CREATE TABLE "project_workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"source_file_id" uuid NOT NULL,
	"generation_status" varchar(32) DEFAULT 'PENDING' NOT NULL,
	"generation_revision" bigint DEFAULT 0 NOT NULL,
	"design" jsonb,
	"error_message" text,
	"model" varchar(64),
	"stale_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_workflows_generation_status_check" CHECK ("project_workflows"."generation_status" in ('PENDING', 'GENERATING', 'READY', 'FAILED')),
	CONSTRAINT "project_workflows_ready_design_check" CHECK ("project_workflows"."generation_status" <> 'READY' or "project_workflows"."design" is not null)
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"company_id" uuid,
	"status" varchar(32) DEFAULT 'PENDING' NOT NULL,
	"activated_at" timestamp with time zone,
	"locked_at" timestamp with time zone,
	"locked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "auth_challenges" ADD CONSTRAINT "auth_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deploy_setups" ADD CONSTRAINT "deploy_setups_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deploy_setups" ADD CONSTRAINT "deploy_setups_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_events" ADD CONSTRAINT "deployment_events_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_files" ADD CONSTRAINT "deployment_files_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_files" ADD CONSTRAINT "deployment_files_content_hash_file_blobs_content_hash_fk" FOREIGN KEY ("content_hash") REFERENCES "public"."file_blobs"("content_hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_deploy_setup_id_deploy_setups_id_fk" FOREIGN KEY ("deploy_setup_id") REFERENCES "public"."deploy_setups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_content_hash_file_blobs_content_hash_fk" FOREIGN KEY ("content_hash") REFERENCES "public"."file_blobs"("content_hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_workflows" ADD CONSTRAINT "project_workflows_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_workflows" ADD CONSTRAINT "project_workflows_project_source_files_fk" FOREIGN KEY ("project_id","source_file_id") REFERENCES "public"."files"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_auth_challenges_user" ON "auth_challenges" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_deployment_events_seq" ON "deployment_events" USING btree ("deployment_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_deployment_files_path" ON "deployment_files" USING btree ("deployment_id","path");--> statement-breakpoint
CREATE INDEX "idx_deployment_files_content_hash" ON "deployment_files" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "idx_deployments_project" ON "deployments" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_deployments_active_per_project" ON "deployments" USING btree ("project_id") WHERE "deployments"."status" in ('pending', 'receiving_files', 'processing_files', 'provisioning_resources', 'launching_resources');--> statement-breakpoint
CREATE INDEX "idx_deployments_pending" ON "deployments" USING btree ("created_at") WHERE "deployments"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "idx_deployments_status_updated" ON "deployments" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "idx_files_company" ON "files" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "idx_files_project" ON "files" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_files_project_component_path" ON "files" USING btree ("project_id","component_kind","path");--> statement-breakpoint
CREATE INDEX "idx_files_content_hash" ON "files" USING btree ("content_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_files_project_path" ON "files" USING btree ("project_id","path");--> statement-breakpoint
CREATE INDEX "idx_otel_spans_start" ON "otel_spans" USING btree ("start_time_unix_nano");--> statement-breakpoint
CREATE INDEX "idx_otel_spans_trace_start" ON "otel_spans" USING btree ("trace_id","start_time_unix_nano");--> statement-breakpoint
CREATE INDEX "idx_otel_spans_parent" ON "otel_spans" USING btree ("parent_span_id");--> statement-breakpoint
CREATE INDEX "idx_otel_spans_name_start" ON "otel_spans" USING btree ("name","start_time_unix_nano");--> statement-breakpoint
CREATE INDEX "idx_otel_spans_attributes" ON "otel_spans" USING gin ("attributes");--> statement-breakpoint
CREATE INDEX "idx_otel_spans_project_start" ON "otel_spans" USING btree (("attributes" ->> 'canyon.project.id'),"start_time_unix_nano");--> statement-breakpoint
CREATE INDEX "idx_project_workflows_project" ON "project_workflows" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_project_workflows_source_file" ON "project_workflows" USING btree ("source_file_id");--> statement-breakpoint
CREATE INDEX "idx_projects_company" ON "projects" USING btree ("company_id");