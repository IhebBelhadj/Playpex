CREATE TABLE `plugins` (
	`id` text PRIMARY KEY NOT NULL,
	`version` text NOT NULL,
	`origin` text NOT NULL,
	`source` text,
	`signer` text,
	`enabled` integer DEFAULT true NOT NULL,
	`installed_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
