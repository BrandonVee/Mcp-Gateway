ALTER TABLE "mcp_call_events" ADD COLUMN "input" text;--> statement-breakpoint
ALTER TABLE "mcp_call_events" ADD COLUMN "output" text;--> statement-breakpoint
CREATE INDEX "idx_mcp_calls_user_time" ON "mcp_call_events" USING btree ("user_id","started_at");