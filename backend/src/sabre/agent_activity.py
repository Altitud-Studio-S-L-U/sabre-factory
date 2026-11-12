"""Factory-wide agent activity aggregated from recorded execution events and the usage ledger."""

from datetime import datetime

from pydantic import Field

from sabre.contracts import StrictContract

MAX_ACTIVE_RUNS = 50


class RoleActivity(StrictContract):
    role: str
    invocations: int = Field(description="Agent invocations started in the window")
    completed: int
    failed: int
    interrupted: int
    duration_ms: int = Field(description="Total measured duration of finished invocations")
    model_calls: int = Field(description="Model calls attributed to this role in the usage ledger")
    tokens: int | None = Field(description="Provider-measured tokens; null when no call of the role was measured")


class ActiveRun(StrictContract):
    work_id: str
    project_id: str
    status: str
    stage: str
    updated_at: datetime


class AgentActivity(StrictContract):
    days: int
    since: datetime
    roles: list[RoleActivity]
    repair_cycles: int = Field(description="Repair cycles used by runs updated in the window")
    waiting_for_input: int = Field(description="Runs currently waiting for an owner answer")
    active_runs: list[ActiveRun] = Field(description="Queued or running runs with their current stage, newest first, at most 50")
    active_runs_truncated: bool


async def agent_activity(repository, days: int) -> AgentActivity:
    async with repository.connection() as conn:
        since = (await (await conn.execute("SELECT now()-make_interval(days=>%s) AS since", (days,))).fetchone())["since"]
        events = await (await conn.execute("""SELECT data->>'name' AS role,
                count(*) FILTER(WHERE data->>'state'='started') AS invocations,
                count(*) FILTER(WHERE data->>'state'='completed') AS completed,
                count(*) FILTER(WHERE data->>'state'='failed') AS failed,
                count(*) FILTER(WHERE data->>'state'='interrupted') AS interrupted,
                coalesce(sum((data->>'duration_ms')::bigint) FILTER(WHERE data->>'state'<>'started'),0) AS duration_ms
            FROM run_events WHERE data->>'kind'='agent' AND (data->>'timestamp')::timestamptz>=%s
            GROUP BY 1 ORDER BY 1 LIMIT 100""", (since,))).fetchall()
        usage = await (await conn.execute("""SELECT context_receipt->>'role' AS role,count(*) AS calls,
                sum(actual_tokens) AS tokens FROM model_usage
            WHERE created_at>=%s AND context_receipt->>'role' IS NOT NULL GROUP BY 1 LIMIT 100""", (since,))).fetchall()
        runs = await (await conn.execute("""SELECT
                coalesce(sum((data->>'repair_cycles_used')::integer) FILTER(WHERE updated_at>=%s),0) AS repairs,
                count(*) FILTER(WHERE data->>'status'='waiting_input') AS waiting FROM work_orders""", (since,))).fetchone()
        active = await (await conn.execute("""SELECT id,project_id,data->>'status' AS status,data->>'phase' AS stage,updated_at
            FROM work_orders WHERE data->>'status' IN ('queued','running') ORDER BY updated_at DESC,id LIMIT %s""",
            (MAX_ACTIVE_RUNS + 1,))).fetchall()
    ledger = {row["role"]: row for row in usage}
    roles = {row["role"]: row for row in events}
    result = []
    for role in sorted(roles.keys() | ledger.keys()):
        event, spend = roles.get(role) or {}, ledger.get(role) or {}
        result.append(RoleActivity(role=role, invocations=int(event.get("invocations", 0)), completed=int(event.get("completed", 0)),
                                   failed=int(event.get("failed", 0)), interrupted=int(event.get("interrupted", 0)),
                                   duration_ms=int(event.get("duration_ms", 0)), model_calls=int(spend.get("calls", 0)),
                                   tokens=int(spend["tokens"]) if spend.get("tokens") is not None else None))
    return AgentActivity(days=days, since=since, roles=result, repair_cycles=int(runs["repairs"]), waiting_for_input=int(runs["waiting"]),
                         active_runs=[ActiveRun(work_id=row["id"], project_id=row["project_id"], status=row["status"], stage=row["stage"] or "intake",
                                                updated_at=row["updated_at"]) for row in active[:MAX_ACTIVE_RUNS]],
                         active_runs_truncated=len(active) > MAX_ACTIVE_RUNS)
