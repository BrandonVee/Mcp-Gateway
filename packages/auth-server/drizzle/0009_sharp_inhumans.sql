CREATE TABLE "mcp_call_events" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"started_at" bigint NOT NULL,
	"finished_at" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"username" text NOT NULL,
	"client_id" text NOT NULL,
	"server" text NOT NULL,
	"method" text NOT NULL,
	"tool" text NOT NULL,
	"outcome" text NOT NULL,
	"http_status" integer NOT NULL,
	"duration_ms" bigint,
	"error" text NOT NULL,
	"instance" text NOT NULL,
	"attempts" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_call_metrics" (
	"minute" bigint NOT NULL,
	"server" text NOT NULL,
	"method" text NOT NULL,
	"tool" text NOT NULL,
	"user_id" bigint NOT NULL,
	"client_id" text NOT NULL,
	"username" text NOT NULL,
	"outcome" text NOT NULL,
	"calls" bigint NOT NULL,
	"duration_sum" bigint NOT NULL,
	"duration_count" bigint NOT NULL,
	"histogram" bigint[] NOT NULL,
	CONSTRAINT "mcp_call_metrics_minute_server_method_tool_user_id_client_id_outcome_pk" PRIMARY KEY("minute","server","method","tool","user_id","client_id","outcome")
);
--> statement-breakpoint
CREATE TABLE "mcp_event_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"received_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_mcp_calls_time" ON "mcp_call_events" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "idx_mcp_calls_server_time" ON "mcp_call_events" USING btree ("server","started_at");--> statement-breakpoint
CREATE INDEX "idx_mcp_metrics_time" ON "mcp_call_metrics" USING btree ("minute");