ALTER TABLE `downloads` ADD `queue_order` integer;--> statement-breakpoint
ALTER TABLE `downloads` ADD `forced` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `downloads` ADD `seed_ratio` real;--> statement-breakpoint
ALTER TABLE `downloads` ADD `seed_minutes` integer;--> statement-breakpoint
ALTER TABLE `downloads` ADD `down_limit_kbps` integer;--> statement-breakpoint
ALTER TABLE `downloads` ADD `up_limit_kbps` integer;--> statement-breakpoint
ALTER TABLE `downloads` ADD `trackers` text;