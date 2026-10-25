CREATE TABLE `direct_downloads` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`url` text NOT NULL,
	`headers` text,
	`by` text NOT NULL,
	`save_dir` text NOT NULL,
	`size_bytes` integer,
	`done_bytes` integer DEFAULT 0 NOT NULL,
	`error` text,
	`added_at` integer NOT NULL,
	`completed_at` integer,
	CONSTRAINT "direct_downloads_state_check" CHECK("direct_downloads"."state" IN ('queued', 'downloading', 'paused', 'completed', 'error')),
	CONSTRAINT "direct_downloads_kind_check" CHECK("direct_downloads"."kind" IN ('file', 'hls'))
);
