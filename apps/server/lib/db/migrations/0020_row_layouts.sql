CREATE TABLE `row_layouts` (
	`section` text PRIMARY KEY NOT NULL,
	`layout` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `profile_row_layouts` (
	`profile_id` text NOT NULL,
	`section` text NOT NULL,
	`layout` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`profile_id`, `section`),
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
