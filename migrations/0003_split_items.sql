-- The "items" plugin was split into "tools" (/tool) and "materials" (/material).
-- Existing items become tools; groups that had items get both new plugins.
UPDATE records SET tbl = 'tools' WHERE tbl = 'items';
UPDATE counters SET tbl = 'tools' WHERE tbl = 'items';
UPDATE groups
  SET plugins = replace(plugins, '"items"', '"tools","materials"'), updated_at = datetime('now')
  WHERE plugins LIKE '%"items"%';
