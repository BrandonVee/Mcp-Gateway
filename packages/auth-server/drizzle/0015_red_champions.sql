CREATE TABLE "alert_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"fingerprint" text NOT NULL,
	"server" text NOT NULL,
	"type" text NOT NULL,
	"value" double precision NOT NULL,
	"threshold" double precision NOT NULL,
	"first_seen_at" bigint NOT NULL,
	"last_seen_at" bigint NOT NULL,
	"resolved_at" bigint,
	"acknowledged_at" bigint,
	"acknowledged_by" text,
	"notified_at" bigint,
	"notification_error" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_alert_fingerprint" ON "alert_events" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "idx_alert_last_seen" ON "alert_events" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "idx_alert_open" ON "alert_events" USING btree ("resolved_at","last_seen_at");