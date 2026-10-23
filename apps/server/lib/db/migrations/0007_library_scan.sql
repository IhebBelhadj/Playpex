ALTER TABLE `library_folders` ADD `builtin` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `media_items` ADD `episode_title` text;--> statement-breakpoint
ALTER TABLE `media_files` ADD `matched_by` text;--> statement-breakpoint
ALTER TABLE `media_files` ADD `subtitles` text;