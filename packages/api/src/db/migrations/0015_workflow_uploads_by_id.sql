-- Each uploaded workflow is kept by its workflow_id, with its name, instead of by its name; an
-- upload of a workflow the dashboard does not know is forgotten.
UPDATE "workflow_groups" AS g SET "workflows" = coalesce(
	(
		SELECT jsonb_object_agg(w."id"::text, upload.value || jsonb_build_object('name', upload.key))
		FROM jsonb_each(g."workflows") AS upload
		JOIN "workflows" AS w ON w."workflow_group_id" = g."id" AND w."name" = upload.key
	),
	'{}'::jsonb
);
