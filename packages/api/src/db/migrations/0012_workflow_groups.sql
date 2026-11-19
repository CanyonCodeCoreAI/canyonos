CREATE TABLE "workflow_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"config" text,
	"env_digest" text,
	"api_key_hash" text,
	"controller_container_id" text,
	"workflows" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"applied_generation" integer DEFAULT 0 NOT NULL,
	"last_change_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deployed" jsonb,
	"last_apply" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
