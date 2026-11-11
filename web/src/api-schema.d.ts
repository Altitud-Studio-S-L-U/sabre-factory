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
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
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
            /** Last Checkpoint At */
            last_checkpoint_at: string | null;
            /** Duration Ms */
            duration_ms: null;
        };
        /** AuditModelUsage */
        AuditModelUsage: {
            /** Model Provider */
            model_provider: ("openai" | "local" | "anthropic" | "google" | "codex_cli" | "claude_cli") | null;
            /** Model Name */
            model_name: string | null;
            /** Role */
            role: ("supervisor" | "analyst" | "architect" | "developer" | "qa" | "reviewer" | "security") | null;
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
            /** Checkpoint Count */
            checkpoint_count: number;
            /** Checkpoint Threads */
            checkpoint_threads: number;
            /** Truncated */
            truncated: boolean;
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
            payload: components["schemas"]["Submit"] | components["schemas"]["Control"] | components["schemas"]["Respond"];
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
        /** PackageVersion */
        PackageVersion: {
            /** Distribution */
            distribution: string;
            /** Version */
            version: string | null;
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
}
