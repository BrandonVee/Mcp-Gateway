ALTER TABLE "mcp_servers" ADD COLUMN "routing_mode" text DEFAULT 'pool' NOT NULL;--> statement-breakpoint
ALTER TABLE "upstream_oauth_states" ADD COLUMN "exchanging" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE mcp_servers ALTER COLUMN routing_mode SET DEFAULT 'aggregate';
