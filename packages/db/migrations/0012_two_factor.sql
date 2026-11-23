CREATE TABLE "account_passkeys" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"credential_id" text NOT NULL,
	"public_key" "bytea" NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"transports" text[] DEFAULT '{}'::text[] NOT NULL,
	"rp_id" text NOT NULL,
	"name" text NOT NULL,
	"device_type" text,
	"backed_up" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "account_passkeys_credential_id_unique" UNIQUE("credential_id")
);
--> statement-breakpoint
CREATE TABLE "account_recovery_codes" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"code_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "account_recovery_codes_uq" UNIQUE("account_id","code_hash")
);
--> statement-breakpoint
CREATE TABLE "auth_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"kind" text NOT NULL,
	"webauthn_challenge" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "local_accounts" ADD COLUMN "totp_secret" text;--> statement-breakpoint
ALTER TABLE "local_accounts" ADD COLUMN "totp_enabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "local_accounts" ADD COLUMN "totp_last_step" integer;--> statement-breakpoint
ALTER TABLE "account_passkeys" ADD CONSTRAINT "account_passkeys_account_id_local_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."local_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_recovery_codes" ADD CONSTRAINT "account_recovery_codes_account_id_local_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."local_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_challenges" ADD CONSTRAINT "auth_challenges_account_id_local_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."local_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_passkeys_account_idx" ON "account_passkeys" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "auth_challenges_expires_idx" ON "auth_challenges" USING btree ("expires_at");