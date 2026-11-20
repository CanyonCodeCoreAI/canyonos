ALTER TABLE "otel_logs" ADD COLUMN "log_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_otel_logs_log_id" ON "otel_logs" USING btree ("log_id");