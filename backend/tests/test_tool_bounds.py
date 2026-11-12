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
