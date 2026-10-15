CREATE TABLE `profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`avatar` text,
	`is_kid` integer DEFAULT false NOT NULL,
	`pin_hash` text,
	`pin_salt` text,
	`preferences` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `profiles_name_unique` ON `profiles` (lower("name"));--> statement-breakpoint
CREATE TABLE `watchlist` (
	`profile_id` text NOT NULL,
	`media_type` text NOT NULL,
	`tmdb_id` integer NOT NULL,
	`title` text,
	`poster_path` text,
	`added_at` integer NOT NULL,
	PRIMARY KEY(`profile_id`, `media_type`, `tmdb_id`),
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `watchlist_profile_added_idx` ON `watchlist` (`profile_id`,`added_at`);--> statement-breakpoint
CREATE TABLE `progress` (
	`profile_id` text NOT NULL,
	`media_type` text NOT NULL,
	`tmdb_id` integer NOT NULL,
	`season` integer DEFAULT 0 NOT NULL,
	`episode` integer DEFAULT 0 NOT NULL,
	`title` text,
	`poster_path` text,
	`position_s` real NOT NULL,
	`duration_s` real NOT NULL,
	`info_hash` text,
	`file_path` text,
	`finished` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`profile_id`, `media_type`, `tmdb_id`, `season`, `episode`),
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `progress_profile_updated_idx` ON `progress` (`profile_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`profile_id` text NOT NULL,
	`media_type` text NOT NULL,
	`tmdb_id` integer NOT NULL,
	`season` integer DEFAULT 0 NOT NULL,
	`episode` integer DEFAULT 0 NOT NULL,
	`title` text,
	`genre_ids` text NOT NULL,
	`watched_ratio` real NOT NULL,
	`watched_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `history_profile_watched_idx` ON `history` (`profile_id`,`watched_at`);--> statement-breakpoint
CREATE INDEX `history_profile_title_idx` ON `history` (`profile_id`,`media_type`,`tmdb_id`);--> statement-breakpoint
CREATE TABLE `ratings` (
	`profile_id` text NOT NULL,
	`media_type` text NOT NULL,
	`tmdb_id` integer NOT NULL,
	`title` text,
	`genre_ids` text NOT NULL,
	`value` integer NOT NULL,
	`rated_at` integer NOT NULL,
	PRIMARY KEY(`profile_id`, `media_type`, `tmdb_id`),
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ratings_value_check" CHECK("ratings"."value" in (-1, 1))
);
