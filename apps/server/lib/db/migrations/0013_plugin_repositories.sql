CREATE TABLE `plugin_repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`name` text NOT NULL,
	`key` text NOT NULL,
	`pending_key` text,
	`enabled` integer DEFAULT true NOT NULL,
	`builtin` integer DEFAULT false NOT NULL,
	`etag` text,
	`fetched_at` integer,
	`checked_at` integer,
	`error` text,
	`added_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plugin_repositories_url_unique` ON `plugin_repositories` (`url`);--> statement-breakpoint
ALTER TABLE `plugins` ADD `repository` text;--> statement-breakpoint
ALTER TABLE `plugins` ADD `update_policy` text;--> statement-breakpoint
ALTER TABLE `plugins` ADD `held` text;