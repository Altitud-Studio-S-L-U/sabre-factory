import pytest

from sabre.process_topology import process_topology

MODES = ["patch", "maintain", "create", "audit"]


def ids(mode):
    return [station.id for station in process_topology(mode).stations]


def test_patch_line_follows_the_graph_order():
    assert ids("patch") == ["intake", "reproduce", "analyze", "plan", "implement", "checks", "scope_guard", "review",
                            "security", "route", "commit", "deliver", "remember"]


def test_modes_add_or_drop_stations_as_the_graph_does():
    assert "reproduce" not in ids("maintain")
    assert ids("create")[1:5] == ["analyze", "design", "architecture", "plan"]
    assert ids("audit") == ["intake", "analyze", "checks", "scope_guard", "review", "security", "audit_report"]


@pytest.mark.parametrize("mode", MODES)
def test_every_station_names_its_kind_stage_and_agent_consistently(mode):
    topology = process_topology(mode)
    seen_phases = set()
    for station in topology.stations:
        assert station.summary
        # Model stations always name the catalog agent; deterministic stations never do.
        assert (station.kind in {"model", "gates_model"}) == (station.agent is not None)
        assert not seen_phases.intersection(station.phases)
        seen_phases.update(station.phases)
    assert {station.stage for station in topology.stations} >= {"understand", "verify", "review", "security", "deliver"}


def test_reproduce_runs_gates_without_a_model_and_is_conditional():
    reproduce = next(station for station in process_topology("patch").stations if station.id == "reproduce")
    assert reproduce.kind == "gates" and reproduce.agent is None and reproduce.condition


def test_reviewer_and_planner_run_on_the_supervisor_and_helpers_are_conditional():
    stations = {station.id: station for station in process_topology("maintain").stations}
    assert stations["plan"].agent == "Supervisor" and stations["review"].agent == "Supervisor"
    assert stations["plan"].helpers[0].agent == "Designer" and stations["plan"].helpers[0].condition
    assert stations["commit"].helpers[0].agent == "DevOps"


def test_repair_loop_returns_to_implement_and_audit_has_none():
    loops = process_topology("patch").loops
    assert any(loop.source == "route" and loop.target == "implement" for loop in loops)
    assert process_topology("audit").loops == []


def test_owner_questions_are_marked_where_the_graph_can_interrupt():
    asking = {station.id for station in process_topology("create").stations if station.asks_owner}
    assert asking == {"analyze", "design", "architecture", "plan", "implement", "checks", "scope_guard", "review"}
