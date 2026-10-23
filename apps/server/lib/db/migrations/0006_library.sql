CREATE TABLE `library_folders` (
	`id` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`kind` text NOT NULL,
	`audience` text DEFAULT 'everyone' NOT NULL,
	`dlna` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'ok' NOT NULL,
	`added_at` integer NOT NULL,
	`last_scan_at` integer,
	CONSTRAINT "library_folders_kind_check" CHECK("library_folders"."kind" IN ('movies', 'shows', 'mixed', 'other')),
	CONSTRAINT "library_folders_audience_check" CHECK("library_folders"."audience" IN ('everyone', 'adults'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `library_folders_path_unique` ON `library_folders` (`path`);--> statement-breakpoint
CREATE TABLE `media_items` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`tmdb_id` integer,
	`show_tmdb_id` integer,
	`season` integer,
	`episode` integer,
	`imdb_id` text,
	`title` text,
	`year` integer,
	`artwork` text,
	`matched_by` text NOT NULL,
	CONSTRAINT "media_items_kind_check" CHECK("media_items"."kind" IN ('movie', 'episode')),
	CONSTRAINT "media_items_matched_by_check" CHECK("media_items"."matched_by" IN ('auto', 'nfo', 'admin'))
);
--> statement-breakpoint
CREATE INDEX `media_items_movie` ON `media_items` (`kind`,`tmdb_id`);--> statement-breakpoint
CREATE INDEX `media_items_episode` ON `media_items` (`show_tmdb_id`,`season`,`episode`);--> statement-breakpoint
CREATE TABLE `media_files` (
	`id` text PRIMARY KEY NOT NULL,
	`folder_id` text NOT NULL,
	`rel_path` text NOT NULL,
	`size` integer NOT NULL,
	`mtime` integer NOT NULL,
	`probe` text,
	`parse` text,
	`item_id` text,
	`state` text DEFAULT 'unmatched' NOT NULL,
	`added_at` integer NOT NULL,
	`missing_since` integer,
	FOREIGN KEY (`folder_id`) REFERENCES `library_folders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `media_items`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "media_files_state_check" CHECK("media_files"."state" IN ('ok', 'missing', 'unmatched', 'ignored'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_files_folder_path` ON `media_files` (`folder_id`,`rel_path`);--> statement-breakpoint
CREATE INDEX `media_files_item` ON `media_files` (`item_id`);