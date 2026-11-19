CREATE TYPE "public"."site_group_decision" AS ENUM('site', 'not_site');--> statement-breakpoint
CREATE TABLE "site_group_decisions" (
	"container_id" integer PRIMARY KEY NOT NULL,
	"decision" "site_group_decision" NOT NULL,
	"group_name" text NOT NULL,
	"decided_by" text NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL
);
