CREATE TABLE `plugin_grants` (
	`plugin_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`permission` text NOT NULL,
	`granted_at` integer NOT NULL,
	PRIMARY KEY(`plugin_id`, `profile_id`, `permission`),
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
