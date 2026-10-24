-- Custom migration (docs/plugins-plan.md P5): the 18+ section left the core
-- for the plugin `velvet` (plugins/velvet); its two profile settings go with
-- it, waiting for it to be installed (the plugin's rows need no plugins row):
--   adult.metadataProvider → the plugin's profile setting `metadataProvider`
--   adult.layout           → its store `layout:<profile id>` ("posters" / "list")
-- The core's rows are deleted. Values are JSON text, like Drizzle writes them;
-- a store row's size is its JSON's bytes + its key's (the plugin's quota).
INSERT OR IGNORE INTO `plugin_settings` (`plugin_id`, `scope`, `owner_id`, `key`, `value`, `updated_at`)
SELECT 'velvet', 'profile', `profile_id`, 'metadataProvider', `value`, `updated_at`
FROM `profile_settings`
WHERE `key` = 'adult.metadataProvider' AND json_valid(`value`) AND json_extract(`value`, '$') IN ('tmdb', 'theporndb');
--> statement-breakpoint
INSERT OR IGNORE INTO `plugin_store` (`plugin_id`, `key`, `value`, `size`, `updated_at`)
SELECT 'velvet', 'layout:' || `profile_id`,
	CASE json_extract(`value`, '$') WHEN 'compact' THEN '"list"' ELSE '"posters"' END,
	length('layout:' || `profile_id`) + CASE json_extract(`value`, '$') WHEN 'compact' THEN 6 ELSE 9 END,
	`updated_at`
FROM `profile_settings`
WHERE `key` = 'adult.layout' AND json_valid(`value`);
--> statement-breakpoint
DELETE FROM `profile_settings` WHERE `key` IN ('adult.layout', 'adult.metadataProvider');
