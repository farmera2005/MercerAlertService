CREATE TABLE "kiosk_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"allowed_cidrs" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"last_used_at" timestamp with time zone,
	"last_used_ip" text,
	CONSTRAINT "kiosk_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "setting_assets" (
	"key" text PRIMARY KEY NOT NULL,
	"content_type" text NOT NULL,
	"data" "bytea" NOT NULL,
	"width" integer,
	"height" integer,
	"sha256" text NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"entra_oid" text NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"name" text NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	CONSTRAINT "users_entra_oid_unique" UNIQUE("entra_oid")
);
--> statement-breakpoint
CREATE INDEX "kiosk_tokens_active_idx" ON "kiosk_tokens" USING btree ("revoked_at");