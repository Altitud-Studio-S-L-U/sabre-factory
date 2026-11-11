"""Tool results are bounded and say how to continue."""

from types import SimpleNamespace

from sabre.tools import MAX_LISTED_FILES, MAX_READ_BYTES, bounded_execution, bounded_files, bounded_read


def test_large_reads_listings_and_command_output_are_bounded_with_continuation():
    content = "".join(f"line {index}\n" for index in range(20_000))
    read = bounded_read("big.py", content)
    assert read["truncated"] and len(read["content"].encode()) <= MAX_READ_BYTES and read["content"].endswith("\n")
    assert read["next"].startswith(f"Continue with read_file_range from line {read['shown_lines'] + 1}")
    assert bounded_read("small.py", "x = 1\n") == "x = 1\n"
    listed = bounded_files([f"f{index}.py" for index in range(MAX_LISTED_FILES + 5)])
    assert listed["truncated"] and len(listed["files"]) == MAX_LISTED_FILES and listed["total_files"] == MAX_LISTED_FILES + 5
    artifacts = SimpleNamespace(put=lambda raw: "e" * 64)
    output = "start\n" + "x" * 100_000 + "\nFAILED last line"
    bounded = bounded_execution({"exit_code": 1, "output": output}, artifacts)
    assert bounded["output_truncated"] and bounded["output_digest"] == "e" * 64 and bounded["output_bytes"] == len(output.encode())
    assert bounded["output"].startswith("start") and bounded["output"].endswith("FAILED last line")
    assert len(bounded["output"].encode()) < 17_000
    assert bounded_execution({"exit_code": 0, "output": "ok"}, artifacts) == {"exit_code": 0, "output": "ok"}


async def test_read_files_batches_reads_keeps_other_files_on_a_missing_one_and_bounds_the_total():
    from sabre.models import DomainError
    from sabre.tools import MAX_BATCH_BYTES, workspace_tools

    class Workspace:
        async def read_file(self, work_id, path):
            if path == "missing.py":
                raise DomainError("WORKSPACE_IO_FAILED", "The workspace operation failed: FileNotFoundError (exit 2)", 422)
            if path == "down.py":
                raise DomainError("WORKSPACE_IO_FAILED", "The workspace helper did not return a valid result (exit 1)", 503)
            return {"a.py": "a = 1\n", "big.py": "x = 1\n" * 20_000}.get(path, "y = 2\n")

    catalog = workspace_tools(Workspace(), "work", role="developer")
    result = await catalog.invoke("read_files", {"paths": ["a.py", "missing.py", "big.py", "c.py"]}, "developer")
    first, missing, big, rest = result["files"]
    assert first == {"path": "a.py", "content": "a = 1\n"}
    assert missing["error"]["code"] == "WORKSPACE_IO_FAILED"
    assert big["truncated"] and len(big["content"].encode()) <= MAX_BATCH_BYTES
    assert rest["path"] == "c.py"
    import pytest
    with pytest.raises(DomainError):
        await catalog.invoke("read_files", {"paths": ["down.py"]}, "developer")
    with pytest.raises(DomainError) as error:
        await catalog.invoke("read_files", {"paths": [f"f{index}.py" for index in range(9)]}, "developer")
    assert error.value.code == "INVALID_TOOL_ARGUMENTS"
