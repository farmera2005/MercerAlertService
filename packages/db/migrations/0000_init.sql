CREATE TYPE "public"."actor_type" AS ENUM('user', 'kiosk', 'system');--> statement-breakpoint
CREATE TYPE "public"."poll_status" AS ENUM('ok', 'error', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."profile_status" AS ENUM('placeholder', 'auto', 'confirmed');--> statement-breakpoint
CREATE TYPE "public"."site_tier" AS ENUM('critical', 'high', 'standard');--> statement-breakpoint
CREATE TYPE "public"."transition_kind" AS ENUM('alert', 'node', 'interface', 'source');--> statement-breakpoint
CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "divisions" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"is_affiliate" boolean DEFAULT false NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"sort_order" smallint DEFAULT 100 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "node_site_overrides" (
	"node_id" integer PRIMARY KEY NOT NULL,
	"site_id" integer,
	"division_code" text,
	"device_role" text,
	"reason" text,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"division_code" text,
	"city" text,
	"state" text,
	"lat" double precision,
	"lon" double precision,
	"map_x" integer,
	"map_y" integer,
	"tier" "site_tier" DEFAULT 'standard' NOT NULL,
	"harvest_critical" boolean DEFAULT false NOT NULL,
	"business_hours" jsonb DEFAULT '{"days":[1,2,3,4,5],"start":"07:00","end":"17:00"}'::jsonb NOT NULL,
	"harvest_hours" jsonb,
	"owner_group" text,
	"contact_notes" text,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"profile_status" "profile_status" DEFAULT 'auto' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sites_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "orion_active_alerts" (
	"alert_active_id" bigint PRIMARY KEY NOT NULL,
	"alert_object_id" integer NOT NULL,
	"alert_id" integer NOT NULL,
	"alert_name" text NOT NULL,
	"severity" smallint DEFAULT 0 NOT NULL,
	"object_type" text,
	"triggered_at" timestamp with time zone,
	"message" text,
	"acknowledged" boolean DEFAULT false NOT NULL,
	"acknowledged_by" text,
	"acknowledged_at" timestamp with time zone,
	"entity_uri" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_caption" text,
	"related_node_id" integer,
	"related_node_caption" text,
	"node_id" integer,
	"interface_id" integer,
	"site_id" integer,
	"trigger_count" integer,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orion_alert_configs" (
	"alert_id" integer PRIMARY KEY NOT NULL,
	"alert_ref_id" text,
	"name" text NOT NULL,
	"description" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"severity" smallint DEFAULT 0 NOT NULL,
	"object_type" text,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orion_dependencies" (
	"dependency_id" integer PRIMARY KEY NOT NULL,
	"name" text,
	"parent_uri" text NOT NULL,
	"child_uri" text NOT NULL,
	"parent_entity_type" text,
	"child_entity_type" text,
	"parent_node_id" integer,
	"child_node_id" integer,
	"parent_container_id" integer,
	"child_container_id" integer,
	"auto_managed" boolean DEFAULT false NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orion_group_members" (
	"container_id" integer NOT NULL,
	"member_uri" text NOT NULL,
	"member_entity_type" text,
	"member_primary_id" integer,
	"name" text,
	"status" smallint,
	"node_id" integer,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orion_group_members_container_id_member_uri_pk" PRIMARY KEY("container_id","member_uri")
);
--> statement-breakpoint
CREATE TABLE "orion_groups" (
	"container_id" integer PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"status" smallint,
	"description" text,
	"uri" text,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orion_interfaces" (
	"interface_id" integer PRIMARY KEY NOT NULL,
	"node_id" integer NOT NULL,
	"name" text,
	"caption" text,
	"full_name" text,
	"alias" text,
	"type_description" text,
	"status" smallint,
	"status_norm" text DEFAULT 'unknown' NOT NULL,
	"oper_status" smallint,
	"admin_status" smallint,
	"in_percent_util" real,
	"out_percent_util" real,
	"in_bps" double precision,
	"out_bps" double precision,
	"speed_bps" double precision,
	"in_errors_hour" real,
	"out_errors_hour" real,
	"in_discards_hour" real,
	"out_discards_hour" real,
	"unmanaged" boolean DEFAULT false NOT NULL,
	"uri" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_polled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_status_change_at" timestamp with time zone,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "orion_nodes" (
	"node_id" integer PRIMARY KEY NOT NULL,
	"caption" text NOT NULL,
	"dns" text,
	"sys_name" text,
	"ip_address" text,
	"vendor" text,
	"machine_type" text,
	"status" smallint,
	"status_norm" text DEFAULT 'unknown' NOT NULL,
	"status_description" text,
	"response_time_ms" real,
	"percent_loss" real,
	"cpu_load" real,
	"percent_memory_used" real,
	"last_boot" timestamp with time zone,
	"unmanaged" boolean DEFAULT false NOT NULL,
	"object_sub_type" text,
	"location" text,
	"is_server" boolean,
	"uri" text,
	"custom_properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"site_id" integer,
	"division_code" text,
	"site_source" text DEFAULT 'none' NOT NULL,
	"device_role" text DEFAULT 'other' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_polled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_status_change_at" timestamp with time zone,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "orion_status_info" (
	"status_id" integer PRIMARY KEY NOT NULL,
	"status_name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "topology_connections" (
	"id" serial PRIMARY KEY NOT NULL,
	"src_node_id" integer NOT NULL,
	"src_interface_id" integer,
	"dest_node_id" integer NOT NULL,
	"dest_interface_id" integer,
	"layer_type" text,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_transitions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" "transition_kind" NOT NULL,
	"change" text NOT NULL,
	"entity_key" text NOT NULL,
	"node_id" integer,
	"interface_id" integer,
	"site_id" integer,
	"alert_object_id" integer,
	"alert_active_id" bigint,
	"from_state" text,
	"to_state" text NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_at" timestamp with time zone,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"correlated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "interface_metrics_5m" (
	"interface_id" integer NOT NULL,
	"bucket" timestamp with time zone NOT NULL,
	"samples" integer DEFAULT 1 NOT NULL,
	"in_util_avg" real,
	"in_util_max" real,
	"out_util_avg" real,
	"out_util_max" real,
	"in_bps_avg" real,
	"out_bps_avg" real,
	"in_errors" real,
	"out_errors" real,
	"in_discards" real,
	"out_discards" real,
	CONSTRAINT "interface_metrics_5m_interface_id_bucket_pk" PRIMARY KEY("interface_id","bucket")
);
--> statement-breakpoint
CREATE TABLE "node_metrics_5m" (
	"node_id" integer NOT NULL,
	"bucket" timestamp with time zone NOT NULL,
	"samples" integer DEFAULT 1 NOT NULL,
	"rt_avg" real,
	"rt_max" real,
	"loss_avg" real,
	"loss_max" real,
	"cpu_avg" real,
	"cpu_max" real,
	"mem_avg" real,
	"mem_max" real,
	CONSTRAINT "node_metrics_5m_node_id_bucket_pk" PRIMARY KEY("node_id","bucket")
);
--> statement-breakpoint
CREATE TABLE "orion_alert_history" (
	"alert_history_id" bigint PRIMARY KEY NOT NULL,
	"event_type" smallint NOT NULL,
	"message" text,
	"at" timestamp with time zone,
	"account_id" text,
	"alert_active_id" bigint,
	"alert_object_id" integer,
	"alert_id" integer,
	"entity_uri" text,
	"related_node_id" integer,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orion_events" (
	"event_id" bigint PRIMARY KEY NOT NULL,
	"event_time" timestamp with time zone,
	"event_type" integer NOT NULL,
	"event_type_name" text,
	"message" text,
	"node_id" integer,
	"net_object_id" text,
	"net_object_type" text,
	"acknowledged" boolean DEFAULT false NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" text,
	"actor_label" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"before" jsonb,
	"after" jsonb,
	"ip" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "component_heartbeats" (
	"component" text PRIMARY KEY NOT NULL,
	"last_beat_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" text,
	"host" text
);
--> statement-breakpoint
CREATE TABLE "poll_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"poller" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"status" "poll_status" NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"transition_count" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "poller_state" (
	"poller" text PRIMARY KEY NOT NULL,
	"last_started_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"last_error" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_duration_ms" integer,
	"last_row_count" integer,
	"cursor" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "node_site_overrides" ADD CONSTRAINT "node_site_overrides_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_site_overrides" ADD CONSTRAINT "node_site_overrides_division_code_divisions_code_fk" FOREIGN KEY ("division_code") REFERENCES "public"."divisions"("code") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_division_code_divisions_code_fk" FOREIGN KEY ("division_code") REFERENCES "public"."divisions"("code") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "orion_nodes" ADD CONSTRAINT "orion_nodes_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "orion_active_alerts_object_idx" ON "orion_active_alerts" USING btree ("alert_object_id");--> statement-breakpoint
CREATE INDEX "orion_active_alerts_node_idx" ON "orion_active_alerts" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "orion_active_alerts_site_idx" ON "orion_active_alerts" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "orion_dependencies_child_node_idx" ON "orion_dependencies" USING btree ("child_node_id");--> statement-breakpoint
CREATE INDEX "orion_group_members_node_idx" ON "orion_group_members" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "orion_interfaces_node_idx" ON "orion_interfaces" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "orion_nodes_site_idx" ON "orion_nodes" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "orion_nodes_status_idx" ON "orion_nodes" USING btree ("status_norm");--> statement-breakpoint
CREATE UNIQUE INDEX "topology_connections_uq" ON "topology_connections" USING btree ("src_node_id","src_interface_id","dest_node_id","dest_interface_id","layer_type");--> statement-breakpoint
CREATE INDEX "topology_connections_dest_idx" ON "topology_connections" USING btree ("dest_node_id");--> statement-breakpoint
CREATE INDEX "entity_transitions_pending_idx" ON "entity_transitions" USING btree ("id") WHERE "entity_transitions"."correlated_at" IS NULL;--> statement-breakpoint
CREATE INDEX "entity_transitions_node_idx" ON "entity_transitions" USING btree ("node_id","observed_at");--> statement-breakpoint
CREATE INDEX "entity_transitions_entity_idx" ON "entity_transitions" USING btree ("kind","entity_key","observed_at");--> statement-breakpoint
CREATE INDEX "entity_transitions_observed_idx" ON "entity_transitions" USING btree ("observed_at");--> statement-breakpoint
CREATE INDEX "interface_metrics_5m_bucket_idx" ON "interface_metrics_5m" USING btree ("bucket");--> statement-breakpoint
CREATE INDEX "node_metrics_5m_bucket_idx" ON "node_metrics_5m" USING btree ("bucket");--> statement-breakpoint
CREATE INDEX "orion_alert_history_alert_idx" ON "orion_alert_history" USING btree ("alert_id","at");--> statement-breakpoint
CREATE INDEX "orion_alert_history_at_idx" ON "orion_alert_history" USING btree ("at");--> statement-breakpoint
CREATE INDEX "orion_events_node_time_idx" ON "orion_events" USING btree ("node_id","event_time");--> statement-breakpoint
CREATE INDEX "orion_events_time_idx" ON "orion_events" USING btree ("event_time");--> statement-breakpoint
CREATE INDEX "audit_log_at_idx" ON "audit_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_log_target_idx" ON "audit_log" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "poll_runs_poller_started_idx" ON "poll_runs" USING btree ("poller","started_at");