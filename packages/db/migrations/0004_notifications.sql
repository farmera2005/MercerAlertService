CREATE TYPE "public"."channel_kind" AS ENUM('teams', 'sms', 'pushover');--> statement-breakpoint
CREATE TYPE "public"."notification_purpose" AS ENUM('incident_open', 'incident_update', 'incident_resolved', 'escalation', 'self_alert', 'test', 'digest');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('queued', 'sent', 'failed', 'suppressed');--> statement-breakpoint
CREATE TYPE "public"."page_via" AS ENUM('sms', 'pushover', 'both', 'none');--> statement-breakpoint
CREATE TABLE "escalations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"incident_id" bigint NOT NULL,
	"level" smallint NOT NULL,
	"after_min" integer NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"fired_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incident_notify_state" (
	"incident_id" bigint PRIMARY KEY NOT NULL,
	"last_status" "incident_status" NOT NULL,
	"last_priority" "priority" NOT NULL,
	"last_kind" "incident_kind" NOT NULL,
	"last_material_rev" integer NOT NULL,
	"update_count" integer DEFAULT 0 NOT NULL,
	"paged_at" timestamp with time zone,
	"paged_person_ids" integer[] DEFAULT '{}'::int[] NOT NULL,
	"last_snoozed_until" timestamp with time zone,
	"baselined" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_channels" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"webhook_url_enc" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"incident_id" bigint,
	"purpose" "notification_purpose" NOT NULL,
	"kind" "channel_kind" NOT NULL,
	"channel_key" text,
	"person_id" integer,
	"recipient" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "notification_status" NOT NULL,
	"suppress_reason" text,
	"shadow" boolean DEFAULT false NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"provider_ref" text,
	"thread_ref" text,
	"created_at" timestamp with time zone NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifier_health" (
	"key" text PRIMARY KEY NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"last_error" text,
	"last_alerted_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oncall_overrides" (
	"id" serial PRIMARY KEY NOT NULL,
	"person_id" integer NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reason" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oncall_weeks" (
	"id" serial PRIMARY KEY NOT NULL,
	"week_start" date NOT NULL,
	"primary_person_id" integer NOT NULL,
	"secondary_person_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oncall_weeks_week_start_unique" UNIQUE("week_start")
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone_e164" text,
	"pushover_user_key" text,
	"page_via" "page_via" DEFAULT 'sms' NOT NULL,
	"is_it_lead" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"rotation_position" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routing_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"match" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"channel_key" text,
	"page_oncall" boolean DEFAULT false NOT NULL,
	"escalate_after_min" integer,
	"stop" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "short_links" (
	"code" text PRIMARY KEY NOT NULL,
	"incident_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_notify_state" ADD CONSTRAINT "incident_notify_state_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oncall_overrides" ADD CONSTRAINT "oncall_overrides_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oncall_weeks" ADD CONSTRAINT "oncall_weeks_primary_person_id_people_id_fk" FOREIGN KEY ("primary_person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oncall_weeks" ADD CONSTRAINT "oncall_weeks_secondary_person_id_people_id_fk" FOREIGN KEY ("secondary_person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_rules" ADD CONSTRAINT "routing_rules_channel_key_notification_channels_key_fk" FOREIGN KEY ("channel_key") REFERENCES "public"."notification_channels"("key") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "short_links" ADD CONSTRAINT "short_links_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "escalations_pending_idx" ON "escalations" USING btree ("due_at") WHERE "escalations"."fired_at" IS NULL AND "escalations"."cancelled_at" IS NULL;--> statement-breakpoint
CREATE INDEX "escalations_incident_idx" ON "escalations" USING btree ("incident_id");--> statement-breakpoint
CREATE INDEX "notifications_outbox_idx" ON "notifications" USING btree ("next_attempt_at") WHERE "notifications"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "notifications_incident_idx" ON "notifications" USING btree ("incident_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_person_idx" ON "notifications" USING btree ("person_id","created_at");--> statement-breakpoint
CREATE INDEX "oncall_overrides_ends_idx" ON "oncall_overrides" USING btree ("ends_at");--> statement-breakpoint
CREATE UNIQUE INDEX "short_links_incident_uq" ON "short_links" USING btree ("incident_id");