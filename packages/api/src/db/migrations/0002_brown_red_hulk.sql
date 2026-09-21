CREATE TABLE "otel_logs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "otel_logs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"service_name" text,
	"resource_attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scope_name" text,
	"time_unix_nano" bigint NOT NULL,
	"observed_time_unix_nano" bigint NOT NULL,
	"severity_number" integer,
	"severity_text" text,
	"body" text,
	"trace_id" text,
	"span_id" text,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "otel_metrics" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "otel_metrics_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"service_name" text,
	"resource_attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scope_name" text,
	"metric_name" text NOT NULL,
	"metric_unit" text,
	"metric_type" text NOT NULL,
	"time_unix_nano" bigint NOT NULL,
	"value" double precision NOT NULL,
	"data_point_attributes" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_otel_logs_time" ON "otel_logs" USING btree ("time_unix_nano");--> statement-breakpoint
CREATE INDEX "idx_otel_metrics_name_time" ON "otel_metrics" USING btree ("metric_name","time_unix_nano");