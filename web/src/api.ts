import type { components, paths } from './api-schema';

export type DeliveryStatus = components['schemas']['DeliveryStatus'];

export type Project =
  paths['/api/v1/projects']['get']['responses'][200]['content']['application/json'][number];
export type ProjectCreate = components['schemas']['ProjectCreate'];
export type WorkOrder = paths['/api/v1/work']['get']['responses'][200]['content']['application/json'][number];
export type WorkOrderCreate = components['schemas']['WorkOrderCreate'];
export type HumanQuestion = NonNullable<WorkOrder['questions']>[number];
export type MemoryItem =
  paths['/api/v1/memory']['get']['responses'][200]['content']['application/json'][number];
export type MemoryCreate = components['schemas']['MemoryCreate'];
export type SecurityFinding = NonNullable<WorkOrder['findings']>[number];
export type Answer = components['schemas']['Answer'];
export type ScopeChange = components['schemas']['ScopeChange'];
export type CliProgressLimitsChange = components['schemas']['CliProgressLimitsChange'];
export type SecurityException = components['schemas']['SecurityException'];
export type SecurityExceptionCreate = components['schemas']['SecurityExceptionCreate'];
export type SecretTarget = components['schemas']['SecretTarget'];
export type SecretMetadata = components['schemas']['SecretMetadata'];
export type SecretUpsert = components['schemas']['SecretUpsert'];
export type SecretDeactivate = components['schemas']['SecretDeactivate'];
export type SystemInfo = components['schemas']['SystemInfo'];
export type AuditView = components['schemas']['AuditView'];
export type ProjectKnowledgeReport = components['schemas']['ProjectKnowledgeReport'];
export type IntegrationInfo = components['schemas']['IntegrationInfo'];
export type IntegrationStateChange = components['schemas']['IntegrationStateChange'];
export type GitHubRepositorySearch = components['schemas']['GitHubRepositorySearch'];
export type GitHubRepositoryPage = components['schemas']['GitHubRepositoryPage'];
export type GitHubRepositoryInfo = components['schemas']['GitHubRepositoryInfo'];
export type GitHubRepositoryImport = components['schemas']['GitHubRepositoryImport'];
export type MCPConnectionInfo = components['schemas']['MCPConnectionInfo'];
export type MCPConnectionSave = components['schemas']['MCPConnectionSave'];
export type MCPDiscovery = components['schemas']['MCPDiscovery'];
export type MCPToolSettings = components['schemas']['MCPToolSettings'];
export type RepoCreationRequest = components['schemas']['RepoCreationRequest-Input'];
export type RepoCreationProposal = components['schemas']['RepoCreationProposal'];
export type RepoCreationPage = components['schemas']['RepoCreationPage'];
export type CreateFlowLaunch = components['schemas']['CreateFlowLaunch'];
export type RepoCreationDecision = components['schemas']['RepoCreationDecision'];
export type ProjectToolsPolicy = components['schemas']['ProjectToolsPolicy'];
export type ProjectToolsChange = components['schemas']['ProjectToolsChange'];
export type ModelSelection = components['schemas']['ModelSelection-Output'];
export type ModelConfiguration = components['schemas']['ModelConfiguration'];
export type ModelConfigurationChange = components['schemas']['ModelConfigurationChange'];
export type FactoryConfiguration = components['schemas']['FactoryConfiguration'];
export type ConfigurationView = components['schemas']['ConfigurationView'];
export type ConfigurationPreview = components['schemas']['ConfigurationPreview'];
export type ConfigurationSave = components['schemas']['ConfigurationSave'];
export type BuiltinToolCatalog = components['schemas']['BuiltinToolCatalog'];
export type AgentCatalog = components['schemas']['AgentCatalog'];
export type AgentCatalogEntry = components['schemas']['AgentCatalogEntry'];
export type AgentDefinition = components['schemas']['AgentDefinition-Output'];
export type AgentDraftSave = components['schemas']['AgentDraftSave'];
export type AgentValidation = components['schemas']['AgentValidation'];
export type BudgetPolicy = components['schemas']['BudgetPolicy-Output'];
export type BudgetView = components['schemas']['BudgetView'];
export type BudgetAmendment = components['schemas']['BudgetAmendment'];
export type BudgetReconciliation = components['schemas']['BudgetReconciliation'];
export type BudgetMetric = BudgetAmendment['metric'];
export type CommandResult = components['schemas']['CommandResult'];
export type ReleaseCandidate = components['schemas']['ReleaseCandidate'];
export type ReleasePage = components['schemas']['ReleasePage'];
export type ReleasePreparation = components['schemas']['ReleasePreparation'];
export type ReleaseAuthorization = components['schemas']['ReleaseAuthorization'];
export type ReleasePublication = components['schemas']['ReleasePublication'];
export type MetricBudget = components['schemas']['MetricBudget-Output'];
export type RunInspection = components['schemas']['RunInspection'];
export type ProcessTopology = components['schemas']['ProcessTopology'];
export type IngestionReport = components['schemas']['IngestionReport'];
export type IngestionRequest = components['schemas']['IngestionRequest'];
export type IngestionJob = components['schemas']['IngestionJob'];
export type A2AAgentInfo = components['schemas']['A2AAgentInfo'];
export type AgentCardDiscovery = components['schemas']['AgentCardDiscovery'];
export type AgentRegistration = components['schemas']['AgentRegistration'];
export type CardDiscovery = components['schemas']['CardDiscovery'];
export type A2ATaskInfo = components['schemas']['A2ATaskInfo'];
export type A2AInputAnswer = components['schemas']['A2AInputAnswer'];
export type BrowserReport = components['schemas']['BrowserReport'];
export type DelegationCreate = components['schemas']['GrantCreate'];
export type DelegationGrant = components['schemas']['GrantView'];
export type IssuedDelegation = components['schemas']['GrantIssued'];
export type RevokedDelegation = components['schemas']['GrantRevoked'];

