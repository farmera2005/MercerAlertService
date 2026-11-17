CREATE TYPE "public"."ai_call_status" AS ENUM('ok', 'retried', 'fallback', 'error', 'refused', 'budget_blocked');--> statement-breakpoint
CREATE TYPE "public"."ai_purpose" AS ENUM('severity', 'summary', 'digest_daily', 'digest_weekly', 'test', 'chat');--> statement-breakpoint
CREATE TYPE "public"."digest_kind" AS ENUM('daily', 'weekly');--> statement-breakpoint
CREATE TYPE "public"."digest_source" AS ENUM('ai', 'template');--> statement-breakpoint
CREATE TABLE "ai_calls" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"purpose" "ai_purpose" NOT NULL,
	"model" text NOT NULL,
	"incident_id" bigint,
	"attempts" smallint DEFAULT 1 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(10, 5) DEFAULT 0 NOT NULL,
	"status" "ai_call_status" NOT NULL,
	"stop_reason" text,
	"served_by" text,
	"error" text,
	"redacted" boolean DEFAULT false NOT NULL,
	"request_id" text
);
--> statement-breakpoint
CREATE TABLE "digests" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" "digest_kind" NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"source" "digest_source" NOT NULL,
	"content" jsonb NOT NULL,
	"facts" jsonb NOT NULL,
	"markdown" text NOT NULL,
	"ai_call_id" bigint,
	"notification_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "ai_priority_suggested" smallint;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "ai_priority_basis" text;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "ai_summary_material_rev" integer;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "ai_attempts" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "ai_next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "ai_status" text;--> statement-breakpoint
ALTER TABLE "incident_notify_state" ADD COLUMN "ai_summary_posted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_calls" ADD CONSTRAINT "ai_calls_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digests" ADD CONSTRAINT "digests_ai_call_id_ai_calls_id_fk" FOREIGN KEY ("ai_call_id") REFERENCES "public"."ai_calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digests" ADD CONSTRAINT "digests_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_calls_at_idx" ON "ai_calls" USING btree ("at");--> statement-breakpoint
CREATE INDEX "ai_calls_incident_idx" ON "ai_calls" USING btree ("incident_id");--> statement-breakpoint
CREATE UNIQUE INDEX "digests_kind_period_uq" ON "digests" USING btree ("kind","period_start");