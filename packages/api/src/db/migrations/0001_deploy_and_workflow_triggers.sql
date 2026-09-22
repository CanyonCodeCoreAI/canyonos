-- The functions and triggers the Drizzle schema cannot express. Everything else lives in 0000.

CREATE FUNCTION enforce_project_workflow_source_kind() RETURNS trigger AS $$
DECLARE
	source_kind "file_component_kind";
BEGIN
	SELECT "component_kind"
	INTO source_kind
	FROM "public"."files"
	WHERE "id" = NEW."source_file_id" AND "project_id" = NEW."project_id"
	FOR UPDATE;

	IF source_kind IS DISTINCT FROM 'workflow'::"file_component_kind" THEN
		RAISE EXCEPTION 'workflow source must be a workflow file in the same project' USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "project_workflows_source_kind_trigger"
BEFORE INSERT OR UPDATE OF "project_id", "source_file_id" ON "project_workflows"
FOR EACH ROW EXECUTE FUNCTION enforce_project_workflow_source_kind();--> statement-breakpoint

CREATE FUNCTION prevent_backing_file_reclassification() RETURNS trigger AS $$
BEGIN
	IF NEW."component_kind" = 'workflow' AND NEW."project_id" IS NOT DISTINCT FROM OLD."project_id" THEN
		RETURN NEW;
	END IF;

	PERFORM 1
	FROM "public"."project_workflows"
	WHERE "source_file_id" = OLD."id"
	FOR KEY SHARE;

	IF FOUND THEN
		RAISE EXCEPTION 'workflow backing files cannot be reclassified or moved' USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "files_workflow_source_invariant_trigger"
BEFORE UPDATE OF "component_kind", "project_id" ON "files"
FOR EACH ROW EXECUTE FUNCTION prevent_backing_file_reclassification();--> statement-breakpoint

-- The bell for the queue: a freshly-inserted pending row wakes the worker's LISTEN in ~ms.
CREATE FUNCTION notify_deploy_job() RETURNS trigger AS $$
BEGIN PERFORM pg_notify('deploy_jobs', NEW.id::text); RETURN NEW; END
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER deployments_notify_job AFTER INSERT ON deployments
  FOR EACH ROW WHEN (NEW.status = 'pending') EXECUTE FUNCTION notify_deploy_job();--> statement-breakpoint
CREATE TRIGGER deployments_notify_stop AFTER UPDATE ON deployments
  FOR EACH ROW WHEN (NEW.status = 'stopping' AND OLD.status <> 'stopping')
  EXECUTE FUNCTION notify_deploy_job();--> statement-breakpoint

-- Identifiers only: a NOTIFY payload above 8000 bytes aborts the insert that raised it, and an
-- event detail has no size limit. Readers fetch the row.
CREATE FUNCTION notify_deploy_event() RETURNS trigger AS $$
BEGIN PERFORM pg_notify('deploy_events', json_build_object(
  'deployment_id', NEW.deployment_id, 'seq', NEW.seq)::text);
RETURN NEW; END
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER deployment_events_notify AFTER INSERT ON deployment_events
  FOR EACH ROW EXECUTE FUNCTION notify_deploy_event();
