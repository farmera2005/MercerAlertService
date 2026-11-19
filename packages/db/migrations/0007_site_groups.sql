CREATE TYPE "public"."site_notes_write_status" AS ENUM('pending', 'ok', 'conflict', 'failed', 'skipped');--> statement-breakpoint
CREATE TABLE "site_notes_writes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"container_id" integer NOT NULL,
	"text" text NOT NULL,
	"base" text,
	"requested_by" text NOT NULL,
	"status" "site_notes_write_status" DEFAULT 'pending' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "orion_container_id" integer;--> statement-breakpoint
ALTER TABLE "site_notes_writes" ADD CONSTRAINT "site_notes_writes_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "site_notes_writes_site_idx" ON "site_notes_writes" USING btree ("site_id","created_at");--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_orion_container_id_unique" UNIQUE("orion_container_id");