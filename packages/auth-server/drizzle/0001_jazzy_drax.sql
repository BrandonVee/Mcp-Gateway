CREATE TABLE "mcp_server_instances" (
	"id" text PRIMARY KEY NOT NULL,
	"server_name" text NOT NULL,
	"url" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_server_instances" ADD CONSTRAINT "mcp_server_instances_server_name_mcp_servers_name_fk" FOREIGN KEY ("server_name") REFERENCES "public"."mcp_servers"("name") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_mcp_instance_server" ON "mcp_server_instances" USING btree ("server_name");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_mcp_instance_server_url" ON "mcp_server_instances" USING btree ("server_name","url");