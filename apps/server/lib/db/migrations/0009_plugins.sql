CREATE TABLE `plugin_store` (
	`plugin_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`size` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`plugin_id`, `key`)
);
--> statement-breakpoint
CREATE TABLE `plugin_secrets` (
	`plugin_id` text NOT NULL,
	`name` text NOT NULL,
	`profile_id` text DEFAULT '' NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`plugin_id`, `name`, `profile_id`)
);
--> statement-breakpoint
CREATE TABLE `plugin_settings` (
	`plugin_id` text NOT NULL,
	`scope` text NOT NULL,
	`owner_id` text DEFAULT '' NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`plugin_id`, `scope`, `owner_id`, `key`)
);
