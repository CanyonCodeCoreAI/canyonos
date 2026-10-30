CREATE TABLE "otel_metric_rollups" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "otel_metric_rollups_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"metric_name" text NOT NULL,
	"metric_type" text NOT NULL,
	"metric_unit" text,
	"service_name" text,
	"resource_attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"data_point_attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"series_key" text GENERATED ALWAYS AS (md5(coalesce(service_name, '') || resource_attributes::text || data_point_attributes::text)) STORED,
	"bucket_start_unix_nano" bigint NOT NULL,
	"sum" double precision NOT NULL,
	"count" integer NOT NULL,
	"min" double precision NOT NULL,
	"max" double precision NOT NULL,
	"last_value" double precision NOT NULL,
	"last_time_unix_nano" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_otel_metric_rollups_series_bucket" ON "otel_metric_rollups" USING btree ("metric_name","series_key","bucket_start_unix_nano");--> statement-breakpoint
CREATE INDEX "idx_otel_metric_rollups_bucket" ON "otel_metric_rollups" USING btree ("bucket_start_unix_nano");--> statement-breakpoint
CREATE INDEX "idx_otel_metric_rollups_project_name_bucket" ON "otel_metric_rollups" USING btree (("resource_attributes" ->> 'canyonos.project.id'),"metric_name","bucket_start_unix_nano");--> statement-breakpoint
CREATE INDEX "idx_otel_metrics_time" ON "otel_metrics" USING btree ("time_unix_nano");