ALTER TABLE "mcp_server_instances" DROP CONSTRAINT "mcp_server_instances_server_name_mcp_servers_name_fk";
--> statement-breakpoint
ALTER TABLE "oauth_connection_states" DROP CONSTRAINT "oauth_connection_states_server_name_mcp_servers_name_fk";
--> statement-breakpoint
ALTER TABLE "user_mcp_credentials" DROP CONSTRAINT "user_mcp_credentials_server_name_mcp_servers_name_fk";
--> statement-breakpoint
ALTER TABLE "user_server_access" DROP CONSTRAINT "user_server_access_server_name_mcp_servers_name_fk";
--> statement-breakpoint
ALTER TABLE "mcp_server_instances" ADD CONSTRAINT "mcp_server_instances_server_name_mcp_servers_name_fk" FOREIGN KEY ("server_name") REFERENCES "public"."mcp_servers"("name") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "oauth_connection_states" ADD CONSTRAINT "oauth_connection_states_server_name_mcp_servers_name_fk" FOREIGN KEY ("server_name") REFERENCES "public"."mcp_servers"("name") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "user_mcp_credentials" ADD CONSTRAINT "user_mcp_credentials_server_name_mcp_servers_name_fk" FOREIGN KEY ("server_name") REFERENCES "public"."mcp_servers"("name") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "user_server_access" ADD CONSTRAINT "user_server_access_server_name_mcp_servers_name_fk" FOREIGN KEY ("server_name") REFERENCES "public"."mcp_servers"("name") ON DELETE cascade ON UPDATE cascade;