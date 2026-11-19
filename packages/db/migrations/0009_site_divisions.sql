ALTER TABLE "sites" ADD COLUMN "division_codes" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "division_codes" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
UPDATE "sites" SET "division_codes" = ARRAY["division_code"] WHERE "division_code" IS NOT NULL;--> statement-breakpoint
UPDATE "incidents" SET "division_codes" = ARRAY["division_code"] WHERE "division_code" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "sites" DROP CONSTRAINT "sites_division_code_divisions_code_fk";--> statement-breakpoint
ALTER TABLE "sites" DROP COLUMN "division_code";--> statement-breakpoint
ALTER TABLE "incidents" DROP COLUMN "division_code";
