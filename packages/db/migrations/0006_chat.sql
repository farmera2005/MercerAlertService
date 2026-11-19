CREATE TYPE "public"."chat_role" AS ENUM('user', 'assistant');--> statement-breakpoint
CREATE TYPE "public"."chat_status" AS ENUM('pending', 'ok', 'error', 'refused', 'budget_blocked');--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"thread_id" bigint NOT NULL,
	"role" "chat_role" NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"status" "chat_status" DEFAULT 'ok' NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"model" text,
	"cost_usd" numeric(10, 5),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "chat_threads" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_key" text NOT NULL,
	"user_label" text NOT NULL,
	"title" text NOT NULL,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"redaction" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"seen_refs" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_messages_thread_idx" ON "chat_messages" USING btree ("thread_id","id");--> statement-breakpoint
CREATE INDEX "chat_threads_user_idx" ON "chat_threads" USING btree ("user_key","updated_at");