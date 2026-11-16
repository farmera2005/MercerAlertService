CREATE TYPE "public"."alert_state" AS ENUM('active', 'cleared');--> statement-breakpoint
CREATE TYPE "public"."incident_kind" AS ENUM('site_outage', 'device_down', 'flapping', 'interface', 'ups_power', 'service', 'monitoring_source_down', 'generic');--> statement-breakpoint
CREATE TYPE "public"."incident_status" AS ENUM('open', 'acknowledged', 'resolved', 'closed');--> statement-breakpoint
CREATE TYPE "public"."maintenance_scope" AS ENUM('global', 'site', 'node');--> statement-breakpoint
CREATE TYPE "public"."maintenance_suppress" AS ENUM('notifications', 'incidents');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('root', 'symptom', 'member');--> statement-breakpoint
CREATE TYPE "public"."priority" AS ENUM('P1', 'P2', 'P3', 'P4');--> statement-breakpoint
CREATE TYPE "public"."season_kind" AS ENUM('harvest', 'high_risk');--> statement-breakpoint
CREATE TABLE "alert_records" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"dedupe_key" text NOT NULL,
	"source" text DEFAULT 'orion' NOT NULL,
	"alert_id" integer,
	"alert_name" text NOT NULL,
	"entity_uri" text,
	"entity_type" text,
	"entity_caption" text,
	"node_id" integer,
	"interface_id" integer,
	"site_id" integer,
	"severity" text DEFAULT 'none' NOT NULL,
	"state" "alert_state" NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"last_raised_at" timestamp with time zone NOT NULL,
	"cleared_at" timestamp with time zone,
	"trigger_count" integer DEFAULT 1 NOT NULL,
	"current_alert_object_id" integer,
	"current_alert_active_id" bigint,
	"last_message" text,
	"acknowledged_in_orion" boolean DEFAULT false NOT NULL,
	"incident_id" bigint,
	"suppressed" boolean DEFAULT false NOT NULL,
	"seeded" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incident_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"incident_id" bigint NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"type" text NOT NULL,
	"actor" text DEFAULT 'system' NOT NULL,
	"message" text NOT NULL,
	"details" jsonb
);
--> statement-breakpoint
CREATE TABLE "incident_members" (
	"incident_id" bigint NOT NULL,
	"alert_record_id" bigint NOT NULL,
	"role" "member_role" DEFAULT 'member' NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incident_members_incident_id_alert_record_id_pk" PRIMARY KEY("incident_id","alert_record_id")
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"status" "incident_status" DEFAULT 'open' NOT NULL,
	"kind" "incident_kind" DEFAULT 'generic' NOT NULL,
	"correlation_key" text NOT NULL,
	"title" text NOT NULL,
	"template_summary" text DEFAULT '' NOT NULL,
	"ai_title" text,
	"ai_summary" jsonb,
	"ai_summary_at" timestamp with time zone,
	"ai_summary_rev" integer DEFAULT 0 NOT NULL,
	"priority" "priority" NOT NULL,
	"base_priority" "priority" NOT NULL,
	"base_score" real DEFAULT 0 NOT NULL,
	"priority_factors" jsonb NOT NULL,
	"ai_priority_adjust" smallint,
	"ai_priority_reason" text,
	"guardrail_note" text,
	"primary_site_id" integer,
	"division_code" text,
	"affected_site_ids" integer[] DEFAULT '{}'::int[] NOT NULL,
	"root_node_id" integer,
	"root_entity_uri" text,
	"recovery_target_min" integer NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"last_activity_at" timestamp with time zone NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" text,
	"resolve_pending_since" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"closed_at" timestamp with time zone,
	"snoozed_until" timestamp with time zone,
	"snoozed_by" text,
	"alert_count" integer DEFAULT 0 NOT NULL,
	"member_count" integer DEFAULT 0 NOT NULL,
	"material_rev" integer DEFAULT 0 NOT NULL,
	"in_maintenance" boolean DEFAULT false NOT NULL,
	"seeded" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_windows" (
	"id" serial PRIMARY KEY NOT NULL,
	"scope" "maintenance_scope" NOT NULL,
	"site_id" integer,
	"node_id" integer,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"recurrence" jsonb,
	"suppress" "maintenance_suppress" DEFAULT 'notifications' NOT NULL,
	"reason" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "season_periods" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" "season_kind" NOT NULL,
	"start_md" text NOT NULL,
	"end_md" text NOT NULL,
	"year" integer,
	"multiplier" real DEFAULT 1.2 NOT NULL,
	"divisions" text[],
	"harvest_critical_only" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alert_records" ADD CONSTRAINT "alert_records_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_events" ADD CONSTRAINT "incident_events_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_members" ADD CONSTRAINT "incident_members_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_members" ADD CONSTRAINT "incident_members_alert_record_id_alert_records_id_fk" FOREIGN KEY ("alert_record_id") REFERENCES "public"."alert_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_primary_site_id_sites_id_fk" FOREIGN KEY ("primary_site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_windows" ADD CONSTRAINT "maintenance_windows_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alert_records_dedupe_uq" ON "alert_records" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "alert_records_incident_idx" ON "alert_records" USING btree ("incident_id");--> statement-breakpoint
CREATE INDEX "alert_records_node_state_idx" ON "alert_records" USING btree ("node_id","state");--> statement-breakpoint
CREATE INDEX "alert_records_active_idx" ON "alert_records" USING btree ("state") WHERE "alert_records"."state" = 'active';--> statement-breakpoint
CREATE INDEX "incident_events_incident_idx" ON "incident_events" USING btree ("incident_id","at");--> statement-breakpoint
CREATE INDEX "incident_members_record_idx" ON "incident_members" USING btree ("alert_record_id");--> statement-breakpoint
CREATE INDEX "incidents_open_idx" ON "incidents" USING btree ("status") WHERE "incidents"."status" IN ('open','acknowledged');--> statement-breakpoint
CREATE INDEX "incidents_site_status_idx" ON "incidents" USING btree ("primary_site_id","status");--> statement-breakpoint
CREATE INDEX "incidents_opened_idx" ON "incidents" USING btree ("opened_at");--> statement-breakpoint
CREATE INDEX "maintenance_windows_ends_idx" ON "maintenance_windows" USING btree ("ends_at");