export type FlowConfiguration = components['schemas']['FlowConfiguration-Input'];
export type SequencedEvent = components['schemas']['SequencedEvent'];
export type EventPage = components['schemas']['EventPage'];
export type OperatorMessageRequest = components['schemas']['OperatorMessageRequest'];
export type OperatorMessageView = components['schemas']['OperatorMessageView'];
export type OperatorMessagePage = components['schemas']['OperatorMessagePage'];
export type OperatorMessageResume = components['schemas']['OperatorMessageResume'];
export type OperatorAction = NonNullable<OperatorMessageRequest['allowed_actions']>[number];

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface PanelSession {
  authenticated: true;
  csrf_token: string;
  expires_at: string;
}

export async function openPanelSession(): Promise<PanelSession | null> {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const hasTicket = fragment.has('ticket');
  const ticket = fragment.get('ticket');
  if (hasTicket) {
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${window.location.search}`,
    );
    if (!ticket || fragment.getAll('ticket').length !== 1)
      throw new ApiError(401, 'The access link is invalid. Open SABRE again from the launcher.');
  }
  let response: Response;
  try {
    response = await fetch(`/api/v1/panel/session${hasTicket ? '/exchange' : ''}`, {
      method: hasTicket ? 'POST' : 'GET',
      ...(hasTicket ? { body: JSON.stringify({ ticket }) } : {}),
      headers: { 'Content-Type': 'application/json', 'X-Sabre-UI': '1' },
      credentials: 'same-origin',
      mode: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
    });
  } catch {
    throw new ApiError(0, 'SABRE is unreachable. Check that the factory is running.');
  }
  if (response.status === 401 && !hasTicket) return null;
  if (!response.ok)
    throw new ApiError(
      response.status,
      response.status === 401
        ? 'The access link expired or was already used. Open SABRE again from the launcher.'
        : 'The session could not be opened. Open SABRE again from the launcher.',
    );
  const value: unknown = await response.json().catch(() => null);
  if (
    !value ||
    typeof value !== 'object' ||
    !('authenticated' in value) ||
    value.authenticated !== true ||
    !('csrf_token' in value) ||
    typeof value.csrf_token !== 'string' ||
    !value.csrf_token ||
    !('expires_at' in value) ||
    typeof value.expires_at !== 'string'
  )
    throw new ApiError(
      502,
      'The SABRE session could not be verified. Open the panel again from the launcher.',
    );
  return value as PanelSession;
}

function errorMessage(body: unknown): string {
  if (typeof body === 'string') return body;
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    if (typeof record.message === 'string') return record.message;
    if (typeof record.detail === 'string') return record.detail;
    if (record.detail && typeof record.detail === 'object') {
      if (Array.isArray(record.detail)) return 'Review the form fields.';
      const detail = record.detail as Record<string, unknown>;
      if (typeof detail.message === 'string') return detail.message;
    }
  }
  return 'The request could not be completed.';
}

export function createApi(csrfToken: string, onUnauthorized?: (message: string) => void) {
  async function request<T>(path: string, options: RequestInit = {}, sensitive = false): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`/api/v1${path}`, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          'X-Sabre-UI': '1',
          ...(!['GET', 'HEAD'].includes((options.method || 'GET').toUpperCase())
            ? { 'X-CSRF-Token': csrfToken }
            : {}),
          ...options.headers,
        },
        credentials: 'same-origin',
        mode: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
      });
    } catch {
      throw new ApiError(0, 'SABRE is unreachable. Check that the factory is running.');
    }
    if (!response.ok) {
      if (response.status === 401) {
        const message = 'The session expired. Open SABRE again from the launcher.';
        onUnauthorized?.(message);
        throw new ApiError(401, message);
      }
      const body: unknown = await response.json().catch(() => null);
      if (
        response.status === 403 &&
        body &&
        typeof body === 'object' &&
        'code' in body &&
        body.code === 'PANEL_CSRF_DENIED'
      ) {
        const message = 'The browser session changed. Reload the panel before retrying.';
        onUnauthorized?.(message);
        throw new ApiError(403, message);
      }
      if (sensitive) {
        const messages: Record<number, string> = {
          403: 'This session cannot manage credentials.',
          409: 'The credential changed. Refresh its state before writing it again.',
          422: 'Review the credential destination, value and version.',
          503: 'The credential store is unavailable. Check the SABRE control service.',
        };
        throw new ApiError(
          response.status,
          messages[response.status] ||
            'The credential operation could not be confirmed. Refresh its state before retrying.',
        );
      }
      throw new ApiError(response.status, errorMessage(body));
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }
  return {
    delegations: () => request<DelegationGrant[]>('/delegations'),
    issueDelegation: (value: DelegationCreate) =>
      request<IssuedDelegation>('/delegations', { method: 'POST', body: JSON.stringify(value) }, true),
    revokeDelegation: (id: string) =>
      request<RevokedDelegation>(`/delegations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    logout: () => request<void>('/panel/session/logout', { method: 'POST' }),
    status: () => request<Record<string, unknown>>('/status'),
    deliveries: () => request<DeliveryStatus[]>('/notifications'),
    retryDelivery: (id: string) =>
      request<DeliveryStatus[]>(`/notifications/${encodeURIComponent(id)}/retry`, { method: 'POST' }),
    projects: () => request<Project[]>('/projects'),
    createProject: (value: ProjectCreate) =>
      request<Project>('/projects', { method: 'POST', body: JSON.stringify(value) }),
    work: () => request<WorkOrder[]>('/work'),
    getWork: (id: string) => request<WorkOrder>(`/work/${encodeURIComponent(id)}`),
    a2aTasks: (id: string) => request<A2ATaskInfo[]>(`/work/${encodeURIComponent(id)}/a2a-tasks`),
    pollA2ATask: (id: string, attemptKey: string) =>
      request<A2ATaskInfo>(`/work/${encodeURIComponent(id)}/a2a-tasks/poll`, {
        method: 'POST',
        body: JSON.stringify({ attempt_key: attemptKey }),
      }),
    answerA2ATask: (id: string, value: A2AInputAnswer) =>
      request<A2ATaskInfo>(`/work/${encodeURIComponent(id)}/a2a-tasks/answer`, {
        method: 'POST',
        body: JSON.stringify(value),
      }),
    cancelA2ATask: (id: string, attemptKey: string) =>
      request<A2ATaskInfo>(`/work/${encodeURIComponent(id)}/a2a-tasks/cancel`, {
        method: 'POST',
        body: JSON.stringify({ attempt_key: attemptKey }),
      }),
    workBudget: (id: string) => request<BudgetView>(`/work/${encodeURIComponent(id)}/budget`),
    releases: () => request<ReleasePage>('/releases'),
    getRelease: (id: string) => request<ReleaseCandidate>(`/releases/${encodeURIComponent(id)}`),
    prepareRelease: (value: ReleasePreparation) =>
      request<ReleaseCandidate>('/releases', { method: 'POST', body: JSON.stringify(value) }),
    authorizeRelease: (id: string, value: ReleaseAuthorization) =>
      request<ReleaseCandidate>(`/releases/${encodeURIComponent(id)}/authorize`, {
        method: 'POST',
        body: JSON.stringify(value),
      }),
    publishRelease: (id: string, value: ReleasePublication) =>
      request<ReleaseCandidate>(`/releases/${encodeURIComponent(id)}/publish`, {
        method: 'POST',
        body: JSON.stringify(value),
      }),
    amendBudget: (id: string, value: BudgetAmendment, idempotencyKey: string) =>
      request<CommandResult>('/commands', {
        method: 'POST',
        body: JSON.stringify({
          version: 1,
          idempotency_key: idempotencyKey,
          correlation_id: idempotencyKey,
          payload: { type: 'work.budget.amend', work_id: id, request: value },
        }),
      }).then((result) => result.work),
    reconcileBudget: (id: string, value: BudgetReconciliation, idempotencyKey: string) =>
      request<CommandResult>('/commands', {
        method: 'POST',
        body: JSON.stringify({
          version: 1,
          idempotency_key: idempotencyKey,
          correlation_id: idempotencyKey,
          payload: { type: 'work.budget.reconcile', work_id: id, request: value },
        }),
      }).then((result) => result.work),
    parseFlow: (document: string) =>
      request<FlowConfiguration>('/flows/parse', { method: 'POST', body: JSON.stringify({ document }) }),
    executionEvents: (id: string, after = 0) =>
      request<EventPage>(`/work/${encodeURIComponent(id)}/execution-events?after=${after}&limit=200`),
    supervisorMessages: (workId: string | null = null) =>
      request<OperatorMessagePage>(
        `/operator/messages${workId ? `?work_id=${encodeURIComponent(workId)}` : ''}`,
      ),
    talkSupervisor: (value: OperatorMessageRequest) =>
      request<OperatorMessageView>('/operator/messages', { method: 'POST', body: JSON.stringify(value) }),
    createWork: (value: WorkOrderCreate) =>
      request<WorkOrder>('/work', { method: 'POST', body: JSON.stringify(value) }),
    answer: (id: string, value: Answer) =>
      request<WorkOrder>(`/work/${encodeURIComponent(id)}/answer`, {
        method: 'POST',
        body: JSON.stringify(value),
      }),
    resumeSupervisorMessage: (id: string, value: OperatorMessageResume) =>
      request<OperatorMessageView>(`/operator/messages/${encodeURIComponent(id)}/resume`, {
        method: 'POST',
        body: JSON.stringify(value),
      }),
    control: (id: string, action: 'pause' | 'resume' | 'cancel') =>
      request<WorkOrder>(`/work/${encodeURIComponent(id)}/${action}`, { method: 'POST' }),
    scope: (id: string, value: ScopeChange) =>
      request<WorkOrder>(`/work/${encodeURIComponent(id)}/scope`, {
        method: 'POST',
        body: JSON.stringify(value),
      }),
    useCliProgressLimits: (id: string, value: CliProgressLimitsChange) =>
      request<WorkOrder>(`/work/${encodeURIComponent(id)}/cli-progress-limits`, {
        method: 'POST',
        body: JSON.stringify(value),
      }),
    events: (id: string) => request<Record<string, unknown>[]>(`/work/${encodeURIComponent(id)}/events`),
    system: () => request<SystemInfo>('/system'),
    audit: (id: string) => request<AuditView>(`/work/${encodeURIComponent(id)}/audit`),
    inspection: (id: string, role?: string, agentId?: string, after = 0, checkpointId?: string) => {
      const query = new URLSearchParams({ after: String(after), limit: '50' });
      if (role) query.set('role', role);
      if (agentId) query.set('agent_id', agentId);
      if (checkpointId) query.set('checkpoint_id', checkpointId);
      return request<RunInspection>(`/work/${encodeURIComponent(id)}/inspection?${query}`);
    },
    browserReports: (id: string) =>
      request<BrowserReport[]>(`/work/${encodeURIComponent(id)}/browser-reports`),
    browserArtifact: async (id: string, digest: string): Promise<Blob> => {
      const response = await fetch(
        `/api/v1/work/${encodeURIComponent(id)}/browser-artifacts/${encodeURIComponent(digest)}`,
        {
          method: 'GET',
          credentials: 'same-origin',
          mode: 'same-origin',
          cache: 'no-store',
          redirect: 'error',
          headers: { 'X-Sabre-UI': '1' },
        },
      );
      if (!response.ok)
        throw new ApiError(
          response.status,
          'Browser evidence could not be loaded. Refresh the session or inspect the artifact review requirements.',
        );
      return response.blob();
    },
    knowledge: (id: string) =>
      request<ProjectKnowledgeReport>(`/projects/${encodeURIComponent(id)}/knowledge`),
    ingestion: (id: string) => request<IngestionReport>(`/projects/${encodeURIComponent(id)}/ingestion`),
    requestIngestion: (id: string, value: IngestionRequest) =>
      request<IngestionJob>(`/projects/${encodeURIComponent(id)}/ingestion`, {
        method: 'POST',
        body: JSON.stringify(value),
      }),
    integrations: () => request<IntegrationInfo[]>('/integrations'),
    modelConfiguration: () => request<ModelConfiguration>('/model-configuration'),
    configuration: () => request<ConfigurationView>('/configuration'),
    previewConfiguration: (document: string) =>
      request<ConfigurationPreview>('/configuration/preview', {
        method: 'POST',
        body: JSON.stringify({ version: 1, document }),
      }),
    saveConfiguration: (value: ConfigurationSave) =>
      request<ConfigurationView>('/configuration', {
        method: 'PUT',
        body: JSON.stringify(value),
      }),
    toolsCatalog: () => request<BuiltinToolCatalog>('/tools/catalog'),
    flowTopology: (mode: WorkOrder['mode']) =>
      request<ProcessTopology>(`/flows/${encodeURIComponent(mode)}/topology`),
    agents: () => request<AgentCatalog>('/agents'),
    a2aAgents: () => request<A2AAgentInfo[]>('/a2a/agents'),
    saveA2AAgent: (name: string, value: AgentRegistration) =>
      request<A2AAgentInfo>(`/a2a/agents/${encodeURIComponent(name)}`, {
        method: 'PUT',
        body: JSON.stringify(value),
      }),
    discoverA2AAgent: (name: string, value: CardDiscovery) =>
      request<AgentCardDiscovery>(`/a2a/agents/${encodeURIComponent(name)}/discover`, {
        method: 'POST',
        body: JSON.stringify(value),
      }),
    agent: (id: string) => request<AgentCatalogEntry>(`/agents/${encodeURIComponent(id)}`),
    saveAgent: (id: string, value: AgentDraftSave) =>
      request<AgentCatalogEntry>(`/agents/${encodeURIComponent(id)}/draft`, {
        method: 'PUT',
        body: JSON.stringify(value),
      }),
    validateAgent: (id: string, expected_revision: number) =>
      request<AgentValidation>(`/agents/${encodeURIComponent(id)}/validate`, {
        method: 'POST',
        body: JSON.stringify({ expected_revision }),
      }),
    publishAgent: (id: string, expected_revision: number) =>
      request<AgentCatalogEntry>(`/agents/${encodeURIComponent(id)}/publish`, {
        method: 'POST',
        body: JSON.stringify({ expected_revision }),
      }),
    saveModelConfiguration: (value: ModelConfigurationChange) =>
      request<ModelConfiguration>('/model-configuration', { method: 'PUT', body: JSON.stringify(value) }),
    mcpConnections: () => request<MCPConnectionInfo[]>('/mcp-connections'),
    projectTools: (id: string) =>
      request<ProjectToolsPolicy>(`/projects/${encodeURIComponent(id)}/mcp-tools`),
    setProjectTools: (id: string, value: ProjectToolsChange) =>
      request<ProjectToolsPolicy>(`/projects/${encodeURIComponent(id)}/mcp-tools`, {
        method: 'PUT',
        body: JSON.stringify(value),
      }),
    saveMCPConnection: (name: string, value: MCPConnectionSave) =>
      request<MCPConnectionInfo>(`/mcp-connections/${encodeURIComponent(name)}`, {
        method: 'PUT',
        body: JSON.stringify(value),
      }),
    discoverMCPTools: (name: string, revision: number) =>
      request<MCPDiscovery>(
        `/mcp-connections/${encodeURIComponent(name)}/discover?expected_revision=${revision}`,
        { method: 'POST' },
      ),
    repositoryProposals: () => request<RepoCreationPage>('/repository-proposals'),
    launchCreate: (value: CreateFlowLaunch) =>
      request<RepoCreationProposal>('/create-flows', { method: 'POST', body: JSON.stringify(value) }),
    proposeRepository: (value: RepoCreationRequest) =>
      request<RepoCreationProposal>('/repository-proposals', { method: 'POST', body: JSON.stringify(value) }),
    decideRepository: (id: string, value: RepoCreationDecision) =>
      request<RepoCreationProposal>(`/repository-proposals/${encodeURIComponent(id)}/decision`, {
        method: 'POST',
        body: JSON.stringify(value),
      }),
    reconcileRepository: (id: string) =>
      request<RepoCreationProposal>(`/repository-proposals/${encodeURIComponent(id)}/reconcile`, {
        method: 'POST',
      }),
    setIntegrationState: (id: string, value: IntegrationStateChange) =>
      request<IntegrationInfo>(`/integrations/${encodeURIComponent(id)}/state`, {
        method: 'POST',
        body: JSON.stringify(value),
      }),
    githubRepositories: (value: GitHubRepositorySearch) =>
      request<GitHubRepositoryPage>('/integrations/github/repositories/search', {
        method: 'POST',
        body: JSON.stringify(value),
      }),
    importGitHubRepository: (value: GitHubRepositoryImport) =>
      request<Project>('/integrations/github/import', {
        method: 'POST',
        body: JSON.stringify(value),
      }),
    memory: (projectId: string) =>
      request<MemoryItem[]>(`/memory?project_id=${encodeURIComponent(projectId)}`),
    createMemory: (value: MemoryCreate) =>
      request<MemoryItem>('/memory', { method: 'POST', body: JSON.stringify(value) }),
    memoryAction: (id: string, action: 'approve' | 'invalidate') =>
      request<MemoryItem>(`/memory/${encodeURIComponent(id)}/${action}`, { method: 'POST' }),
    security: (projectId?: string) =>
      request<SecurityFinding[]>(
        `/security${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`,
      ),
    securityExceptions: (id: string) =>
      request<SecurityException[]>(`/work/${encodeURIComponent(id)}/security-exceptions`),
    approveSecurityException: (id: string, value: SecurityExceptionCreate) =>
      request<SecurityException>(`/work/${encodeURIComponent(id)}/security-exceptions`, {
        method: 'POST',
        body: JSON.stringify(value),
      }),
    revokeSecurityException: (id: string, exceptionId: string) =>
      request<SecurityException>(
        `/work/${encodeURIComponent(id)}/security-exceptions/${encodeURIComponent(exceptionId)}/revoke`,
        { method: 'POST' },
      ),
    secretTargets: () => request<SecretTarget[]>('/secret-targets', {}, true),
    secrets: () => request<SecretMetadata[]>('/secrets', {}, true),
    upsertSecret: (id: string, value: SecretUpsert) =>
      request<SecretMetadata>(
        `/secrets/${encodeURIComponent(id)}`,
        { method: 'POST', body: JSON.stringify(value) },
        true,
      ),
    deactivateSecret: (id: string, value: SecretDeactivate) =>
      request<SecretMetadata>(
        `/secrets/${encodeURIComponent(id)}/deactivate`,
        { method: 'POST', body: JSON.stringify(value) },
        true,
      ),
  };
}

export type Api = ReturnType<typeof createApi>;
