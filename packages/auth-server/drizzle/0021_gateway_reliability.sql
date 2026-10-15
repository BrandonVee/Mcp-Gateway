DROP INDEX "uq_alert_fingerprint";--> statement-breakpoint
ALTER TABLE "alert_events" ADD COLUMN "notification_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "alert_events" ADD COLUMN "next_notification_at" bigint;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "monitoring_logs_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "user_rate_limit_per_minute" integer DEFAULT 120 NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "user_daily_quota" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "user_max_concurrent" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "upstream_credentials" ADD COLUMN "validation_status" text DEFAULT 'saved' NOT NULL;--> statement-breakpoint
ALTER TABLE "upstream_credentials" ADD COLUMN "validated_at" bigint;--> statement-breakpoint
ALTER TABLE "user_mcp_credentials" ADD COLUMN "validation_status" text DEFAULT 'saved' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_mcp_credentials" ADD COLUMN "validated_at" bigint;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_alert_fingerprint" ON "alert_events" USING btree ("fingerprint") WHERE "alert_events"."resolved_at" IS NULL;