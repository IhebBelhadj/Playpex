-- Custom migration (docs/settings-plan.md §6): copy the 18+ preferences of
-- profiles.preferences.adult into profile_settings. Values are JSON text, like
-- every value Drizzle writes there; missing / null ones stay unset (= default).
INSERT OR IGNORE INTO `profile_settings` (`profile_id`, `key`, `value`, `updated_at`)
SELECT `id`, 'adult.layout', json_quote(json_extract(`preferences`, '$.adult.layout')),
	CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
FROM `profiles`
WHERE json_valid(`preferences`) AND json_extract(`preferences`, '$.adult.layout') IN ('posters', 'compact');
--> statement-breakpoint
INSERT OR IGNORE INTO `profile_settings` (`profile_id`, `key`, `value`, `updated_at`)
SELECT `id`, 'adult.metadataProvider', json_quote(json_extract(`preferences`, '$.adult.metadataProvider')),
	CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
FROM `profiles`
WHERE json_valid(`preferences`) AND json_type(`preferences`, '$.adult.metadataProvider') = 'text';
