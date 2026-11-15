import asyncio
import sys

from sabre.runtime import Runtime
from sabre.settings import settings


def worker_options(control: bool, execution_slots: int) -> dict:
    """How a worker of the factory runs its queues.

    A job that succeeded is deleted when it finishes. What it did is recorded where it belongs (the
    run, its events, a delivered notification), and the queue only needs the jobs still to do: the two
    maintenance tasks alone finish 2,880 times a day, and kept rows would grow by about a million a
    year on an instance that is left running. A job that failed is kept, for diagnosis.
    """
    return {
        "queues": ["maintenance", "slack", "operator"] if control else ["work"],
        "concurrency": 2 if control else execution_slots,
        "shutdown_graceful_timeout": 30,
        "delete_jobs": "successful",
    }


async def main():
    async with Runtime(settings()) as runtime:
        await runtime.queue.run_worker_async(**worker_options("--control" in sys.argv, runtime.config.execution_slots))


if __name__ == "__main__":
    asyncio.run(main())
