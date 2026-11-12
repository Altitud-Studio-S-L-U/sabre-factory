export interface paths {
    "/health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Health */
        get: operations["health_health_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/commands": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Execute Command */
        post: operations["execute_command_api_v1_commands_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Status */
        get: operations["status_api_v1_status_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/agents": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Agent Catalog */
        get: operations["agent_catalog_api_v1_agents_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/agents/activity": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Agents Activity */
        get: operations["agents_activity_api_v1_agents_activity_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/agents/{agent_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Agent Definition */
        get: operations["agent_definition_api_v1_agents__agent_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/agents/{agent_id}/draft": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Save Agent Draft */
        put: operations["save_agent_draft_api_v1_agents__agent_id__draft_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/agents/{agent_id}/validate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Validate Agent Draft */
        post: operations["validate_agent_draft_api_v1_agents__agent_id__validate_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/agents/{agent_id}/publish": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Publish Agent Draft */
        post: operations["publish_agent_draft_api_v1_agents__agent_id__publish_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/model-configuration": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Model Configuration */
        get: operations["model_configuration_api_v1_model_configuration_get"];
        /** Change Model Configuration */
        put: operations["change_model_configuration_api_v1_model_configuration_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/system": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** System */
        get: operations["system_api_v1_system_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/integrations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Integrations */
        get: operations["integrations_api_v1_integrations_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/integrations/{integration_id}/state": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Integration State */
        post: operations["integration_state_api_v1_integrations__integration_id__state_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/mcp-connections": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Mcp Connections */
        get: operations["mcp_connections_api_v1_mcp_connections_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/mcp-connections/{name}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Save Mcp Connection */
        put: operations["save_mcp_connection_api_v1_mcp_connections__name__put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/mcp-connections/{name}/discover": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Discover Mcp Connection */
        post: operations["discover_mcp_connection_api_v1_mcp_connections__name__discover_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repository-proposals": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Repository Proposals */
        get: operations["repository_proposals_api_v1_repository_proposals_get"];
        put?: never;
        /** Propose Repository */
        post: operations["propose_repository_api_v1_repository_proposals_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/create-flows": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create Repository Flow */
        post: operations["create_repository_flow_api_v1_create_flows_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repository-proposals/{proposal_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Repository Proposal */
        get: operations["repository_proposal_api_v1_repository_proposals__proposal_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repository-proposals/{proposal_id}/decision": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Decide Repository */
        post: operations["decide_repository_api_v1_repository_proposals__proposal_id__decision_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/repository-proposals/{proposal_id}/reconcile": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Reconcile Repository */
        post: operations["reconcile_repository_api_v1_repository_proposals__proposal_id__reconcile_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/integrations/github/repositories/search": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Github Repositories */
        post: operations["github_repositories_api_v1_integrations_github_repositories_search_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/integrations/github/import": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Github Import */
        post: operations["github_import_api_v1_integrations_github_import_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/chat": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Chat */
        post: operations["chat_api_v1_chat_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/operator/messages": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Operator Messages */
        get: operations["operator_messages_api_v1_operator_messages_get"];
        put?: never;
        /** Operator Message */
        post: operations["operator_message_api_v1_operator_messages_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/operator/messages/{message_id}/tools": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Operator Message Tools */
        get: operations["operator_message_tools_api_v1_operator_messages__message_id__tools_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/operator/readiness": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Operator Readiness */
        get: operations["operator_readiness_api_v1_operator_readiness_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/operator/messages/{message_id}/resume": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Resume Operator Message */
        post: operations["resume_operator_message_api_v1_operator_messages__message_id__resume_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Projects */
        get: operations["projects_api_v1_projects_get"];
        put?: never;
        /** Create Project */
        post: operations["create_project_api_v1_projects_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{project_id}/mcp-tools": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Project Tools */
        get: operations["project_tools_api_v1_projects__project_id__mcp_tools_get"];
        /** Change Project Tools */
        put: operations["change_project_tools_api_v1_projects__project_id__mcp_tools_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/notifications": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Notification Statuses */
        get: operations["notification_statuses_api_v1_notifications_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/notifications/{delivery_id}/retry": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Retry Notification */
        post: operations["retry_notification_api_v1_notifications__delivery_id__retry_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/flows/schema": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Flow Configuration Schema */
        get: operations["flow_configuration_schema_api_v1_flows_schema_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/flows/parse": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Parse Flow */
        post: operations["parse_flow_api_v1_flows_parse_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work/{work_id}/execution-events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Execution Events */
        get: operations["execution_events_api_v1_work__work_id__execution_events_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Works */
        get: operations["works_api_v1_work_get"];
        put?: never;
        /** Submit */
        post: operations["submit_api_v1_work_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work/{work_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Work */
        get: operations["work_api_v1_work__work_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work/{work_id}/usage": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Work Usage */
        get: operations["work_usage_api_v1_work__work_id__usage_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work/{work_id}/budget": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Work Budget */
        get: operations["work_budget_api_v1_work__work_id__budget_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work/{work_id}/budget/amend": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Amend Work Budget */
        post: operations["amend_work_budget_api_v1_work__work_id__budget_amend_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work/{work_id}/budget/reconcile": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Reconcile Work Budget */
        post: operations["reconcile_work_budget_api_v1_work__work_id__budget_reconcile_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work/{work_id}/answer": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Answer */
        post: operations["answer_api_v1_work__work_id__answer_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work/{work_id}/pause": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Pause */
        post: operations["pause_api_v1_work__work_id__pause_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work/{work_id}/resume": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Resume */
        post: operations["resume_api_v1_work__work_id__resume_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work/{work_id}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Cancel */
        post: operations["cancel_api_v1_work__work_id__cancel_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work/{work_id}/scope": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Scope */
        post: operations["scope_api_v1_work__work_id__scope_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work/{work_id}/budget/tokens": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Increase Token Budget */
        post: operations["increase_token_budget_api_v1_work__work_id__budget_tokens_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work/{work_id}/budget/calls": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Increase Call Budget */
        post: operations["increase_call_budget_api_v1_work__work_id__budget_calls_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work/{work_id}/cli-progress-limits": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Use Cli Progress Limits */
        post: operations["use_cli_progress_limits_api_v1_work__work_id__cli_progress_limits_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work/{work_id}/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Events */
        get: operations["events_api_v1_work__work_id__events_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work/{work_id}/audit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Work Audit */
        get: operations["work_audit_api_v1_work__work_id__audit_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{project_id}/knowledge": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Project Knowledge */
        get: operations["project_knowledge_api_v1_projects__project_id__knowledge_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/memory": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Memories */
        get: operations["memories_api_v1_memory_get"];
        put?: never;
        /** Propose Memory */
        post: operations["propose_memory_api_v1_memory_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/memory/search": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Memory Search */
        get: operations["memory_search_api_v1_memory_search_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/memory/{memory_id}/approve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Approve Memory */
        post: operations["approve_memory_api_v1_memory__memory_id__approve_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/memory/{memory_id}/carry-forward": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Carry Memory Forward */
        post: operations["carry_memory_forward_api_v1_memory__memory_id__carry_forward_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/memory/{memory_id}/invalidate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Invalidate Memory */
        post: operations["invalidate_memory_api_v1_memory__memory_id__invalidate_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{project_id}/memory/graph": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Memory Graph */
        get: operations["memory_graph_api_v1_projects__project_id__memory_graph_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{project_id}/memory/recalls": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Memory Recalls */
        get: operations["memory_recalls_api_v1_projects__project_id__memory_recalls_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{project_id}/memory/items": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Memory Items */
        get: operations["memory_items_api_v1_projects__project_id__memory_items_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{project_id}/memory/review": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Memory Review */
        get: operations["memory_review_api_v1_projects__project_id__memory_review_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/memory/{memory_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Memory Detail */
        get: operations["memory_detail_api_v1_memory__memory_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/secret-targets": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Secret Targets */
        get: operations["secret_targets_api_v1_secret_targets_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/secrets": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Secrets */
        get: operations["secrets_api_v1_secrets_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/secrets/{secret_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Upsert Secret */
        post: operations["upsert_secret_api_v1_secrets__secret_id__post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/secrets/{secret_id}/deactivate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Deactivate Secret */
        post: operations["deactivate_secret_api_v1_secrets__secret_id__deactivate_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/security": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Security */
        get: operations["security_api_v1_security_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work/{work_id}/security-exceptions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Security Exceptions */
        get: operations["security_exceptions_api_v1_work__work_id__security_exceptions_get"];
        put?: never;
        /** Approve Security Exception */
        post: operations["approve_security_exception_api_v1_work__work_id__security_exceptions_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work/{work_id}/security-exceptions/{exception_id}/revoke": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Revoke Security Exception */
        post: operations["revoke_security_exception_api_v1_work__work_id__security_exceptions__exception_id__revoke_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/.well-known/agent-card.json": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Discovery */
        get: operations["discovery__well_known_agent_card_json_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/a2a": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Ingress */
        post: operations["ingress_a2a_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/delegations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Grants */
        get: operations["grants_api_v1_delegations_get"];
        put?: never;
        /** Issue */
        post: operations["issue_api_v1_delegations_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/delegations/{identifier}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Revoke */
        delete: operations["revoke_api_v1_delegations__identifier__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/a2a/agents": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Agents */
        get: operations["agents_api_v1_a2a_agents_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/a2a/agents/{name}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Register */
        put: operations["register_api_v1_a2a_agents__name__put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/a2a/agents/{name}/discover": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Inspect */
        post: operations["inspect_api_v1_a2a_agents__name__discover_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work/{work_id}/a2a-tasks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Remote Tasks */
        get: operations["remote_tasks_api_v1_work__work_id__a2a_tasks_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work/{work_id}/a2a-tasks/poll": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Poll Remote */
        post: operations["poll_remote_api_v1_work__work_id__a2a_tasks_poll_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work/{work_id}/a2a-tasks/answer": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Answer Remote */
        post: operations["answer_remote_api_v1_work__work_id__a2a_tasks_answer_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work/{work_id}/a2a-tasks/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Cancel Remote */
        post: operations["cancel_remote_api_v1_work__work_id__a2a_tasks_cancel_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work/{work_id}/browser-qa": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Run */
        post: operations["run_api_v1_work__work_id__browser_qa_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work/{work_id}/browser-reports": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Reports */
        get: operations["reports_api_v1_work__work_id__browser_reports_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work/{work_id}/browser-artifacts/{artifact_digest}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Artifact */
        get: operations["artifact_api_v1_work__work_id__browser_artifacts__artifact_digest__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/flows/{mode}/topology": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Flow Topology */
        get: operations["flow_topology_api_v1_flows__mode__topology_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tools/catalog": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Builtin Tools */
        get: operations["builtin_tools_api_v1_tools_catalog_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/configuration": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Configuration */
        get: operations["configuration_api_v1_configuration_get"];
        /** Save Configuration */
        put: operations["save_configuration_api_v1_configuration_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/configuration/preview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Preview Configuration */
        post: operations["preview_configuration_api_v1_configuration_preview_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/configuration/history": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Configuration History */
        get: operations["configuration_history_api_v1_configuration_history_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/confirmations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Confirmations */
        get: operations["confirmations_api_v1_confirmations_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/confirmations/{confirmation_id}/confirm": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Confirm */
        post: operations["confirm_api_v1_confirmations__confirmation_id__confirm_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/confirmations/{confirmation_id}/reject": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Reject */
        post: operations["reject_api_v1_confirmations__confirmation_id__reject_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/work/{work_id}/inspection": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Inspection */
        get: operations["inspection_api_v1_work__work_id__inspection_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/projects/{project_id}/ingestion": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Ingestion Report */
        get: operations["ingestion_report_api_v1_projects__project_id__ingestion_get"];
        put?: never;
        /** Request Ingestion */
        post: operations["request_ingestion_api_v1_projects__project_id__ingestion_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/releases": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Releases */
        get: operations["releases_api_v1_releases_get"];
        put?: never;
        /** Prepare */
        post: operations["prepare_api_v1_releases_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/releases/{candidate_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Candidate */
        get: operations["candidate_api_v1_releases__candidate_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/releases/{candidate_id}/artifacts/{artifact_digest}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Artifact */
        get: operations["artifact_api_v1_releases__candidate_id__artifacts__artifact_digest__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/releases/{candidate_id}/authorize": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Authorize */
        post: operations["authorize_api_v1_releases__candidate_id__authorize_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/releases/{candidate_id}/publish": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Publish */
        post: operations["publish_api_v1_releases__candidate_id__publish_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        /** A2AAgentInfo */
        A2AAgentInfo: {
            /** Name */
            name: string;
            /** Endpoint */
            endpoint: string;
            /** Revision */
            revision: number;
            /** Card */
            card: {
                [key: string]: unknown;
            };
            /** Digest */
            digest: string;
            /** Enabled */
            enabled: boolean;
            /** Projects */
            projects: string[];
            /** Roles */
            roles: string[];
            /** Skills */
            skills: string[];
            /** Credential Id */
            credential_id: string;
            /**
             * Cost
             * @default unknown
             * @constant
             */
            cost: "unknown";
        };
        /** A2AInputAnswer */
        A2AInputAnswer: {
            /** Attempt Key */
            attempt_key: string;
            /** Answer */
            answer: string;
            /** Expected Input Digest */
            expected_input_digest: string;
        };
        /** A2AReceiptRequest */
        A2AReceiptRequest: {
            /** Attempt Key */
            attempt_key: string;
        };
        /** A2ATaskInfo */
        A2ATaskInfo: {
            /** Attempt Key */
            attempt_key: string;
            /** Work Id */
            work_id: string;
            /** Agent Name */
            agent_name: string;
            /** Remote Task Id */
            remote_task_id: string | null;
            /** Remote Context Id */
            remote_context_id: string | null;
            /** State */
            state: string;
            /** Result */
            result: {
                [key: string]: unknown;
            } | null;
            /** Cost Usd */
            cost_usd: number | null;
            /**
             * Updated At
             * Format: date-time
             */
            updated_at: string;
            /** Input Digest */
            input_digest: string | null;
        };
        /** ActiveRun */
        ActiveRun: {
            /** Work Id */
            work_id: string;
            /** Project Id */
            project_id: string;
            /** Status */
            status: string;
            /** Stage */
            stage: string;
            /**
             * Updated At
             * Format: date-time
             */
            updated_at: string;
        };
        /** AgentActivity */
        AgentActivity: {
            /** Days */
            days: number;
            /**
             * Since
             * Format: date-time
             */
            since: string;
            /** Roles */
            roles: components["schemas"]["RoleActivity"][];
            /**
             * Repair Cycles
             * @description Repair cycles used by runs updated in the window
             */
            repair_cycles: number;
            /**
             * Waiting For Input
             * @description Runs currently waiting for an owner answer
             */
            waiting_for_input: number;
            /**
             * Active Runs
             * @description Queued or running runs with their current stage, newest first, at most 50
             */
            active_runs: components["schemas"]["ActiveRun"][];
            /** Active Runs Truncated */
            active_runs_truncated: boolean;
        };
        /** AgentCardDiscovery */
        AgentCardDiscovery: {
            /** Card */
            card: {
                [key: string]: unknown;
            };
            /** Reviewed Digest */
            reviewed_digest: string;
            /** Endpoint */
            endpoint: string;
            /**
             * Execution Authorized
             * @default false
             * @constant
             */
            execution_authorized: false;
        };
        /** AgentCatalog */
        AgentCatalog: {
            /**
             * Version
             * @default 1
             * @constant
             */
            version: 1;
            /** Agents */
            agents: components["schemas"]["AgentCatalogEntry"][];
        };
        /** AgentCatalogEntry */
        AgentCatalogEntry: {
            /**
             * Id
             * @enum {string}
             */
            id: "pm" | "designer" | "developer" | "qa" | "manager" | "devops" | "ciso";
            /** Label */
            label: string;
            /** Legacy Roles */
            legacy_roles: string[];
            /** Revision */
            revision: number;
            draft: components["schemas"]["AgentDefinition-Output"];
            published: components["schemas"]["AgentDefinitionSnapshot"];
            /** Versions */
            versions: components["schemas"]["AgentDefinitionSnapshot"][];
            validation: components["schemas"]["AgentValidation"];
        };
        /** AgentContextPolicy */
        "AgentContextPolicy-Input": {
            /**
             * Max Input Bytes
             * @default 98304
             */
            max_input_bytes: number;
            /**
             * Visual Review
             * @default false
             */
            visual_review: boolean;
        };
        /** AgentContextPolicy */
        "AgentContextPolicy-Output": {
            /**
             * Max Input Bytes
             * @default 98304
             */
            max_input_bytes: number;
            /**
             * Visual Review
             * @default false
             */
            visual_review: boolean;
        };
        /** AgentDefinition */
        "AgentDefinition-Input": {
            /**
             * Version
             * @constant
             */
            version: 1;
            /**
             * Id
             * @enum {string}
             */
            id: "pm" | "designer" | "developer" | "qa" | "manager" | "devops" | "ciso";
            /** Label */
            label: string;
            /** Instructions */
            instructions: string;
            /** Chains */
            chains: components["schemas"]["ChainDefinition-Input"][];
            /** Skills */
            skills?: components["schemas"]["SkillReference"][];
            model?: components["schemas"]["ModelSelection-Input"] | null;
            /** Tools */
            tools?: string[] | null;
            context?: components["schemas"]["AgentContextPolicy-Input"];
        };
        /** AgentDefinition */
        "AgentDefinition-Output": {
            /**
             * Version
             * @constant
             */
            version: 1;
            /**
             * Id
             * @enum {string}
             */
            id: "pm" | "designer" | "developer" | "qa" | "manager" | "devops" | "ciso";
            /** Label */
            label: string;
            /** Instructions */
            instructions: string;
            /** Chains */
            chains: components["schemas"]["ChainDefinition-Output"][];
            /** Skills */
            skills: components["schemas"]["SkillReference"][];
            model: components["schemas"]["ModelSelection-Output"] | null;
            /** Tools */
            tools: string[] | null;
            context: components["schemas"]["AgentContextPolicy-Output"];
        };
        /** AgentDefinitionSnapshot */
        AgentDefinitionSnapshot: {
            /** Version */
            version: number;
            /** Digest */
            digest: string;
            definition: components["schemas"]["AgentDefinition-Output"];
        };
        /** AgentDraftSave */
        AgentDraftSave: {
            /** Expected Revision */
            expected_revision: number;
            definition: components["schemas"]["AgentDefinition-Input"];
        };
        /** AgentRegistration */
        AgentRegistration: {
            /** Expected Revision */
            expected_revision: number;
            /** Endpoint */
            endpoint: string;
            /** Card */
            card: {
                [key: string]: unknown;
            };
            /** Reviewed Digest */
            reviewed_digest: string;
            /**
             * Enabled
             * @default false
             */
            enabled: boolean;
            /** Projects */
            projects: string[];
            /** Roles */
            roles?: string[];
            /** Skills */
            skills?: string[];
        };
        /** AgentRevision */
        AgentRevision: {
            /** Expected Revision */
            expected_revision: number;
        };
        /** AgentValidation */
        AgentValidation: {
            /** Valid */
            valid: boolean;
            /** Errors */
            errors: string[];
        };
        /** AmendBudget */
        AmendBudget: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "work.budget.amend";
            /** Work Id */
            work_id: string;
            request: components["schemas"]["BudgetAmendment"];
        };
        /** Answer */
        Answer: {
            /** Question Id */
            question_id: string;
            /** Plan Revision */
            plan_revision: number;
            /** Answer */
            answer: string;
        };
        /** ApplicationInfo */
        ApplicationInfo: {
            /**
             * Name
             * @default SABRE
             * @constant
             */
            name: "SABRE";
            /** Version */
            version: string | null;
            /** Graph Version */
            graph_version: string;
        };
        /** ArtifactReference */
        ArtifactReference: {
            /**
             * Version
             * @constant
             */
            version: 1;
            /** Id */
            id: string;
            /** Digest */
            digest: string;
            /** Media Type */
            media_type: string;
            /** Size Bytes */
            size_bytes: number;
            /** Name */
            name: string;
        };
        /** AuditAgent */
        AuditAgent: {
            /** Id */
            id: string;
            /** Role */
            role: string;
            /** Plan Revision */
            plan_revision: number;
            /**
             * Model Responses
             * @default 0
             */
            model_responses: number;
            /**
             * Input Tokens
             * @default 0
             */
            input_tokens: number;
            /**
             * Output Tokens
             * @default 0
             */
            output_tokens: number;
            /**
             * Cache Read Tokens
             * @default 0
             */
            cache_read_tokens: number;
            /**
             * Tool Requests
             * @default 0
             */
            tool_requests: number;
            /**
             * Tool Responses
             * @default 0
             */
            tool_responses: number;
            /**
             * Notes Recorded
             * @default 0
             */
            notes_recorded: number;
            /** Last Checkpoint At */
            last_checkpoint_at: string | null;
            /** Duration Ms */
            duration_ms: number | null;
        };
        /**
         * AuditCall
         * @description One model invocation in reservation order. Values the provider did not report stay None.
         */
        AuditCall: {
            /** Sequence */
            sequence: number;
            /** Role */
            role: ("supervisor" | "analyst" | "architect" | "developer" | "qa" | "reviewer" | "security" | "designer" | "devops") | null;
            /** Model Provider */
            model_provider: ("openai" | "local" | "anthropic" | "google" | "codex_cli" | "claude_cli") | null;
            /** Model Name */
            model_name: string | null;
            /** Reserved Tokens */
            reserved_tokens: number;
            /** Measured Tokens */
            measured_tokens: number | null;
            /** Input Tokens */
            input_tokens: number | null;
            /** Output Tokens */
            output_tokens: number | null;
            /** Cache Read Tokens */
            cache_read_tokens: number | null;
            /** Sent Bytes */
            sent_bytes: number | null;
            /** Original Bytes */
            original_bytes: number | null;
            /** Call Ms */
            call_ms: number | null;
        };
        /** AuditModelUsage */
        AuditModelUsage: {
            /** Model Provider */
            model_provider: ("openai" | "local" | "anthropic" | "google" | "codex_cli" | "claude_cli") | null;
            /** Model Name */
            model_name: string | null;
            /** Role */
            role: ("supervisor" | "analyst" | "architect" | "developer" | "qa" | "reviewer" | "security" | "designer" | "devops") | null;
            /** Configuration Revision */
            configuration_revision: number | null;
            /** Calls */
            calls: number;
            /** Settled Calls */
            settled_calls: number;
            /** Measured Tokens */
            measured_tokens: number;
            /** Unknown Reserved Tokens */
            unknown_reserved_tokens: number;
            /** Cost Usd */
            cost_usd: number;
            /** Input Tokens */
            input_tokens: number | null;
            /** Output Tokens */
            output_tokens: number | null;
            /** Cache Read Tokens */
            cache_read_tokens: number | null;
            /**
             * Unsplit Calls
             * @default 0
             */
            unsplit_calls: number;
        };
        /** AuditTool */
        AuditTool: {
            /** Id */
            id: string;
            /** Agent Id */
            agent_id: string;
            /** Role */
            role: string;
            /** Plan Revision */
            plan_revision: number;
            /** Name */
            name: string;
            /** Sequence */
            sequence: number;
            /**
             * Response
             * @default requested
             * @enum {string}
             */
            response: "requested" | "received" | "error";
            /** Exit Code */
            exit_code: number | null;
            /** Output Digest */
            output_digest: string | null;
            /** Duration Ms */
            duration_ms: null;
        };
        /**
         * AuditToolTiming
         * @description Measured tool boundaries per agent and tool name; output_bytes is the result size sent to the model.
         */
        AuditToolTiming: {
            /** Agent Id */
            agent_id: string;
            /** Name */
            name: string;
            /** Count */
            count: number;
            /** Failed */
            failed: number;
            /** Total Ms */
            total_ms: number;
            /** Max Ms */
            max_ms: number;
            /** Output Bytes */
            output_bytes: number | null;
        };
        /** AuditUsage */
        AuditUsage: {
            /** Calls */
            calls: number;
            /** Settled Calls */
            settled_calls: number;
            /** Unsettled Calls */
            unsettled_calls: number;
            /** Tokens */
            tokens: number;
            /** Measured Tokens */
            measured_tokens: number;
            /** Unknown Reserved Tokens */
            unknown_reserved_tokens: number;
            /** Cost Usd */
            cost_usd: number;
        };
        /** AuditView */
        AuditView: {
            /** Work Id */
            work_id: string;
            /** Plan Revision */
            plan_revision: number;
            /** Status */
            status: string;
            /** Phase */
            phase: string;
            usage: components["schemas"]["AuditUsage"];
            context: components["schemas"]["ContextUsageSummary"] | null;
            /** Models */
            models: components["schemas"]["AuditModelUsage"][];
            /** Agents */
            agents: components["schemas"]["AuditAgent"][];
            /** Tools */
            tools: components["schemas"]["AuditTool"][];
            /** Calls */
            calls: components["schemas"]["AuditCall"][];
            /**
             * Calls Truncated
             * @default false
             */
            calls_truncated: boolean;
            /** Tool Timings */
            tool_timings: components["schemas"]["AuditToolTiming"][];
            /** Checkpoint Count */
            checkpoint_count: number;
            /** Checkpoint Threads */
            checkpoint_threads: number;
            /** Truncated */
            truncated: boolean;
        };
        /** BrowserEvidence */
        BrowserEvidence: {
            /**
             * Kind
             * @enum {string}
             */
            kind: "screenshot" | "trace" | "report";
            /** Digest */
            digest: string;
            /** Media Type */
            media_type: string;
            /** Size */
            size: number;
            /** Viewport */
            viewport: string | null;
            /**
             * Review Required
             * @default false
             */
            review_required: boolean;
        };
        /** BrowserJob */
        BrowserJob: {
            /**
             * Version
             * @default 1
             * @constant
             */
            version: 1;
            /** Idempotency Key */
            idempotency_key: string;
            /** Snapshot Digest */
            snapshot_digest: string;
            /** Viewports */
            viewports?: ("desktop" | "mobile")[];
            /** Operations */
            operations: components["schemas"]["BrowserOperation"][];
            /**
             * Accessibility
             * @default true
             */
            accessibility: boolean;
            /**
             * Trace
             * @default true
             */
            trace: boolean;
        };
        /** BrowserOperation */
        BrowserOperation: {
            /**
             * Action
             * @enum {string}
             */
            action: "navigate" | "click" | "fill" | "press" | "expect_text" | "expect_visible" | "expect_focus";
            /**
             * Target
             * @default
             */
            target: string;
            /**
             * Role
             * @default button
             * @enum {string}
             */
            role: "button" | "link" | "textbox" | "checkbox" | "radio" | "combobox" | "heading" | "tab";
            /**
             * Value
             * @default
             */
            value: string;
        };
        /** BrowserPreview */
        "BrowserPreview-Input": {
            /**
             * Version
             * @default 1
             * @constant
             */
            version: 1;
            /** Command */
            command: string[];
            /** Port */
            port: number;
            /**
             * Synthetic Data
             * @constant
             */
            synthetic_data: true;
        };
        /** BrowserPreview */
        "BrowserPreview-Output": {
            /**
             * Version
             * @default 1
             * @constant
             */
            version: 1;
            /** Command */
            command: string[];
            /** Port */
            port: number;
            /**
             * Synthetic Data
             * @constant
             */
            synthetic_data: true;
        };
        /** BrowserReport */
        BrowserReport: {
            /**
             * Version
             * @default 1
             * @constant
             */
            version: 1;
            /**
             * Evaluator
             * @default playwright-1.64.0+axe-core-4.11.0
             * @constant
             */
            evaluator: "playwright-1.64.0+axe-core-4.11.0";
            /** Snapshot Digest */
            snapshot_digest: string;
            /** Work Id */
            work_id: string;
            /** Passed */
            passed: boolean;
            /** Results */
            results: {
                [key: string]: unknown;
            }[];
            /** Artifacts */
            artifacts: components["schemas"]["BrowserEvidence"][];
            /**
             * Visual Review
             * @default unavailable
             * @constant
             */
            visual_review: "unavailable";
        };
        /** Budget */
        "Budget-Input": {
            /**
             * Max Calls
             * @description Maximum model-adapter invocations; null uses CLI progress controls with no cumulative quota
             * @default 40
             */
            max_calls: number | null;
            /**
             * Max Tokens
             * @default 100000
             */
            max_tokens: number | null;
            /**
             * Max Cost Usd
             * @description API spend authorization; zero permits only invocations with no API charge recorded by SABRE
             * @default 0
             */
            max_cost_usd: number;
            /**
             * Active Seconds
             * @default 3600
             */
            active_seconds: number | null;
            policy?: components["schemas"]["BudgetPolicy-Input"] | null;
        };
        /** Budget */
        "Budget-Output": {
            /**
             * Max Calls
             * @description Maximum model-adapter invocations; null uses CLI progress controls with no cumulative quota
             * @default 40
             */
            max_calls: number | null;
            /**
             * Max Tokens
             * @default 100000
             */
            max_tokens: number | null;
            /**
             * Max Cost Usd
             * @description API spend authorization; zero permits only invocations with no API charge recorded by SABRE
             * @default 0
             */
            max_cost_usd: number;
            /**
             * Active Seconds
             * @default 3600
             */
            active_seconds: number | null;
            policy?: components["schemas"]["BudgetPolicy-Output"] | null;
        };
        /** BudgetAmendment */
        BudgetAmendment: {
            /**
             * Version
             * @constant
             */
            version: 1;
            /** Expected Revision */
            expected_revision: number;
            /**
             * Metric
             * @enum {string}
             */
            metric: "tokens" | "invocations" | "active_seconds" | "repairs";
            policy: components["schemas"]["MetricBudget-Input"];
            /** Reason */
            reason: string;
            /**
             * Resume
             * @default false
             */
            resume: boolean;
        };
        /** BudgetAuthorization */
        BudgetAuthorization: {
            /**
             * Version
             * @default 1
             * @constant
             */
            version: 1;
            /** Revision */
            revision: number;
            /**
             * Metric
             * @enum {string}
             */
            metric: "tokens" | "invocations" | "active_seconds" | "repairs";
            /**
             * Operation
             * @enum {string}
             */
            operation: "amend" | "reserve_activation" | "usage_reconciliation";
            before: components["schemas"]["MetricBudget-Output"];
            after: components["schemas"]["MetricBudget-Output"];
            /** Reason */
            reason: string;
            /** Usage Ids */
            usage_ids: string[];
        };
        /** BudgetDenial */
        BudgetDenial: {
            /**
             * Version
             * @default 1
             * @constant
             */
            version: 1;
            /**
             * Metric
             * @enum {string}
             */
            metric: "tokens" | "invocations" | "active_seconds" | "repairs" | "api_spend" | "factory_spend" | "unknown";
            /**
             * Basis
             * @enum {string}
             */
            basis: "next_reservation" | "consumed_limit" | "historical_unknown";
            /** Used */
            used: number | null;
            /** Reserved */
            reserved: number | null;
            /** Requested */
            requested: number | null;
            /** Required */
            required: number | null;
            /** Limit */
            limit: number | null;
        };
        /** BudgetMetricView */
        BudgetMetricView: {
            policy: components["schemas"]["MetricBudget-Output"];
            /** Used */
            used: number | null;
            /** Reserved */
            reserved: number;
            /** Remaining */
            remaining: number | null;
            /** Unknown */
            unknown: boolean;
        };
        /** BudgetPolicy */
        "BudgetPolicy-Input": {
            /**
             * Version
             * @constant
             */
            version: 1;
            tokens?: components["schemas"]["MetricBudget-Input"];
            invocations?: components["schemas"]["MetricBudget-Input"];
            active_seconds?: components["schemas"]["MetricBudget-Input"];
            repairs?: components["schemas"]["MetricBudget-Input"];
            /**
             * No Progress Threshold
             * @default 3
             */
            no_progress_threshold: number;
        };
        /** BudgetPolicy */
        "BudgetPolicy-Output": {
            /**
             * Version
             * @constant
             */
            version: 1;
            tokens: components["schemas"]["MetricBudget-Output"];
            invocations: components["schemas"]["MetricBudget-Output"];
            active_seconds: components["schemas"]["MetricBudget-Output"];
            repairs: components["schemas"]["MetricBudget-Output"];
            /**
             * No Progress Threshold
             * @default 3
             */
            no_progress_threshold: number;
        };
        /** BudgetReconciliation */
        BudgetReconciliation: {
            /**
             * Version
             * @constant
             */
            version: 1;
            /** Expected Revision */
            expected_revision: number;
            /** Usage Ids */
            usage_ids: string[];
            /** Reason */
            reason: string;
        };
        /** BudgetView */
        BudgetView: {
            /**
             * Version
             * @default 1
             * @constant
             */
            version: 1;
            /** Revision */
            revision: number;
            /** Metrics */
            metrics: {
                [key: string]: components["schemas"]["BudgetMetricView"];
            };
            /** Authorizations */
            authorizations: components["schemas"]["BudgetAuthorization"][];
            /** Limiting Metric */
            limiting_metric: string | null;
            /** Pending Step */
            pending_step: string;
            /**
             * Token Prevention
             * @enum {string}
             */
            token_prevention: "reservation_bound" | "cli_post_invocation";
            /** Unsettled Usage Ids */
            unsettled_usage_ids: string[];
            /**
             * Unreconciled Calls
             * @default 0
             */
            unreconciled_calls: number;
            denial: components["schemas"]["BudgetDenial"] | null;
        };
        /** BuiltinTool */
        BuiltinTool: {
            /** Name */
            name: string;
            /** Description */
            description: string;
            /**
             * Effect
             * @enum {string}
             */
            effect: "read" | "workspace_write" | "external_write";
            /** Roles */
            roles: string[];
            /**
             * Scope
             * @default workspace
             * @constant
             */
            scope: "workspace";
            /**
             * Source
             * @default builtin
             * @constant
             */
            source: "builtin";
            /** Input Schema */
            input_schema: {
                [key: string]: unknown;
            };
        };
        /** BuiltinToolCatalog */
        BuiltinToolCatalog: {
            /**
             * Version
             * @default 1
             * @constant
             */
            version: 1;
            /** Items */
            items: components["schemas"]["BuiltinTool"][];
        };
        /** CallBudgetIncrease */
        CallBudgetIncrease: {
            /** Expected Revision */
            expected_revision: number;
            /** Expected Max Calls */
            expected_max_calls: number;
            /** Max Calls */
            max_calls: number;
        };
        /** CardDiscovery */
        CardDiscovery: {
            /** Endpoint */
            endpoint: string;
            /** Card Endpoint */
            card_endpoint: string;
        };
        /** ChainDefinition */
        "ChainDefinition-Input": {
            /**
             * Version
             * @constant
             */
            version: 1;
            /**
             * Id
             * @enum {string}
             */
            id: "requirements" | "design" | "architecture" | "planning" | "implementation" | "verification" | "review" | "delivery" | "security";
            /** Steps */
            steps: components["schemas"]["ChainStep-Input"][];
        };
        /** ChainDefinition */
        "ChainDefinition-Output": {
            /**
             * Version
             * @constant
             */
            version: 1;
            /**
             * Id
             * @enum {string}
             */
            id: "requirements" | "design" | "architecture" | "planning" | "implementation" | "verification" | "review" | "delivery" | "security";
            /** Steps */
            steps: components["schemas"]["ChainStep-Output"][];
        };
        /** ChainStep */
        "ChainStep-Input": {
            /**
             * Version
             * @constant
             */
            version: 1;
            /** Id */
            id: string;
            /**
             * Capability
             * @enum {string}
             */
            capability: "requirements" | "design" | "architecture" | "planning" | "implementation" | "verification" | "review" | "delivery" | "security";
            /**
             * Instructions
             * @default
             */
            instructions: string;
        };
        /** ChainStep */
        "ChainStep-Output": {
            /**
             * Version
             * @constant
             */
            version: 1;
            /** Id */
            id: string;
            /**
             * Capability
             * @enum {string}
             */
            capability: "requirements" | "design" | "architecture" | "planning" | "implementation" | "verification" | "review" | "delivery" | "security";
            /**
             * Instructions
             * @default
             */
            instructions: string;
        };
        /** ChangedPath */
        ChangedPath: {
            /** Path */
            path: string;
            /**
             * Change
             * @enum {string}
             */
            change: "changed" | "deleted";
        };
        /** CheckpointCounts */
        CheckpointCounts: {
            /** Count */
            count: number;
            /** Threads */
            threads: number;
        };
        /** CliProgressLimitsChange */
        CliProgressLimitsChange: {
            /** Expected Revision */
            expected_revision: number;
            expected_budget: components["schemas"]["Budget-Input"];
        };
        /** CommandEnvelope */
        CommandEnvelope: {
            /**
             * Version
             * @constant
             */
            version: 1;
            /** Idempotency Key */
            idempotency_key: string;
            /** Correlation Id */
            correlation_id: string;
            /** Payload */
            payload: components["schemas"]["Submit"] | components["schemas"]["Control"] | components["schemas"]["Respond"] | components["schemas"]["AmendBudget"] | components["schemas"]["ReconcileBudget"];
        };
        /** CommandResult */
        CommandResult: {
            /**
             * Version
             * @default 1
             * @constant
             */
            version: 1;
            /** Command Id */
            command_id: string;
            /** Correlation Id */
            correlation_id: string;
            /** Work Id */
            work_id: string;
            /** Phase */
            phase: string;
            work: components["schemas"]["WorkOrder"];
        };
        /** ConfigurationChange */
        ConfigurationChange: {
            /** Path */
            path: string;
            /** Before */
            before: string | null;
            /** After */
            after: string | null;
        };
        /** ConfigurationDiagnostic */
        ConfigurationDiagnostic: {
            /** Path */
            path: string;
            /** Message */
            message: string;
        };
        /** ConfigurationDocument */
        ConfigurationDocument: {
            /**
             * Version
             * @constant
             */
            version: 1;
            /** Document */
            document: string;
        };
        /** ConfigurationHistory */
        ConfigurationHistory: {
            /** Items */
            items: components["schemas"]["ConfigurationRevision"][];
            /**
             * Truncated
             * @description True when older revisions exist beyond the limit
             */
            truncated: boolean;
        };
        /** ConfigurationPreview */
        ConfigurationPreview: {
            /**
             * Version
             * @default 1
             * @constant
             */
            version: 1;
            /** Valid */
            valid: boolean;
            configuration: components["schemas"]["FactoryConfiguration"] | null;
            /** Safe Diff */
            safe_diff: components["schemas"]["ConfigurationChange"][];
            /** Diagnostics */
            diagnostics: components["schemas"]["ConfigurationDiagnostic"][];
            /** Yaml */
            yaml: string | null;
        };
        /** ConfigurationRevision */
        ConfigurationRevision: {
            /** Revision */
            revision: number;
            /**
             * Actor
             * @description Saving requires the owner's authentication; the channel is not recorded
             * @default owner
             * @constant
             */
            actor: "owner";
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /**
             * Changed Paths
             * @description Dotted paths changed from the previous revision, at most 20
             */
            changed_paths: string[];
            /** Changed Paths Truncated */
            changed_paths_truncated: boolean;
            /** Summary */
            summary: string;
        };
        /** ConfigurationSave */
        ConfigurationSave: {
            /**
             * Version
             * @constant
             */
            version: 1;
            /** Document */
            document: string;
            /** Expected Revision */
            expected_revision: number;
            /** Approved Destinations */
            approved_destinations: string[];
        };
        /** ConfigurationView */
        ConfigurationView: {
            /**
             * Version
             * @default 1
             * @constant
             */
            version: 1;
            /** Revision */
            revision: number;
            configuration: components["schemas"]["FactoryConfiguration"];
            /** Readiness */
            readiness: components["schemas"]["ReadinessItem"][];
            /** Yaml */
            yaml: string;
        };
        /**
         * ConfirmationDecision
         * @description The owner decides exactly the request the console displayed.
         */
        ConfirmationDecision: {
            /**
             * Version
             * @constant
             */
            version: 1;
            /** Request Digest */
            request_digest: string;
        };
        /** ContextConfiguration */
        ContextConfiguration: {
            /**
             * Deduplicate
             * @default true
             */
            deduplicate: boolean;
            /**
             * Archive Reads
             * @default true
             */
            archive_reads: boolean;
            /**
             * Max Input Bytes
             * @default 98304
             */
            max_input_bytes: number;
        };
        /** ContextFile */
        ContextFile: {
            /** Path */
            path: string;
            /** Content Digest */
            content_digest: string;
            /** Lines */
            lines: number | null;
            /** Indexable */
            indexable: boolean;
        };
        /** ContextPolicySummary */
        ContextPolicySummary: {
            /** Version */
            version: number;
            /** Policy */
            policy: string;
            /** Input Limit Bytes */
            input_limit_bytes: number;
        };
        /** ContextUsageSummary */
        ContextUsageSummary: {
            /** Requests With Context */
            requests_with_context: number;
            /** Requests Without Context */
            requests_without_context: number;
            /** Original Bytes */
            original_bytes: number;
            /** Sent Bytes */
            sent_bytes: number;
            /** Compacted Results */
            compacted_results: number;
            /** Restored Pages */
            restored_pages: number | null;
            /** Requests With Restored Pages */
            requests_with_restored_pages: number;
            /** References Truncated */
            references_truncated: boolean;
            /** Policies */
            policies: components["schemas"]["ContextPolicySummary"][];
        };
        /** Control */
        Control: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "work.control";
            /** Work Id */
            work_id: string;
            /** Expected Revision */
            expected_revision: number;
            /**
             * Action
             * @enum {string}
             */
            action: "pause" | "resume" | "cancel";
        };
        /** CreateFlowLaunch */
        CreateFlowLaunch: {
            /**
             * Version
             * @constant
             */
            version: 1;
            /**
             * Authorize Repository Creation
             * @constant
             */
            authorize_repository_creation: true;
            repository: components["schemas"]["RepoCreationRequest-Input"];
            /**
             * Profile
             * @enum {string}
             */
            profile: "python" | "node";
            /** Gate Commands */
            gate_commands: string[][];
            /** Objective */
            objective: string;
            /** Acceptance */
            acceptance: string[];
            /** Constraints */
            constraints?: string[];
            budget: components["schemas"]["Budget-Input"];
            flow_config?: components["schemas"]["FlowConfiguration-Input"];
            /**
             * Channel
             * @default api
             * @enum {string}
             */
            channel: "web" | "mcp" | "slack" | "api";
        };
        /** CreatedRepository */
        CreatedRepository: {
            /** Id */
            id: number;
            /** Full Name */
            full_name: string;
            /** Url */
            url: string;
            /**
             * Visibility
             * @enum {string}
             */
            visibility: "private" | "public";
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /** Default Branch */
            default_branch: string | null;
        };
        /** DeliveryEvidence */
        DeliveryEvidence: {
            /** Commit */
            commit: string;
            /** Snapshot Digest */
            snapshot_digest: string;
            /** Profile Digest */
            profile_digest: string;
            /** Rules Version */
            rules_version: string;
            /** Gates */
            gates: components["schemas"]["GateResult"][];
            /** Findings */
            findings: components["schemas"]["SecurityFinding"][];
            /** Review */
            review: string;
            /**
             * Security Policy Digest
             * @default
             */
            security_policy_digest: string;
            /** Security Exception Ids */
            security_exception_ids: string[];
            /** Source Digest */
            source_digest: string | null;
            /** Branch */
            branch: string | null;
            /** Pr Url */
            pr_url: string | null;
        };
        /** DeliveryStatus */
        DeliveryStatus: {
            /** Id */
            id: string;
            /** Event Id */
            event_id: string;
            /** Destination */
            destination: string;
            /** Attempts */
            attempts: number;
            /**
             * State
             * @enum {string}
             */
            state: "pending" | "sending" | "delivered" | "failed" | "uncertain";
            /** Last Error */
            last_error: string | null;
        };
        /** EvaluationRecord */
        EvaluationRecord: {
            /** Id */
            id: string;
            /**
             * Kind
             * @enum {string}
             */
            kind: "check" | "security" | "review";
            /**
             * Status
             * @enum {string}
             */
            status: "passed" | "failed" | "recorded";
            /** Criterion */
            criterion: string;
            /** Snapshot Digest */
            snapshot_digest: string | null;
            /** Artifact Digest */
            artifact_digest: string | null;
        };
        /** EventPage */
        EventPage: {
            /** Items */
            items: components["schemas"]["SequencedEvent"][];
            /** Next Cursor */
            next_cursor: number;
            /** Has More */
            has_more: boolean;
        };
        /** ExecutionEvent */
        ExecutionEvent: {
            /**
             * Version
             * @default 1
             * @constant
             */
            version: 1;
            /** Id */
            id: string;
            /** Work Id */
            work_id: string;
            /** Plan Revision */
            plan_revision: number;
            /** Phase */
            phase: string;
            /** Correlation Id */
            correlation_id: string;
            /** Parent Id */
            parent_id: string | null;
            /** Agent Id */
            agent_id?: string | null;
            /**
             * Kind
             * @enum {string}
             */
            kind: "stage" | "agent" | "tool" | "status";
            /**
             * State
             * @enum {string}
             */
            state: "started" | "completed" | "failed" | "interrupted";
            /** Name */
            name: string;
            /**
             * Timestamp
             * Format: date-time
             */
            timestamp: string;
            /** Duration Ms */
            duration_ms: number | null;
            /** Output Bytes */
            output_bytes?: number | null;
            /** Error Code */
            error_code: string | null;
            /** Provider */
            provider: string | null;
            /** Model */
            model: string | null;
            /** Trace Id */
            trace_id: string | null;
            /** Span Id */
            span_id: string | null;
        };
        /** FactoryConfiguration */
        FactoryConfiguration: {
            /**
             * Version
             * @default 1
             * @constant
             */
            version: 1;
            models: components["schemas"]["ModelConfigurationData"];
            /** Flows */
            flows: {
                [key: string]: components["schemas"]["FlowConfiguration-Output"];
            };
            /** Policies */
            policies: components["schemas"]["FactoryPolicy"][];
            context: components["schemas"]["ContextConfiguration"];
        };
        /** FactoryNavigationAction */
        FactoryNavigationAction: {
            /**
             * Id
             * @enum {string}
             */
            id: "connect-github-read" | "connect-github-publish" | "configure-models" | "connect-provider" | "add-mcp-connection";
            /**
             * Kind
             * @enum {string}
             */
            kind: "open_tool" | "open_models" | "open_tools";
            /**
             * Target
             * @enum {string}
             */
            target: "github.read" | "github.publish" | "model" | "mcp";
            /** Label */
            label: string;
        };
        /** FactoryPolicy */
        FactoryPolicy: {
            /**
             * Version
             * @default 1
             * @constant
             */
            version: 1;
            /** Id */
            id: string;
            /**
             * Domain
             * @enum {string}
             */
            domain: "delivery" | "ui" | "architecture" | "infrastructure" | "security";
            /**
             * Mode
             * @enum {string}
             */
            mode: "required" | "preference";
            /** Value */
            value: string;
            /** Validator */
            validator: string | null;
        };
        /** FactoryReadinessView */
        FactoryReadinessView: {
            /**
             * Version
             * @default 1
             * @constant
             */
            version: 1;
            /** Items */
            items: components["schemas"]["ReadinessItem"][];
            /** Connections */
            connections: components["schemas"]["ReadinessConnection"][];
            /** External Tools */
            external_tools: components["schemas"]["ReadinessExternalTools"][];
            /**
             * External Tools Truncated
             * @default false
             */
            external_tools_truncated: boolean;
            /** Actions */
            actions: components["schemas"]["FactoryNavigationAction"][];
        };
        /** FlowConfiguration */
        "FlowConfiguration-Input": {
            /**
             * Version
             * @default 1
             * @constant
             */
            version: 1;
            /** Phases */
            phases?: {
                [key: string]: components["schemas"]["FlowPhase-Input"];
            };
            /** Phase Models */
            phase_models?: {
                [key: string]: components["schemas"]["ModelSelection-Input"];
            };
            permissions?: components["schemas"]["FlowPermissions-Input"];
            /**
             * Repair Cycles
             * @default 2
             */
            repair_cycles: number;
            budget_policy?: components["schemas"]["BudgetPolicy-Input"] | null;
        };
        /** FlowConfiguration */
        "FlowConfiguration-Output": {
            /**
             * Version
             * @default 1
             * @constant
             */
            version: 1;
            /** Phases */
            phases: {
                [key: string]: components["schemas"]["FlowPhase-Output"];
            };
            /** Phase Models */
            phase_models: {
                [key: string]: components["schemas"]["ModelSelection-Output"];
            };
            permissions: components["schemas"]["FlowPermissions-Output"];
            /**
             * Repair Cycles
             * @default 2
             */
            repair_cycles: number;
            budget_policy?: components["schemas"]["BudgetPolicy-Output"] | null;
        };
        /** FlowPermissions */
        "FlowPermissions-Input": {
            /**
             * Architecture
             * @default true
             */
            architecture: boolean;
            /**
             * Dependency Changes
             * @default false
             */
            dependency_changes: boolean;
            /**
             * Draft Pull Request
             * @default true
             */
            draft_pull_request: boolean;
        };
        /** FlowPermissions */
        "FlowPermissions-Output": {
            /**
             * Architecture
             * @default true
             */
            architecture: boolean;
            /**
             * Dependency Changes
             * @default false
             */
            dependency_changes: boolean;
            /**
             * Draft Pull Request
             * @default true
             */
            draft_pull_request: boolean;
        };
        /** FlowPhase */
        "FlowPhase-Input": {
            model?: components["schemas"]["ModelSelection-Input"] | null;
            /** Skills */
            skills?: ("engineering" | "verification" | "review" | "security")[];
        };
        /** FlowPhase */
        "FlowPhase-Output": {
            model: components["schemas"]["ModelSelection-Output"] | null;
            /** Skills */
            skills: ("engineering" | "verification" | "review" | "security")[];
        };
        /** FlowYamlRequest */
        FlowYamlRequest: {
            /** Document */
            document: string;
        };
        /** GateResult */
        GateResult: {
            /** Command */
            command: string[];
            /** Exit Code */
            exit_code: number;
            /** Output Digest */
            output_digest: string;
            /** Snapshot Digest */
            snapshot_digest: string;
        };
        /** GitHubRepositoryImport */
        GitHubRepositoryImport: {
            /** Owner */
            owner: string;
            /** Repository */
            repository: string;
            /** Name */
            name: string;
            /**
             * Profile
             * @enum {string}
             */
            profile: "python" | "node";
            /** Gate Commands */
            gate_commands: string[][];
        };
        /** GitHubRepositoryInfo */
        GitHubRepositoryInfo: {
            /** Id */
            id: number;
            /** Full Name */
            full_name: string;
            /** Url */
            url: string;
            /** Default Branch */
            default_branch: string | null;
            /**
             * Visibility
             * @enum {string}
             */
            visibility: "public" | "private";
            /** Archived */
            archived: boolean;
            /** Disabled */
            disabled: boolean;
            /** Description */
            description: string;
            /** Language */
            language: string | null;
        };
        /** GitHubRepositoryPage */
        GitHubRepositoryPage: {
            /** Items */
            items: components["schemas"]["GitHubRepositoryInfo"][];
            /** Page */
            page: number;
            /** Next Page */
            next_page: number | null;
            /**
             * Access
             * @enum {string}
             */
            access: "public" | "credential";
        };
        /** GitHubRepositorySearch */
        GitHubRepositorySearch: {
            /**
             * Owner Type
             * @enum {string}
             */
            owner_type: "user" | "org";
            /** Owner */
            owner: string;
            /**
             * Page
             * @default 1
             */
            page: number;
        };
        /** GrantCreate */
        GrantCreate: {
            /** Principal */
            principal: string;
            /** Projects */
            projects: string[];
            /** Operations */
            operations: ("work.submit" | "work.query" | "work.answer" | "work.cancel")[];
            /** Expires In */
            expires_in: number;
            /** Max Calls */
            max_calls: number;
            /** Max Tokens */
            max_tokens: number;
            /** Max Cost Usd */
            max_cost_usd: number;
            /** Active Seconds */
            active_seconds: number;
            /** Max Runs */
            max_runs: number;
            /**
             * Version
             * @constant
             */
            version: 1;
            /** Idempotency Key */
            idempotency_key: string;
        };
        /** GrantIssued */
        GrantIssued: {
            /**
             * Version
             * @default 1
             * @constant
             */
            version: 1;
            /** Id */
            id: string;
            /** Principal */
            principal: string;
            /** Token */
            token: string | null;
            /**
             * Expires At
             * Format: date-time
             */
            expires_at: string;
            /** Recovered */
            recovered: boolean;
        };
        /** GrantLimits */
        GrantLimits: {
            /** Principal */
            principal: string;
            /** Projects */
            projects: string[];
            /** Operations */
            operations: ("work.submit" | "work.query" | "work.answer" | "work.cancel")[];
            /** Expires In */
            expires_in: number;
            /** Max Calls */
            max_calls: number;
            /** Max Tokens */
            max_tokens: number;
            /** Max Cost Usd */
            max_cost_usd: number;
            /** Active Seconds */
            active_seconds: number;
            /** Max Runs */
            max_runs: number;
        };
        /** GrantRevoked */
        GrantRevoked: {
            /**
             * Version
             * @default 1
             * @constant
             */
            version: 1;
            /** Id */
            id: string;
            /**
             * Revoked
             * @default true
             * @constant
             */
            revoked: true;
            /**
             * Revoked At
             * Format: date-time
             */
            revoked_at: string;
        };
        /** GrantView */
        GrantView: {
            /**
             * Version
             * @default 1
             * @constant
             */
            version: 1;
            /** Id */
            id: string;
            /** Principal */
            principal: string;
            data: components["schemas"]["GrantLimits"];
            /**
             * Expires At
             * Format: date-time
             */
            expires_at: string;
            /** Revoked At */
            revoked_at: string | null;
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
        };
        /** GraphEdge */
        GraphEdge: {
            /** Source */
            source: string;
            /** Target */
            target: string;
            /**
             * Kind
             * @enum {string}
             */
            kind: "cites" | "supersedes" | "related" | "overlaps" | "from_run" | "at_commit" | "proposed_by";
            /** Attrs */
            attrs: {
                [key: string]: unknown;
            };
        };
        /** GraphNode */
        GraphNode: {
            /**
             * Id
             * @description Typed identifier: memory:<id>, run:<work id>, commit:<sha>, file:<path> or agent:<channel>[:<role>]
             */
            id: string;
            /**
             * Type
             * @enum {string}
             */
            type: "memory" | "run" | "commit" | "file" | "agent";
            /** Label */
            label: string;
            /** Attrs */
            attrs: {
                [key: string]: unknown;
            };
        };
        /** HTTPValidationError */
        HTTPValidationError: {
            /** Detail */
            detail?: components["schemas"]["ValidationError"][];
        };
        /** HumanQuestion */
        HumanQuestion: {
            /** Id */
            id: string;
            /** Work Id */
            work_id: string;
            /** Plan Revision */
            plan_revision: number;
            /** Prompt */
            prompt: string;
            /**
             * Kind
             * @enum {string}
             */
            kind: "clarification" | "architecture" | "scope" | "permission" | "exception" | "blocked";
            /** Options */
            options: string[];
            /** Subject Digest */
            subject_digest: string | null;
            /** Answer */
            answer: string | null;
            /** Answered At */
            answered_at: string | null;
        };
        /** IndexedSource */
        IndexedSource: {
            /** Path */
            path: string;
            /** Content Digest */
            content_digest: string;
            /** Indexable */
            indexable: boolean;
            /** Lines */
            lines: number | null;
            /** Areas */
            areas: components["schemas"]["SourceObservation"][];
            /**
             * Kind
             * @default source_fact
             * @constant
             */
            kind: "source_fact";
            /**
             * Validator
             * @default bounded_source_index_v1
             * @constant
             */
            validator: "bounded_source_index_v1";
        };
        /** IngestionJob */
        IngestionJob: {
            /**
             * Version
             * @default 1
             * @constant
             */
            version: 1;
            /** Id */
            id: string;
            /** Project Id */
            project_id: string;
            /** Index Version */
            index_version: number;
            /**
             * State
             * @default queued
             * @enum {string}
             */
            state: "queued" | "running" | "completed" | "failed";
            /** Source Commit */
            source_commit: string | null;
            /** Expected Source Commit */
            expected_source_commit: string | null;
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /** Finished At */
            finished_at: string | null;
            /** Error Code */
            error_code: string | null;
            /** Error Message */
            error_message: string | null;
        };
        /** IngestionReport */
        IngestionReport: {
            /**
             * Version
             * @default 1
             * @constant
             */
            version: 1;
            /** Project Id */
            project_id: string;
            /** Jobs */
            jobs: components["schemas"]["IngestionJob"][];
            latest: components["schemas"]["RepositoryIndex"] | null;
        };
        /** IngestionRequest */
        IngestionRequest: {
            /**
             * Version
             * @constant
             */
            version: 1;
            /** Idempotency Key */
            idempotency_key: string;
            /** Expected Source Commit */
            expected_source_commit?: string | null;
        };
        /** InspectionAgent */
        InspectionAgent: {
            /** Id */
            id: string;
            /** Role */
            role: string;
            /** Plan Revision */
            plan_revision: number;
        };
        /** InspectionRecord */
        InspectionRecord: {
            /** Sequence */
            sequence: number;
            /** Id */
            id: string;
            /**
             * Kind
             * @enum {string}
             */
            kind: "message" | "tool_call" | "tool_result";
            /** Sender */
            sender: string;
            /** Recipient */
            recipient: string;
            /** Content */
            content: string;
            /** Tool */
            tool: string | null;
            /**
             * Redacted
             * @default false
             */
            redacted: boolean;
            /**
             * Truncated
             * @default false
             */
            truncated: boolean;
        };
        /** IntegerSetting */
        IntegerSetting: {
            /** Value */
            value: number;
            /**
             * Env Var
             * @description Environment variable that sets it; null when fixed in code
             */
            env_var: string | null;
        };
        /** IntegrationInfo */
        IntegrationInfo: {
            /** Id */
            id: string;
            /**
             * Kind
             * @enum {string}
             */
            kind: "github" | "mcp" | "model" | "slack";
            /** Title */
            title: string;
            /** Description */
            description: string;
            /** Enabled */
            enabled: boolean;
            /** Revision */
            revision: number;
            /** Toggleable */
            toggleable: boolean;
            /** Credential Ids */
            credential_ids: string[];
            /** Credential Configured */
            credential_configured: boolean;
            /** Access */
            access: string;
            /** Tools */
            tools: components["schemas"]["IntegrationTool"][];
        };
        /** IntegrationStateChange */
        IntegrationStateChange: {
            /** Enabled */
            enabled: boolean;
            /** Expected Revision */
            expected_revision: number;
        };
        /** IntegrationTool */
        IntegrationTool: {
            /** Name */
            name: string;
            /** Effect */
            effect: string;
            /** Roles */
            roles: string[];
        };
        /** MCPConnectionInfo */
        MCPConnectionInfo: {
            /** Name */
            name: string;
            /** Endpoint */
            endpoint: string;
            /** Revision */
            revision: number;
            /** Credential Id */
            credential_id: string;
            /** Tools */
            tools: {
                [key: string]: components["schemas"]["MCPToolSettings"];
            };
            /** Tool Digests */
            tool_digests: {
                [key: string]: string;
            };
            /**
             * Source
             * @enum {string}
             */
            source: "static" | "dynamic";
        };
        /** MCPConnectionSave */
        MCPConnectionSave: {
            /** Expected Revision */
            expected_revision: number;
            /** Endpoint */
            endpoint: string;
            /** Tools */
            tools?: {
                [key: string]: components["schemas"]["MCPToolSettings"];
            };
            /** Tool Digests */
            tool_digests?: {
                [key: string]: string;
            };
        };
        /** MCPDiscoveredTool */
        MCPDiscoveredTool: {
            /** Name */
            name: string;
            /** Description */
            description: string;
            /** Input Schema */
            input_schema: {
                [key: string]: unknown;
            };
            /** Manifest Digest */
            manifest_digest: string;
        };
        /** MCPDiscovery */
        MCPDiscovery: {
            /** Connection Revision */
            connection_revision: number;
            /** Tools */
            tools: components["schemas"]["MCPDiscoveredTool"][];
            /**
             * Truncated
             * @default false
             */
            truncated: boolean;
        };
        /** MCPToolSettings */
        MCPToolSettings: {
            /** Roles */
            roles: ("supervisor" | "analyst" | "architect" | "developer" | "qa" | "reviewer" | "security")[];
            /**
             * Effect
             * @default read
             * @constant
             */
            effect: "read";
            /**
             * Timeout S
             * @default 60
             */
            timeout_s: number;
        };
        /**
         * MemoryApproval
         * @description Optional owner decisions recorded with an approval; an empty body approves as proposed.
         */
        MemoryApproval: {
            /**
             * Scope
             * @description Replace the proposed scope
             */
            scope?: ("commit" | "project") | null;
            /**
             * Supersedes
             * @description Memory of the same project to invalidate as replaced by this one
             */
            supersedes?: string | null;
            /**
             * Related
             * @description Memories of the same project to link as related
             */
            related?: string[];
        };
        /** MemoryCarryForward */
        MemoryCarryForward: {
            /**
             * Commit
             * @description Indexed commit at which the owner judges the memory still valid
             */
            commit: string;
        };
        /** MemoryCounts */
        MemoryCounts: {
            /** Total */
            total: number;
            /** Active */
            active: number;
            /** Pending */
            pending: number;
            /** Invalidated */
            invalidated: number;
        };
        /** MemoryCreate */
        MemoryCreate: {
            /** Project Id */
            project_id: string;
            /**
             * Kind
             * @enum {string}
             */
            kind: "fact" | "lesson";
            /** Content */
            content: string;
            /** Source Commit */
            source_commit: string;
            /** Source Work Id */
            source_work_id: string;
            /** Evidence Digest */
            evidence_digest?: string | null;
            /**
             * Scope
             * @description commit: recalled only at its source commit. project: also recalled at later indexed commits while every cited file keeps its content digest
             * @enum {string}
             */
            scope?: "commit" | "project";
            /**
             * Citations
             * @description Repository-relative file paths, optionally suffixed with #L<line>, checked against the repository index at the source commit
             */
            citations?: string[];
            /**
             * Supersedes
             * @description A memory of the same project that this one replaces; approval invalidates it
             */
            supersedes?: string | null;
        };
        /** MemoryDetail */
        MemoryDetail: {
            item: components["schemas"]["MemoryListItem"];
            provenance: components["schemas"]["MemoryProvenance"];
            /**
             * Links
             * @description Links recorded by this memory
             */
            links: components["schemas"]["MemoryLink"][];
            /**
             * Backlinks
             * @description Links from other memories to this one
             */
            backlinks: components["schemas"]["MemoryLink"][];
            /**
             * Validity History
             * @description Newest first, at most 50
             */
            validity_history: components["schemas"]["MemoryValidityRecord"][];
            recalls: components["schemas"]["MemoryRecallStats"];
        };
        /**
         * MemoryGraph
         * @description A bounded neighbourhood of project memories; edges only join nodes that are present.
         */
        MemoryGraph: {
            /** Focus */
            focus: string | null;
            /** Depth */
            depth: number;
            /** Nodes */
            nodes: components["schemas"]["GraphNode"][];
            /** Edges */
            edges: components["schemas"]["GraphEdge"][];
            /** Truncated */
            truncated: boolean;
        };
        /** MemoryItem */
        MemoryItem: {
            /** Project Id */
            project_id: string;
            /**
             * Kind
             * @enum {string}
             */
            kind: "fact" | "lesson";
            /** Content */
            content: string;
            /** Source Commit */
            source_commit: string;
            /** Source Work Id */
            source_work_id: string;
            /** Evidence Digest */
            evidence_digest: string | null;
            /**
             * Scope
             * @description commit: recalled only at its source commit. project: also recalled at later indexed commits while every cited file keeps its content digest
             * @enum {string}
             */
            scope: "commit" | "project";
            /**
             * Citations
             * @description Repository-relative file paths, optionally suffixed with #L<line>, checked against the repository index at the source commit
             */
            citations: string[];
            /**
             * Supersedes
             * @description A memory of the same project that this one replaces; approval invalidates it
             */
            supersedes: string | null;
            /** Id */
            id: string;
            /**
             * Active
             * @default false
             */
            active: boolean;
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /** Approved At */
            approved_at: string | null;
            /** Invalidated At */
            invalidated_at: string | null;
            /** @description Absent on memories recorded before attribution; show as unknown */
            proposed_by: components["schemas"]["ProposedBy"] | null;
        };
        /** MemoryItemPage */
        MemoryItemPage: {
            /**
             * Commit
             * @description Newest indexed commit used for validity; null when the project has no index
             */
            commit: string | null;
            /** Items */
            items: components["schemas"]["MemoryListItem"][];
            /** Next Cursor */
            next_cursor: string | null;
        };
        /** MemoryLink */
        MemoryLink: {
            /** Source Id */
            source_id: string;
            /**
             * Kind
             * @enum {string}
             */
            kind: "cites" | "supersedes" | "related" | "overlaps";
            /**
             * Target Type
             * @enum {string}
             */
            target_type: "file" | "memory";
            /** Target Id */
            target_id: string;
            /** Attrs */
            attrs: {
                [key: string]: unknown;
            };
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
        };
        /**
         * MemoryLinkCounts
         * @description Links of each kind in either direction.
         */
        MemoryLinkCounts: {
            /**
             * Cites
             * @default 0
             */
            cites: number;
            /**
             * Supersedes
             * @default 0
             */
            supersedes: number;
            /**
             * Related
             * @default 0
             */
            related: number;
            /**
             * Overlaps
             * @default 0
             */
            overlaps: number;
        };
        /** MemoryListItem */
        MemoryListItem: {
            /** Project Id */
            project_id: string;
            /**
             * Kind
             * @enum {string}
             */
            kind: "fact" | "lesson";
            /** Content */
            content: string;
            /** Source Commit */
            source_commit: string;
            /** Source Work Id */
            source_work_id: string;
            /** Evidence Digest */
            evidence_digest: string | null;
            /**
             * Scope
             * @description commit: recalled only at its source commit. project: also recalled at later indexed commits while every cited file keeps its content digest
             * @enum {string}
             */
            scope: "commit" | "project";
            /**
             * Citations
             * @description Repository-relative file paths, optionally suffixed with #L<line>, checked against the repository index at the source commit
             */
            citations: string[];
            /**
             * Supersedes
             * @description A memory of the same project that this one replaces; approval invalidates it
             */
            supersedes: string | null;
            /** Id */
            id: string;
            /**
             * Active
             * @default false
             */
            active: boolean;
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /** Approved At */
            approved_at: string | null;
            /** Invalidated At */
            invalidated_at: string | null;
            /** @description Absent on memories recorded before attribution; show as unknown */
            proposed_by: components["schemas"]["ProposedBy"] | null;
            /**
             * State
             * @enum {string}
             */
            state: "active" | "pending" | "invalidated";
            validity: components["schemas"]["MemoryValidityAt"];
            /** Recall Count */
            recall_count: number;
            /** Last Recalled At */
            last_recalled_at: string | null;
            link_counts: components["schemas"]["MemoryLinkCounts"];
        };
        /** MemoryProvenance */
        MemoryProvenance: {
            /** Work Id */
            work_id: string;
            /** Work Objective */
            work_objective: string | null;
            /** Work Status */
            work_status: string | null;
            /** Commit */
            commit: string;
            /** Evidence Digest */
            evidence_digest: string | null;
            proposed_by: components["schemas"]["ProposedBy"] | null;
            /** Approved At */
            approved_at: string | null;
            /** Invalidated At */
            invalidated_at: string | null;
        };
        /**
         * MemoryRecall
         * @description What one role call retrieved from memory and why, or which saved memories the validator refused.
         */
        MemoryRecall: {
            /** Id */
            id: string;
            /** Project Id */
            project_id: string;
            /** Work Id */
            work_id: string | null;
            /** Role */
            role: string | null;
            /** Stage */
            stage: string | null;
            /** Commit */
            commit: string;
            /**
             * Outcome
             * @enum {string}
             */
            outcome: "recalled" | "refused";
            /** Error Code */
            error_code: string | null;
            /**
             * Query Terms
             * @description Bounded lexical terms (at most 32) derived from the instruction and objective
             */
            query_terms: string[];
            /**
             * Candidates
             * @description Memories retrieved before selection (at most 8)
             */
            candidates: number;
            /** Selected */
            selected: components["schemas"]["RecallSelection"][];
            /**
             * Omitted
             * @description Retrieved memories left out by the four-item context limit
             */
            omitted: number;
            /** Refused Memory Ids */
            refused_memory_ids: string[];
            /**
             * Bytes
             * @description UTF-8 size of the memory context placed in the prompt
             */
            bytes: number;
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
        };
        /** MemoryRecallPage */
        MemoryRecallPage: {
            /** Items */
            items: components["schemas"]["MemoryRecall"][];
            /**
             * Next Cursor
             * @description Pass as cursor to read older recalls; null on the last page
             */
            next_cursor: string | null;
        };
        /** MemoryRecallStats */
        MemoryRecallStats: {
            /** Recall Count */
            recall_count: number;
            /** Last Recalled At */
            last_recalled_at: string | null;
            /** Refused Count */
            refused_count: number;
        };
        /** MemoryReview */
        MemoryReview: {
            /** Commit */
            commit: string | null;
            /** Pending */
            pending: components["schemas"]["PendingReview"][];
            /** Stale */
            stale: components["schemas"]["StaleReview"][];
            /**
             * Truncated
             * @description True when more than 100 pending or 100 stale memories exist
             */
            truncated: boolean;
        };
        /**
         * MemoryValidityAt
         * @description Whether a memory would be recalled at ``commit`` (the project's newest indexed commit in listings).
         */
        MemoryValidityAt: {
            /** Commit */
            commit: string | null;
            /**
             * State
             * @enum {string}
             */
            state: "valid" | "stale" | "unavailable";
            /**
             * Reason
             * @enum {string}
             */
            reason: "source_commit" | "no_citations" | "citations_unchanged" | "citations_changed" | "owner" | "commit_scope" | "not_active" | "index_missing" | "not_evaluated";
            /** Changed Paths */
            changed_paths: components["schemas"]["ChangedPath"][];
            /** Checked At */
            checked_at: string | null;
        };
        /**
         * MemoryValidityRecord
         * @description One durable evaluation of a project memory at a commit.
         */
        MemoryValidityRecord: {
            /** Commit */
            commit: string;
            /**
             * State
             * @enum {string}
             */
            state: "valid" | "stale";
            /**
             * Basis
             * @enum {string}
             */
            basis: "source_commit" | "no_citations" | "citations_unchanged" | "citations_changed" | "owner";
            /** Changed Paths */
            changed_paths: components["schemas"]["ChangedPath"][];
            /**
             * Checked At
             * Format: date-time
             */
            checked_at: string;
        };
        /** MetricBudget */
        "MetricBudget-Input": {
            /** Primary */
            primary: number | null;
            /**
             * Reserve
             * @default 0
             */
            reserve: number;
            /** Absolute */
            absolute: number | null;
        };
        /** MetricBudget */
        "MetricBudget-Output": {
            /** Primary */
            primary: number | null;
            /**
             * Reserve
             * @default 0
             */
            reserve: number;
            /** Absolute */
            absolute: number | null;
        };
        /** ModelConfiguration */
        ModelConfiguration: {
            /** Revision */
            revision: number;
            default: components["schemas"]["ModelSelection-Output"];
            /** Roles */
            roles: components["schemas"]["RoleModelConfiguration"][];
            /** Runners */
            runners: components["schemas"]["ModelRunnerStatus"][];
        };
        /** ModelConfigurationChange */
        ModelConfigurationChange: {
            default: components["schemas"]["ModelSelection-Input"];
            /** Roles */
            roles: {
                [key: string]: components["schemas"]["ModelSelection-Input"] | null;
            };
            /** Expected Revision */
            expected_revision: number;
            /** Approved Destinations */
            approved_destinations: string[];
        };
        /** ModelConfigurationData */
        ModelConfigurationData: {
            default: components["schemas"]["ModelSelection-Output"];
            /** Roles */
            roles: {
                [key: string]: components["schemas"]["ModelSelection-Output"] | null;
            };
        };
        /** ModelRunnerStatus */
        ModelRunnerStatus: {
            /**
             * Provider
             * @enum {string}
             */
            provider: "codex_cli" | "claude_cli";
            /** Available */
            available: boolean;
            /** Authenticated */
            authenticated: boolean | null;
            /** Busy */
            busy: boolean;
            /** Error Code */
            error_code: string | null;
        };
        /** ModelSelection */
        "ModelSelection-Input": {
            /**
             * Provider
             * @enum {string}
             */
            provider: "codex_cli" | "claude_cli" | "openai" | "anthropic" | "google" | "local";
            /**
             * Name
             * @default
             */
            name: string;
            /** Destination */
            destination: string;
            /**
             * Input Usd Per Million
             * @default 0
             */
            input_usd_per_million: number;
            /**
             * Output Usd Per Million
             * @default 0
             */
            output_usd_per_million: number;
            /**
             * Max Output Tokens
             * @default 4096
             */
            max_output_tokens: number;
        };
        /** ModelSelection */
        "ModelSelection-Output": {
            /**
             * Provider
             * @enum {string}
             */
            provider: "codex_cli" | "claude_cli" | "openai" | "anthropic" | "google" | "local";
            /**
             * Name
             * @default
             */
            name: string;
            /** Destination */
            destination: string;
            /**
             * Input Usd Per Million
             * @default 0
             */
            input_usd_per_million: number;
            /**
             * Output Usd Per Million
             * @default 0
             */
            output_usd_per_million: number;
            /**
             * Max Output Tokens
             * @default 4096
             */
            max_output_tokens: number;
        };
        /** NumberSetting */
        NumberSetting: {
            /** Value */
            value: number;
            /** Env Var */
            env_var: string | null;
        };
        /** OperatorMessagePage */
        OperatorMessagePage: {
            /** Items */
            items: components["schemas"]["OperatorMessageView"][];
            /** Truncated */
            truncated: boolean;
        };
        /** OperatorMessageRequest */
        OperatorMessageRequest: {
            /**
             * Version
             * @constant
             */
            version: 1;
            /** Text */
            text: string;
            /** Idempotency Key */
            idempotency_key: string;
            /** Work Id */
            work_id?: string | null;
            /** Allowed Actions */
            allowed_actions?: ("register_project" | "submit_work" | "answer_question" | "control_work" | "change_scope" | "propose_memory" | "resolve_memory")[];
        };
        /** OperatorMessageResume */
        OperatorMessageResume: {
            /**
             * Version
             * @constant
             */
            version: 1;
            /** Expected Error Code */
            expected_error_code: string | null;
        };
        /** OperatorMessageView */
        OperatorMessageView: {
            /**
             * Version
             * @default 1
             * @constant
             */
            version: 1;
            /** Id */
            id: string;
            /**
             * Source
             * @default web
             * @enum {string}
             */
            source: "web" | "mcp";
            /** Work Id */
            work_id: string | null;
            /** Text */
            text: string;
            /** Allowed Actions */
            allowed_actions: ("register_project" | "submit_work" | "answer_question" | "control_work" | "change_scope" | "propose_memory" | "resolve_memory")[];
            /**
             * State
             * @enum {string}
             */
            state: "queued" | "running" | "completed" | "blocked";
            /** Reply */
            reply: string | null;
            /** Error Code */
            error_code: string | null;
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
        };
        /** OperatorToolTrace */
        OperatorToolTrace: {
            /** Call Id */
            call_id: string;
            /** Name */
            name: string;
            /** Input */
            input: string;
            /** Output */
            output: string | null;
            /**
             * Status
             * @enum {string}
             */
            status: "pending" | "completed" | "error";
            /**
             * Redacted
             * @default false
             */
            redacted: boolean;
            /**
             * Truncated
             * @default false
             */
            truncated: boolean;
        };
        /** OperatorToolTracePage */
        OperatorToolTracePage: {
            /**
             * Version
             * @default 1
             * @constant
             */
            version: 1;
            /** Message Id */
            message_id: string;
            /** Available */
            available: boolean;
            /** Checkpoint Id */
            checkpoint_id: string | null;
            /**
             * Truncated
             * @default false
             */
            truncated: boolean;
            /** Tools */
            tools: components["schemas"]["OperatorToolTrace"][];
            /** Actions */
            actions: components["schemas"]["FactoryNavigationAction"][];
        };
        /** OverlapEntry */
        OverlapEntry: {
            /** Memory Id */
            memory_id: string;
            /**
             * State
             * @enum {string}
             */
            state: "active" | "pending" | "invalidated";
            /**
             * Content
             * @description First 240 characters of the other memory
             */
            content: string;
            /** Score */
            score: number;
            /** Lexical */
            lexical: number;
            /** Cosine */
            cosine: number | null;
            /**
             * Only This
             * @description Normalized terms only in the memory under review
             */
            only_this: string[];
            /**
             * Only Other
             * @description Normalized terms only in the overlapping memory
             */
            only_other: string[];
        };
        /** OwnerConfirmation */
        OwnerConfirmation: {
            /**
             * Version
             * @default 1
             * @constant
             */
            version: 1;
            /** Id */
            id: string;
            /**
             * Kind
             * @enum {string}
             */
            kind: "budget.tokens" | "budget.calls" | "budget.cli_progress" | "budget.amend" | "budget.reconcile" | "security.exception";
            /** Work Id */
            work_id: string;
            /**
             * Source
             * @constant
             */
            source: "mcp";
            /**
             * State
             * @enum {string}
             */
            state: "pending" | "applying" | "applied" | "rejected" | "failed" | "expired";
            /** Summary */
            summary: string;
            /** Request */
            request: {
                [key: string]: unknown;
            };
            /** Request Digest */
            request_digest: string;
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /**
             * Expires At
             * Format: date-time
             */
            expires_at: string;
            /** Decided At */
            decided_at: string | null;
            /** Error Code */
            error_code: string | null;
            /** Error Message */
            error_message: string | null;
        };
        /** OwnerConfirmationPage */
        OwnerConfirmationPage: {
            /**
             * Version
             * @default 1
             * @constant
             */
            version: 1;
            /** Pending */
            pending: number;
            /** Items */
            items: components["schemas"]["OwnerConfirmation"][];
        };
        /** PackageVersion */
        PackageVersion: {
            /** Distribution */
            distribution: string;
            /** Version */
            version: string | null;
        };
        /** PendingReview */
        PendingReview: {
            item: components["schemas"]["MemoryListItem"];
            /** Overlaps */
            overlaps: components["schemas"]["OverlapEntry"][];
        };
        /**
         * ProcessHelper
         * @description A specialist a station may call besides its own, and when.
         */
        ProcessHelper: {
            /** Role */
            role: string;
            /** Agent */
            agent: string;
            /** Condition */
            condition: string;
        };
        /** ProcessLane */
        ProcessLane: {
            /** Id */
            id: string;
            /** Label */
            label: string;
            /** Specialist */
            specialist: string;
            /** Stages */
            stages: string[];
            /** Next */
            next: string[];
        };
        /** ProcessLoop */
        ProcessLoop: {
            /** Source */
            source: string;
            /** Target */
            target: string;
            /** Condition */
            condition: string;
            /** Limit */
            limit: string;
        };
        /** ProcessRoute */
        ProcessRoute: {
            /** Source */
            source: string;
            /** Target */
            target: string;
            /** Condition */
            condition: string;
        };
        /**
         * ProcessStation
         * @description One node of the sabre-v1 graph as the owner sees it. Routing is deterministic: no model chooses edges.
         */
        ProcessStation: {
            /** Id */
            id: string;
            /** Label */
            label: string;
            /**
             * Stage
             * @enum {string}
             */
            stage: "understand" | "plan" | "build" | "verify" | "review" | "security" | "deliver";
            /**
             * Kind
             * @enum {string}
             */
            kind: "rules" | "gates" | "model" | "gates_model";
            /** Role */
            role: string | null;
            /** Agent */
            agent: string | null;
            /** Summary */
            summary: string;
            /** Phases */
            phases: string[];
            /** Condition */
            condition: string | null;
            /**
             * Asks Owner
             * @default false
             */
            asks_owner: boolean;
            /** Helpers */
            helpers: components["schemas"]["ProcessHelper"][];
        };
        /** ProcessTopology */
        ProcessTopology: {
            /**
             * Version
             * @default 1
             * @constant
             */
            version: 1;
            /**
             * Graph Version
             * @default sabre-v1
             * @constant
             */
            graph_version: "sabre-v1";
            /**
             * Mode
             * @enum {string}
             */
            mode: "patch" | "maintain" | "create" | "audit";
            /** Lanes */
            lanes: components["schemas"]["ProcessLane"][];
            /** Alternatives */
            alternatives: components["schemas"]["ProcessRoute"][];
            /** Stations */
            stations: components["schemas"]["ProcessStation"][];
            /** Loops */
            loops: components["schemas"]["ProcessLoop"][];
        };
        /** Project */
        Project: {
            /** Name */
            name: string;
            /** Repository */
            repository: string;
            /**
             * Profile
             * @enum {string}
             */
            profile: "python" | "node";
            /**
             * Default Branch
             * @default main
             */
            default_branch: string;
            /** Gate Commands */
            gate_commands: string[][];
            /** Allowed Mcp Servers */
            allowed_mcp_servers: string[];
            /** Approved Baseline */
            approved_baseline: string[];
            browser_preview: components["schemas"]["BrowserPreview-Output"] | null;
            /** Id */
            id: string;
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
        };
        /** ProjectCreate */
        ProjectCreate: {
            /** Name */
            name: string;
            /** Repository */
            repository: string;
            /**
             * Profile
             * @enum {string}
             */
            profile: "python" | "node";
            /**
             * Default Branch
             * @default main
             */
            default_branch: string;
            /** Gate Commands */
            gate_commands: string[][];
            /** Allowed Mcp Servers */
            allowed_mcp_servers?: string[];
            /** Approved Baseline */
            approved_baseline?: string[];
            browser_preview?: components["schemas"]["BrowserPreview-Input"] | null;
        };
        /** ProjectKnowledgeReport */
        ProjectKnowledgeReport: {
            /** Project Id */
            project_id: string;
            /**
             * Profile
             * @enum {string}
             */
            profile: "node" | "python";
            /** Gate Count */
            gate_count: number;
            memories: components["schemas"]["MemoryCounts"];
            checkpoints: components["schemas"]["CheckpointCounts"];
            context: components["schemas"]["RecordedContext"] | null;
            /** Semantic Search */
            semantic_search: boolean;
            /** Truncated */
            truncated: boolean;
        };
        /** ProjectToolsChange */
        ProjectToolsChange: {
            /** Expected Revision */
            expected_revision: number;
            /** Servers */
            servers: string[];
        };
        /** ProjectToolsPolicy */
        ProjectToolsPolicy: {
            /** Project Id */
            project_id: string;
            /** Revision */
            revision: number;
            /** Servers */
            servers: string[];
        };
        /**
         * ProposedBy
         * @description Entry point that proposed a memory. The server sets it; request bodies cannot supply it.
         */
        ProposedBy: {
            /**
             * Channel
             * @enum {string}
             */
            channel: "owner_console" | "owner_mcp" | "supervisor_chat" | "factory";
            /** Role */
            role: string | null;
            /** Work Id */
            work_id: string | null;
        };
        /** ReadinessConnection */
        ReadinessConnection: {
            /**
             * Id
             * @enum {string}
             */
            id: "github.read" | "github.publish";
            /** Enabled */
            enabled: boolean;
            /** Credential Configured */
            credential_configured: boolean;
            /** Access */
            access: string;
        };
        /** ReadinessExternalTools */
        ReadinessExternalTools: {
            /** Id */
            id: string;
            /**
             * Kind
             * @constant
             */
            kind: "mcp";
            /** Enabled */
            enabled: boolean;
            /** Credential Configured */
            credential_configured: boolean;
            /** Tool Count */
            tool_count: number;
        };
        /** ReadinessItem */
        ReadinessItem: {
            /** Id */
            id: string;
            /**
             * Status
             * @enum {string}
             */
            status: "ready" | "missing" | "unavailable";
            /** Message */
            message: string;
            /** Action */
            action: string;
        };
        /** RecallSelection */
        RecallSelection: {
            /** Memory Id */
            memory_id: string;
            /**
             * Lexical Rank
             * @description Position in the lexical (ts_rank) list, 1-based; null when not matched lexically
             */
            lexical_rank: number | null;
            /**
             * Vector Rank
             * @description Position in the pgvector list, 1-based; null without embeddings or match
             */
            vector_rank: number | null;
            /**
             * Fused Score
             * @description Reciprocal rank fusion score: sum of 1/(60+rank) over both lists
             */
            fused_score: number | null;
            /**
             * Bytes
             * @description UTF-8 size of the excerpt placed in context
             */
            bytes: number;
            /**
             * Truncated
             * @description True when the excerpt is shorter than the memory
             */
            truncated: boolean;
        };
        /** ReconcileBudget */
        ReconcileBudget: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "work.budget.reconcile";
            /** Work Id */
            work_id: string;
            request: components["schemas"]["BudgetReconciliation"];
        };
        /** RecordedContext */
        RecordedContext: {
            /** Work Id */
            work_id: string;
            /** Plan Revision */
            plan_revision: number;
            /** Role */
            role: string;
            /** Captured At */
            captured_at: string | null;
            /** Source Commit */
            source_commit: string;
            /** Snapshot Digest */
            snapshot_digest: string;
            /** Total Files */
            total_files: number;
            /** Text Files */
            text_files: number;
            /** Omitted Files */
            omitted_files: number;
            /** Files */
            files: components["schemas"]["ContextFile"][];
            /**
             * Currentness
             * @default unknown
             * @constant
             */
            currentness: "unknown";
            /**
             * Source
             * @default recorded_checkpoint
             * @constant
             */
            source: "recorded_checkpoint";
        };
        /** ReleaseAuthorization */
        ReleaseAuthorization: {
            /**
             * Version
             * @constant
             */
            version: 1;
            /** Expected Revision */
            expected_revision: number;
            /** Candidate Digest */
            candidate_digest: string;
            /**
             * Authorize Publication
             * @constant
             */
            authorize_publication: true;
            /**
             * Expires Seconds
             * @default 3600
             */
            expires_seconds: number;
        };
        /** ReleaseCandidate */
        ReleaseCandidate: {
            /**
             * Version
             * @default 1
             * @constant
             */
            version: 1;
            /** Id */
            id: string;
            /** Revision */
            revision: number;
            /** Digest */
            digest: string;
            /** Project Id */
            project_id: string;
            /** Work Id */
            work_id: string;
            /** Commit */
            commit: string;
            /** Snapshot Digest */
            snapshot_digest: string;
            /** Package Version */
            package_version: string;
            /** Tag */
            tag: string;
            /** Changelog */
            changelog: string;
            /** Artifacts */
            artifacts: components["schemas"]["ArtifactReference"][];
            /** Required Checks */
            required_checks: string[];
            /**
             * Status
             * @enum {string}
             */
            status: "prepared" | "authorized" | "publishing" | "published" | "uncertain";
            /** Blockers */
            blockers: string[];
            /** Release Url */
            release_url: string | null;
            /** Authorization Expires At */
            authorization_expires_at: string | null;
        };
        /** ReleasePage */
        ReleasePage: {
            /**
             * Version
             * @default 1
             * @constant
             */
            version: 1;
            /** Items */
            items: components["schemas"]["ReleaseCandidate"][];
            /** Truncated */
            truncated: boolean;
        };
        /** ReleasePreparation */
        ReleasePreparation: {
            /**
             * Version
             * @constant
             */
            version: 1;
            /** Work Id */
            work_id: string;
            /** Package Version */
            package_version: string;
            /** Idempotency Key */
            idempotency_key: string;
            /** Required Checks */
            required_checks: string[];
        };
        /** ReleasePublication */
        ReleasePublication: {
            /**
             * Version
             * @constant
             */
            version: 1;
            /** Expected Revision */
            expected_revision: number;
            /** Candidate Digest */
            candidate_digest: string;
            /** Idempotency Key */
            idempotency_key: string;
        };
        /** RepoCreationDecision */
        RepoCreationDecision: {
            /** Expected Revision */
            expected_revision: number;
            /** Request Digest */
            request_digest: string;
            /**
             * Decision
             * @enum {string}
             */
            decision: "approve" | "reject";
        };
        /** RepoCreationPage */
        RepoCreationPage: {
            /** Items */
            items: components["schemas"]["RepoCreationProposal"][];
            /** Truncated */
            truncated: boolean;
        };
        /** RepoCreationProposal */
        RepoCreationProposal: {
            /** Id */
            id: string;
            request: components["schemas"]["RepoCreationRequest-Output"];
            /** Request Digest */
            request_digest: string;
            /**
             * Status
             * @enum {string}
             */
            status: "proposed" | "approved" | "rejected" | "executing" | "created" | "conflict" | "failed" | "reconciliation_required";
            /** Revision */
            revision: number;
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /**
             * Updated At
             * Format: date-time
             */
            updated_at: string;
            /** Approved At */
            approved_at: string | null;
            /** Started At */
            started_at: string | null;
            receipt: components["schemas"]["CreatedRepository"] | null;
            candidate: components["schemas"]["CreatedRepository"] | null;
            /** Error Code */
            error_code: string | null;
        };
        /** RepoCreationRequest */
        "RepoCreationRequest-Input": {
            /**
             * Owner Type
             * @enum {string}
             */
            owner_type: "user" | "org";
            /** Owner */
            owner: string;
            /** Name */
            name: string;
            /**
             * Visibility
             * @default private
             * @enum {string}
             */
            visibility: "private" | "public";
            /**
             * Description
             * @default
             */
            description: string;
            /**
             * Initialize
             * @default false
             */
            initialize: boolean;
            /** Idempotency Key */
            idempotency_key: string;
        };
        /** RepoCreationRequest */
        "RepoCreationRequest-Output": {
            /**
             * Owner Type
             * @enum {string}
             */
            owner_type: "user" | "org";
            /** Owner */
            owner: string;
            /** Name */
            name: string;
            /**
             * Visibility
             * @default private
             * @enum {string}
             */
            visibility: "private" | "public";
            /**
             * Description
             * @default
             */
            description: string;
            /**
             * Initialize
             * @default false
             */
            initialize: boolean;
            /** Idempotency Key */
            idempotency_key: string;
        };
        /** RepositoryIndex */
        RepositoryIndex: {
            /**
             * Version
             * @default 1
             * @constant
             */
            version: 1;
            /** Project Id */
            project_id: string;
            /** Source Commit */
            source_commit: string;
            /** Index Version */
            index_version: number;
            /** Snapshot Digest */
            snapshot_digest: string;
            /**
             * Captured At
             * Format: date-time
             */
            captured_at: string;
            /** Files */
            files: components["schemas"]["IndexedSource"][];
            /** Total Files */
            total_files: number;
            /** Omitted Files */
            omitted_files: number;
            changes: components["schemas"]["SourceChanges"];
            /** Previous Commit */
            previous_commit: string | null;
            /**
             * Validity
             * @default current_at_capture
             * @constant
             */
            validity: "current_at_capture";
            /**
             * Untrusted
             * @default true
             * @constant
             */
            untrusted: true;
        };
        /** ResolvedFlow */
        ResolvedFlow: {
            /**
             * Version
             * @default 1
             * @constant
             */
            version: 1;
            /**
             * Flow Version
             * @default sabre-factory-v1
             * @constant
             */
            flow_version: "sabre-factory-v1";
            /**
             * Graph Version
             * @default sabre-v1
             * @constant
             */
            graph_version: "sabre-v1";
            /** Model Revision */
            model_revision: number;
            /** Phases */
            phases: {
                [key: string]: components["schemas"]["ResolvedPhase"];
            };
            /** Configuration Digest */
            configuration_digest: string;
        };
        /** ResolvedPhase */
        ResolvedPhase: {
            /** Role */
            role: string;
            model: components["schemas"]["ModelSelection-Output"];
            /** Credential Target */
            credential_target: string | null;
            /** Skills */
            skills: {
                [key: string]: string;
            };
            definition?: components["schemas"]["AgentDefinitionSnapshot"] | null;
        };
        /** Respond */
        Respond: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "work.answer";
            /** Work Id */
            work_id: string;
            answer: components["schemas"]["Answer"];
        };
        /** RoleActivity */
        RoleActivity: {
            /** Role */
            role: string;
            /**
             * Invocations
             * @description Agent invocations started in the window
             */
            invocations: number;
            /** Completed */
            completed: number;
            /** Failed */
            failed: number;
            /** Interrupted */
            interrupted: number;
            /**
             * Duration Ms
             * @description Total measured duration of finished invocations
             */
            duration_ms: number;
            /**
             * Model Calls
             * @description Model calls attributed to this role in the usage ledger
             */
            model_calls: number;
            /**
             * Tokens
             * @description Provider-measured tokens; null when no call of the role was measured
             */
            tokens: number | null;
        };
        /** RoleModelConfiguration */
        RoleModelConfiguration: {
            /**
             * Role
             * @enum {string}
             */
            role: "supervisor" | "analyst" | "architect" | "developer" | "qa" | "reviewer" | "security";
            override: components["schemas"]["ModelSelection-Output"] | null;
            effective: components["schemas"]["ModelSelection-Output"];
            /** Credential Target */
            credential_target: string | null;
        };
        /** RoleModelInfo */
        RoleModelInfo: {
            /**
             * Role
             * @enum {string}
             */
            role: "supervisor" | "analyst" | "architect" | "developer" | "qa" | "reviewer" | "security";
            /** Provider */
            provider: string;
            /** Name */
            name: string;
            /** Configured */
            configured: boolean | null;
        };
        /** RunInspection */
        RunInspection: {
            /**
             * Version
             * @default 1
             * @constant
             */
            version: 1;
            /** Work Id */
            work_id: string;
            /** Plan Revision */
            plan_revision: number;
            /** Agent Id */
            agent_id: string | null;
            /** Role */
            role: string | null;
            /** Agents */
            agents: components["schemas"]["InspectionAgent"][];
            /** Records */
            records: components["schemas"]["InspectionRecord"][];
            /** Evaluations */
            evaluations: components["schemas"]["EvaluationRecord"][];
            /** Logs */
            logs: {
                [key: string]: unknown;
            }[];
            /** Context */
            context: {
                [key: string]: unknown;
            } | null;
            /** Next Cursor */
            next_cursor: number;
            /** Has More */
            has_more: boolean;
            /** Truncated */
            truncated: boolean;
            /** Checkpoint Id */
            checkpoint_id: string | null;
            /** Current */
            current: boolean;
        };
        /** RunUsageSnapshot */
        RunUsageSnapshot: {
            /**
             * Version
             * @default 1
             * @constant
             */
            version: 1;
            /** Work Id */
            work_id: string;
            usage: components["schemas"]["AuditUsage"];
            /** Measured Api Cost Usd */
            measured_api_cost_usd: number | null;
            /** Reserved Api Cost Usd */
            reserved_api_cost_usd: number;
        };
        /** RuntimeInfo */
        RuntimeInfo: {
            /** Python */
            python: string;
            /** Implementation */
            implementation: string;
            /** System */
            system: string;
            /** Architecture */
            architecture: string;
        };
        /**
         * RuntimeSettings
         * @description Non-secret runtime configuration and where each value comes from.
         */
        RuntimeSettings: {
            execution_slots: components["schemas"]["IntegerSetting"];
            panel_session_days: components["schemas"]["IntegerSetting"];
            allowed_origins: components["schemas"]["TextListSetting"];
            monthly_budget_usd: components["schemas"]["NumberSetting"];
            chat_budget_usd: components["schemas"]["NumberSetting"];
            /** @description Configured webhook names only; endpoints are never returned */
            webhooks: components["schemas"]["TextListSetting"];
            otlp: components["schemas"]["TelemetrySetting"];
            sandbox: components["schemas"]["SandboxLimits"];
        };
        /** SandboxLimits */
        SandboxLimits: {
            memory: components["schemas"]["TextSetting"];
            cpus: components["schemas"]["NumberSetting"];
            pids: components["schemas"]["IntegerSetting"];
            default_timeout_s: components["schemas"]["IntegerSetting"];
            max_timeout_s: components["schemas"]["IntegerSetting"];
            network_default: components["schemas"]["TextSetting"];
        };
        /** ScopeChange */
        ScopeChange: {
            /** Expected Revision */
            expected_revision: number;
            /** Objective */
            objective: string;
            /** Acceptance */
            acceptance: string[];
        };
        /** SecretDeactivate */
        SecretDeactivate: {
            /** Expected Version */
            expected_version: number;
        };
        /** SecretMetadata */
        SecretMetadata: {
            /** Id */
            id: string;
            /** Version */
            version: number;
            /** Configured */
            configured: boolean;
            /**
             * Updated At
             * Format: date-time
             */
            updated_at: string;
        };
        /** SecretTarget */
        SecretTarget: {
            /** Id */
            id: string;
            /** Label */
            label: string;
        };
        /** SecretUpsert */
        SecretUpsert: {
            /**
             * Value
             * Format: password
             */
            value: string;
            /** Expected Version */
            expected_version?: number | null;
        };
        /** SecurityException */
        SecurityException: {
            /** Fingerprint */
            fingerprint: string;
            /** Justification */
            justification: string;
            /**
             * Expires At
             * Format: date-time
             */
            expires_at: string;
            /** Snapshot Digest */
            snapshot_digest: string;
            /** Rules Version */
            rules_version: string;
            /** Plan Revision */
            plan_revision: number;
            /** Id */
            id: string;
            /** Work Id */
            work_id: string;
            /** Project Id */
            project_id: string;
            /**
             * Approved By
             * @default owner
             * @constant
             */
            approved_by: "owner";
            /**
             * Approved At
             * Format: date-time
             */
            approved_at: string;
            /** Revoked At */
            revoked_at: string | null;
        };
        /**
         * SecurityExceptionCreate
         * @description Owner command; validity dates are checked against server time on grant.
         */
        SecurityExceptionCreate: {
            /** Fingerprint */
            fingerprint: string;
            /** Justification */
            justification: string;
            /**
             * Expires At
             * Format: date-time
             */
            expires_at: string;
            /** Snapshot Digest */
            snapshot_digest: string;
            /** Rules Version */
            rules_version: string;
            /** Plan Revision */
            plan_revision: number;
        };
        /** SecurityFinding */
        SecurityFinding: {
            /** Fingerprint */
            fingerprint: string;
            /** Scanner */
            scanner: string;
            /**
             * Category
             * @enum {string}
             */
            category: "secret" | "vulnerability" | "code" | "configuration" | "scanner_error";
            /**
             * Severity
             * @enum {string}
             */
            severity: "info" | "low" | "medium" | "high" | "critical";
            /** Title */
            title: string;
            /** Path */
            path: string | null;
            /** Reference */
            reference: string | null;
            /** Line */
            line: number | null;
            /** Remediation */
            remediation: string | null;
            /**
             * Baseline
             * @default false
             */
            baseline: boolean;
            /** Exception Id */
            exception_id: string | null;
        };
        /** SequencedEvent */
        SequencedEvent: {
            /** Sequence */
            sequence: number;
            event: components["schemas"]["ExecutionEvent"];
        };
        /** SkillReference */
        SkillReference: {
            /**
             * Name
             * @enum {string}
             */
            name: "engineering" | "verification" | "review" | "security";
            /** Digest */
            digest: string;
        };
        /** SourceChanges */
        SourceChanges: {
            /** Added */
            added: string[];
            /** Changed */
            changed: string[];
            /** Deleted */
            deleted: string[];
        };
        /** SourceObservation */
        SourceObservation: {
            /** Area */
            area: string;
            /** Basis */
            basis: string;
            /** Path */
            path: string;
        };
        /** StaleReview */
        StaleReview: {
            item: components["schemas"]["MemoryListItem"];
            /** Changed Paths */
            changed_paths: components["schemas"]["ChangedPath"][];
        };
        /**
         * Status
         * @enum {string}
         */
        Status: "queued" | "running" | "waiting_input" | "paused" | "blocked" | "failed" | "cancelled" | "completed";
        /** Submit */
        Submit: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "work.submit";
            request: components["schemas"]["WorkOrderCreate"];
        };
        /** SystemComponent */
        SystemComponent: {
            /**
             * Id
             * @enum {string}
             */
            id: "api" | "database" | "worker" | "executor" | "codex" | "claude" | "github" | "slack" | "memory" | "security" | "telemetry";
            /** Label */
            label: string;
            /** Configured */
            configured: boolean | null;
            /**
             * State
             * @enum {string}
             */
            state: "available" | "unavailable" | "busy" | "unknown";
            /** Detail */
            detail: string;
        };
        /** SystemInfo */
        SystemInfo: {
            /**
             * Checked At
             * Format: date-time
             */
            checked_at: string;
            application: components["schemas"]["ApplicationInfo"];
            runtime: components["schemas"]["RuntimeInfo"];
            /** Packages */
            packages: components["schemas"]["PackageVersion"][];
            /** Components */
            components: components["schemas"]["SystemComponent"][];
            limits: components["schemas"]["SystemLimits"];
            /** Models */
            models: components["schemas"]["RoleModelInfo"][];
            /** @description Non-secret runtime configuration; null when unavailable */
            runtime_settings?: components["schemas"]["RuntimeSettings"] | null;
        };
        /** SystemLimits */
        SystemLimits: {
            /** Concurrent Work */
            concurrent_work: number;
            /** Writers Per Repository */
            writers_per_repository: number;
            /** Repair Cycles */
            repair_cycles: number;
            /** Codex Invocations */
            codex_invocations: number | null;
            /** Claude Invocations */
            claude_invocations: number | null;
        };
        /** Task */
        Task: {
            /** Id */
            id: string;
            /** Title */
            title: string;
            /**
             * Role
             * @default developer
             * @enum {string}
             */
            role: "analyst" | "architect" | "developer" | "qa" | "reviewer";
            /**
             * Specialty
             * @default general
             * @enum {string}
             */
            specialty: "general" | "backend" | "frontend" | "infrastructure" | "documentation";
            /** Depends On */
            depends_on: string[];
            /** @default queued */
            status: components["schemas"]["Status"];
            /**
             * Attempts
             * @default 0
             */
            attempts: number;
            /** Result */
            result: string | null;
            /** Scope */
            scope: string[];
            /** Acceptance */
            acceptance: string[];
            /** Verification Commands */
            verification_commands: string[][];
        };
        /** TelemetrySetting */
        TelemetrySetting: {
            /** Configured */
            configured: boolean;
            /**
             * Host
             * @description Host and port of the OTLP destination; never its path, query or credentials
             */
            host: string | null;
            /** Env Var */
            env_var: string;
        };
        /** TextListSetting */
        TextListSetting: {
            /** Value */
            value: string[];
            /** Env Var */
            env_var: string | null;
        };
        /** TextSetting */
        TextSetting: {
            /** Value */
            value: string;
            /** Env Var */
            env_var: string | null;
        };
        /** TokenBudgetIncrease */
        TokenBudgetIncrease: {
            /** Expected Revision */
            expected_revision: number;
            /** Expected Max Tokens */
            expected_max_tokens: number;
            /** Max Tokens */
            max_tokens: number;
        };
        /** ValidationError */
        ValidationError: {
            /** Location */
            loc: (string | number)[];
            /** Message */
            msg: string;
            /** Error Type */
            type: string;
            /** Input */
            input?: unknown;
            /** Context */
            ctx?: Record<string, never>;
        };
        /** WorkOrder */
        WorkOrder: {
            /** Project Id */
            project_id: string;
            /**
             * Mode
             * @enum {string}
             */
            mode: "create" | "maintain" | "patch" | "audit";
            /** Objective */
            objective: string;
            /** Acceptance */
            acceptance: string[];
            /** Constraints */
            constraints: string[];
            budget: components["schemas"]["Budget-Output"];
            /** Idempotency Key */
            idempotency_key: string;
            /**
             * Channel
             * @default api
             * @enum {string}
             */
            channel: "web" | "mcp" | "slack" | "api";
            /** Channel Thread */
            channel_thread: string | null;
            flow_config: components["schemas"]["FlowConfiguration-Output"];
            /** Id */
            id: string;
            /** @default queued */
            status: components["schemas"]["Status"];
            /**
             * Phase
             * @default intake
             */
            phase: string;
            /**
             * Graph Version
             * @default sabre-v1
             */
            graph_version: string;
            resolved_flow: components["schemas"]["ResolvedFlow"] | null;
            /** Configuration Snapshot */
            configuration_snapshot: {
                [key: string]: unknown;
            } | null;
            /** Admission Request Digest */
            admission_request_digest: string | null;
            effective_budget_policy: components["schemas"]["BudgetPolicy-Output"] | null;
            /**
             * Budget Revision
             * @default 0
             */
            budget_revision: number;
            /** Limiting Metric */
            limiting_metric: string | null;
            budget_denial: components["schemas"]["BudgetDenial"] | null;
            /**
             * Repair Cycles Used
             * @default 0
             */
            repair_cycles_used: number;
            /** Last Failure Fingerprint */
            last_failure_fingerprint: string | null;
            /**
             * Identical Failure Count
             * @default 0
             */
            identical_failure_count: number;
            /**
             * Last Failure Cycle
             * @default -1
             */
            last_failure_cycle: number;
            /**
             * Plan Revision
             * @default 1
             */
            plan_revision: number;
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /**
             * Updated At
             * Format: date-time
             */
            updated_at: string;
            /** Tasks */
            tasks: components["schemas"]["Task"][];
            /** Questions */
            questions: components["schemas"]["HumanQuestion"][];
            /** Findings */
            findings: components["schemas"]["SecurityFinding"][];
            /** Security Snapshot Digest */
            security_snapshot_digest: string | null;
            /** Security Rules Version */
            security_rules_version: string | null;
            evidence: components["schemas"]["DeliveryEvidence"] | null;
            /**
             * Summary
             * @default Queued
             */
            summary: string;
            /** Error Code */
            error_code: string | null;
            /**
             * Calls Used
             * @default 0
             */
            calls_used: number;
            /**
             * Tokens Used
             * @default 0
             */
            tokens_used: number;
            /**
             * Cost Usd
             * @default 0
             */
            cost_usd: number;
            /**
             * Active Seconds Used
             * @default 0
             */
            active_seconds_used: number;
            /** Control */
            control: ("pause" | "cancel") | null;
        };
        /** WorkOrderCreate */
        WorkOrderCreate: {
            /** Project Id */
            project_id: string;
            /**
             * Mode
             * @enum {string}
             */
            mode: "create" | "maintain" | "patch" | "audit";
            /** Objective */
            objective: string;
            /** Acceptance */
            acceptance: string[];
            /** Constraints */
            constraints?: string[];
            budget: components["schemas"]["Budget-Input"];
            /** Idempotency Key */
            idempotency_key: string;
            /**
             * Channel
             * @default api
             * @enum {string}
             */
            channel: "web" | "mcp" | "slack" | "api";
            /** Channel Thread */
            channel_thread?: string | null;
            flow_config?: components["schemas"]["FlowConfiguration-Input"];
        };
        /** AgentMessage */
        AgentMessage: {
            /**
             * Version
             * @constant
             */
            version: 1;
            /** Run Id */
            run_id: string;
            /** Step Id */
            step_id: string;
            /** Attempt */
            attempt: number;
            /**
             * Sender
             * @enum {string}
             */
            sender: "pm" | "designer" | "developer" | "qa" | "manager" | "devops" | "ciso";
            /**
             * Recipient
             * @enum {string}
             */
            recipient: "pm" | "designer" | "developer" | "qa" | "manager" | "devops" | "ciso";
            /** Correlation Id */
            correlation_id: string;
            /** Content */
            content: string;
            /** Artifacts */
            artifacts?: components["schemas"]["ArtifactReference"][];
        };
        /** AnalysisResult */
        AnalysisResult: {
            /**
             * Version
             * @constant
             */
            version: 1;
            /**
             * Status
             * @enum {string}
             */
            status: "completed" | "needs_input" | "rejected";
            /** Summary */
            summary: string;
            /** Questions */
            questions: string[];
            /** Evidence */
            evidence: string[];
            /** Decisions */
            decisions: string[];
        };
        /** ImplementationResult */
        ImplementationResult: {
            /**
             * Version
             * @constant
             */
            version: 1;
            /**
             * Status
             * @enum {string}
             */
            status: "completed" | "needs_input" | "rejected";
            /** Summary */
            summary: string;
            /** Questions */
            questions: string[];
            /** Evidence */
            evidence: string[];
            /** Changed Paths */
            changed_paths: string[];
        };
        /** PlannedTask */
        PlannedTask: {
            /** Id */
            id: string;
            /** Title */
            title: string;
            /**
             * Role
             * @constant
             */
            role: "developer";
            /**
             * Specialty
             * @enum {string}
             */
            specialty: "general" | "backend" | "frontend" | "infrastructure" | "documentation";
            /** Depends On */
            depends_on: string[];
            /** Scope */
            scope: string[];
            /** Acceptance */
            acceptance: string[];
            /** Verification Commands */
            verification_commands: string[][];
        };
        /** PlanningResult */
        PlanningResult: {
            /**
             * Version
             * @constant
             */
            version: 1;
            /**
             * Status
             * @enum {string}
             */
            status: "completed" | "needs_input" | "rejected";
            /** Summary */
            summary: string;
            /** Questions */
            questions: string[];
            /** Evidence */
            evidence: string[];
            /** Tasks */
            tasks: components["schemas"]["PlannedTask"][];
        };
        /** ReviewResult */
        ReviewResult: {
            /**
             * Version
             * @constant
             */
            version: 1;
            /**
             * Status
             * @enum {string}
             */
            status: "completed" | "needs_input" | "rejected";
            /** Summary */
            summary: string;
            /** Questions */
            questions: string[];
            /** Evidence */
            evidence: string[];
            /** Findings */
            findings: string[];
        };
        /** StepResult */
        StepResult: {
            /**
             * Version
             * @constant
             */
            version: 1;
            /** Run Id */
            run_id: string;
            /** Step Id */
            step_id: string;
            /** Attempt */
            attempt: number;
            /**
             * Sender
             * @enum {string}
             */
            sender: "pm" | "designer" | "developer" | "qa" | "manager" | "devops" | "ciso";
            /**
             * Recipient
             * @enum {string}
             */
            recipient: "pm" | "designer" | "developer" | "qa" | "manager" | "devops" | "ciso";
            /** Correlation Id */
            correlation_id: string;
            /**
             * Capability
             * @enum {string}
             */
            capability: "requirements" | "design" | "architecture" | "planning" | "implementation" | "verification" | "review" | "delivery" | "security";
            /** Result */
            result: components["schemas"]["AnalysisResult"] | components["schemas"]["ImplementationResult"] | components["schemas"]["PlanningResult"] | components["schemas"]["ReviewResult"];
            /** Artifacts */
            artifacts?: components["schemas"]["ArtifactReference"][];
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    health_health_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    execute_command_api_v1_commands_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CommandEnvelope"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CommandResult"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    status_api_v1_status_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    agent_catalog_api_v1_agents_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentCatalog"];
                };
            };
        };
    };
    agents_activity_api_v1_agents_activity_get: {
        parameters: {
            query?: {
                days?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentActivity"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    agent_definition_api_v1_agents__agent_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                agent_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentCatalogEntry"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    save_agent_draft_api_v1_agents__agent_id__draft_put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                agent_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AgentDraftSave"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentCatalogEntry"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    validate_agent_draft_api_v1_agents__agent_id__validate_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                agent_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AgentRevision"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentValidation"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    publish_agent_draft_api_v1_agents__agent_id__publish_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                agent_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AgentRevision"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentCatalogEntry"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    model_configuration_api_v1_model_configuration_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ModelConfiguration"];
                };
            };
        };
    };
    change_model_configuration_api_v1_model_configuration_put: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ModelConfigurationChange"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ModelConfiguration"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    system_api_v1_system_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SystemInfo"];
                };
            };
        };
    };
    integrations_api_v1_integrations_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["IntegrationInfo"][];
                };
            };
        };
    };
    integration_state_api_v1_integrations__integration_id__state_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                integration_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["IntegrationStateChange"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["IntegrationInfo"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    mcp_connections_api_v1_mcp_connections_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MCPConnectionInfo"][];
                };
            };
        };
    };
    save_mcp_connection_api_v1_mcp_connections__name__put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                name: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MCPConnectionSave"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MCPConnectionInfo"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    discover_mcp_connection_api_v1_mcp_connections__name__discover_post: {
        parameters: {
            query: {
                expected_revision: number;
            };
            header?: never;
            path: {
                name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MCPDiscovery"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    repository_proposals_api_v1_repository_proposals_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RepoCreationPage"];
                };
            };
        };
    };
    propose_repository_api_v1_repository_proposals_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RepoCreationRequest-Input"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RepoCreationProposal"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    create_repository_flow_api_v1_create_flows_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateFlowLaunch"];
            };
        };
        responses: {
            /** @description Successful Response */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RepoCreationProposal"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    repository_proposal_api_v1_repository_proposals__proposal_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                proposal_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RepoCreationProposal"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    decide_repository_api_v1_repository_proposals__proposal_id__decision_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                proposal_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RepoCreationDecision"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RepoCreationProposal"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    reconcile_repository_api_v1_repository_proposals__proposal_id__reconcile_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                proposal_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RepoCreationProposal"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    github_repositories_api_v1_integrations_github_repositories_search_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["GitHubRepositorySearch"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GitHubRepositoryPage"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    github_import_api_v1_integrations_github_import_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["GitHubRepositoryImport"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Project"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    chat_api_v1_chat_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    [key: string]: unknown;
                };
            };
        };
        responses: {
            /** @description Successful Response */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    operator_messages_api_v1_operator_messages_get: {
        parameters: {
            query?: {
                work_id?: string | null;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OperatorMessagePage"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    operator_message_api_v1_operator_messages_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["OperatorMessageRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OperatorMessageView"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    operator_message_tools_api_v1_operator_messages__message_id__tools_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                message_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OperatorToolTracePage"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    operator_readiness_api_v1_operator_readiness_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FactoryReadinessView"];
                };
            };
        };
    };
    resume_operator_message_api_v1_operator_messages__message_id__resume_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                message_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["OperatorMessageResume"];
            };
        };
        responses: {
            /** @description Successful Response */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OperatorMessageView"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    projects_api_v1_projects_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Project"][];
                };
            };
        };
    };
    create_project_api_v1_projects_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ProjectCreate"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Project"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    project_tools_api_v1_projects__project_id__mcp_tools_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProjectToolsPolicy"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    change_project_tools_api_v1_projects__project_id__mcp_tools_put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ProjectToolsChange"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProjectToolsPolicy"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    notification_statuses_api_v1_notifications_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeliveryStatus"][];
                };
            };
        };
    };
    retry_notification_api_v1_notifications__delivery_id__retry_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                delivery_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeliveryStatus"][];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    flow_configuration_schema_api_v1_flows_schema_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    parse_flow_api_v1_flows_parse_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["FlowYamlRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FlowConfiguration-Output"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    execution_events_api_v1_work__work_id__execution_events_get: {
        parameters: {
            query?: {
                after?: number;
                limit?: number;
            };
            header?: never;
            path: {
                work_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EventPage"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    works_api_v1_work_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkOrder"][];
                };
            };
        };
    };
    submit_api_v1_work_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WorkOrderCreate"];
            };
        };
        responses: {
            /** @description Successful Response */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkOrder"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    work_api_v1_work__work_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                work_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkOrder"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    work_usage_api_v1_work__work_id__usage_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                work_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunUsageSnapshot"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    work_budget_api_v1_work__work_id__budget_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                work_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BudgetView"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    amend_work_budget_api_v1_work__work_id__budget_amend_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                work_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BudgetAmendment"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkOrder"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    reconcile_work_budget_api_v1_work__work_id__budget_reconcile_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                work_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BudgetReconciliation"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkOrder"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    answer_api_v1_work__work_id__answer_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                work_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["Answer"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkOrder"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    pause_api_v1_work__work_id__pause_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                work_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkOrder"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    resume_api_v1_work__work_id__resume_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                work_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkOrder"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    cancel_api_v1_work__work_id__cancel_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                work_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkOrder"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    scope_api_v1_work__work_id__scope_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                work_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ScopeChange"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkOrder"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    increase_token_budget_api_v1_work__work_id__budget_tokens_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                work_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TokenBudgetIncrease"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkOrder"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    increase_call_budget_api_v1_work__work_id__budget_calls_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                work_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CallBudgetIncrease"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkOrder"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    use_cli_progress_limits_api_v1_work__work_id__cli_progress_limits_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                work_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CliProgressLimitsChange"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkOrder"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    events_api_v1_work__work_id__events_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                work_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    work_audit_api_v1_work__work_id__audit_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                work_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AuditView"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    project_knowledge_api_v1_projects__project_id__knowledge_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProjectKnowledgeReport"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    memories_api_v1_memory_get: {
        parameters: {
            query: {
                project_id: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MemoryItem"][];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    propose_memory_api_v1_memory_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MemoryCreate"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MemoryItem"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    memory_search_api_v1_memory_search_get: {
        parameters: {
            query: {
                project_id: string;
                query: string;
                commit: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    approve_memory_api_v1_memory__memory_id__approve_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                memory_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["MemoryApproval"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MemoryItem"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    carry_memory_forward_api_v1_memory__memory_id__carry_forward_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                memory_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MemoryCarryForward"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MemoryValidityRecord"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    invalidate_memory_api_v1_memory__memory_id__invalidate_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                memory_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MemoryItem"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    memory_graph_api_v1_projects__project_id__memory_graph_get: {
        parameters: {
            query?: {
                focus?: string | null;
                depth?: number;
                limit?: number;
            };
            header?: never;
            path: {
                project_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MemoryGraph"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    memory_recalls_api_v1_projects__project_id__memory_recalls_get: {
        parameters: {
            query?: {
                work_id?: string | null;
                memory_id?: string | null;
                cursor?: string | null;
                limit?: number;
            };
            header?: never;
            path: {
                project_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MemoryRecallPage"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    memory_items_api_v1_projects__project_id__memory_items_get: {
        parameters: {
            query?: {
                state?: ("active" | "pending" | "invalidated" | "stale") | null;
                kind?: ("fact" | "lesson") | null;
                q?: string | null;
                cursor?: string | null;
                limit?: number;
            };
            header?: never;
            path: {
                project_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MemoryItemPage"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    memory_review_api_v1_projects__project_id__memory_review_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MemoryReview"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    memory_detail_api_v1_memory__memory_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                memory_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MemoryDetail"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    secret_targets_api_v1_secret_targets_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SecretTarget"][];
                };
            };
        };
    };
    secrets_api_v1_secrets_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SecretMetadata"][];
                };
            };
        };
    };
    upsert_secret_api_v1_secrets__secret_id__post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                secret_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SecretUpsert"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SecretMetadata"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    deactivate_secret_api_v1_secrets__secret_id__deactivate_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                secret_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SecretDeactivate"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SecretMetadata"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    security_api_v1_security_get: {
        parameters: {
            query?: {
                project_id?: string | null;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    security_exceptions_api_v1_work__work_id__security_exceptions_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                work_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SecurityException"][];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    approve_security_exception_api_v1_work__work_id__security_exceptions_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                work_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SecurityExceptionCreate"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SecurityException"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    revoke_security_exception_api_v1_work__work_id__security_exceptions__exception_id__revoke_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                work_id: string;
                exception_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SecurityException"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    discovery__well_known_agent_card_json_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    ingress_a2a_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    grants_api_v1_delegations_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GrantView"][];
                };
            };
        };
    };
    issue_api_v1_delegations_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["GrantCreate"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GrantIssued"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    revoke_api_v1_delegations__identifier__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                identifier: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GrantRevoked"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    agents_api_v1_a2a_agents_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["A2AAgentInfo"][];
                };
            };
        };
    };
    register_api_v1_a2a_agents__name__put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                name: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AgentRegistration"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["A2AAgentInfo"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    inspect_api_v1_a2a_agents__name__discover_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                name: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CardDiscovery"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentCardDiscovery"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    remote_tasks_api_v1_work__work_id__a2a_tasks_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                work_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["A2ATaskInfo"][];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    poll_remote_api_v1_work__work_id__a2a_tasks_poll_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                work_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["A2AReceiptRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["A2ATaskInfo"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    answer_remote_api_v1_work__work_id__a2a_tasks_answer_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                work_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["A2AInputAnswer"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["A2ATaskInfo"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    cancel_remote_api_v1_work__work_id__a2a_tasks_cancel_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                work_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["A2AReceiptRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["A2ATaskInfo"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    run_api_v1_work__work_id__browser_qa_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                work_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BrowserJob"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BrowserReport"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    reports_api_v1_work__work_id__browser_reports_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                work_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BrowserReport"][];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    artifact_api_v1_work__work_id__browser_artifacts__artifact_digest__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                work_id: string;
                artifact_digest: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    flow_topology_api_v1_flows__mode__topology_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                mode: "patch" | "maintain" | "create" | "audit";
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProcessTopology"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    builtin_tools_api_v1_tools_catalog_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BuiltinToolCatalog"];
                };
            };
        };
    };
    configuration_api_v1_configuration_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConfigurationView"];
                };
            };
        };
    };
    save_configuration_api_v1_configuration_put: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ConfigurationSave"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConfigurationView"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    preview_configuration_api_v1_configuration_preview_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ConfigurationDocument"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConfigurationPreview"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    configuration_history_api_v1_configuration_history_get: {
        parameters: {
            query?: {
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConfigurationHistory"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    confirmations_api_v1_confirmations_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OwnerConfirmationPage"];
                };
            };
        };
    };
    confirm_api_v1_confirmations__confirmation_id__confirm_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                confirmation_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ConfirmationDecision"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OwnerConfirmation"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    reject_api_v1_confirmations__confirmation_id__reject_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                confirmation_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ConfirmationDecision"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OwnerConfirmation"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    inspection_api_v1_work__work_id__inspection_get: {
        parameters: {
            query?: {
                agent_id?: string | null;
                role?: string | null;
                after?: number;
                limit?: number;
                checkpoint_id?: string | null;
            };
            header?: never;
            path: {
                work_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunInspection"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    ingestion_report_api_v1_projects__project_id__ingestion_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["IngestionReport"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    request_ingestion_api_v1_projects__project_id__ingestion_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["IngestionRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["IngestionJob"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    releases_api_v1_releases_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReleasePage"];
                };
            };
        };
    };
    prepare_api_v1_releases_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ReleasePreparation"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReleaseCandidate"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    candidate_api_v1_releases__candidate_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                candidate_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReleaseCandidate"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    artifact_api_v1_releases__candidate_id__artifacts__artifact_digest__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                candidate_id: string;
                artifact_digest: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    authorize_api_v1_releases__candidate_id__authorize_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                candidate_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ReleaseAuthorization"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReleaseCandidate"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    publish_api_v1_releases__candidate_id__publish_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                candidate_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ReleasePublication"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReleaseCandidate"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
}
