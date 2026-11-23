CREATE TABLE "noc_boards" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"definition" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "noc_boards_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "kiosk_tokens" ADD COLUMN "boards" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "kiosk_tokens" ADD COLUMN "board_rotate_sec" integer;