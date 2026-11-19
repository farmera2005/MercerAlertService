CREATE TYPE "public"."site_geo_status" AS ENUM('pending', 'ok', 'not_found', 'failed', 'manual');--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "address" text;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "geo_status" "site_geo_status";--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "geo_query" text;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "geo_label" text;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "geo_error" text;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "geocoded_at" timestamp with time zone;