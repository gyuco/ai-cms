-- What the site runtimes read (role cms_content_ro): the published version of each live node.
CREATE VIEW published_content AS
SELECT
  n.id AS node_id,
  n.path,
  n.kind,
  p.env,
  v.body,
  v.version,
  p.published_at
FROM publications p
JOIN nodes n ON n.id = p.node_id AND n.deleted_at IS NULL
JOIN content_versions v ON v.id = p.version_id
WHERE p.status = 'published';
--> statement-breakpoint
GRANT SELECT ON published_content TO cms_content_ro;
