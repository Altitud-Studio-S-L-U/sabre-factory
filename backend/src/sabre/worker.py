import asyncio
import sys

from sabre.runtime import Runtime
from sabre.settings import settings


async def main():
    async with Runtime(settings()) as runtime:
        queues = ["maintenance", "slack", "operator"] if "--control" in sys.argv else ["work"]
        await runtime.queue.run_worker_async(concurrency=2 if "--control" in sys.argv else runtime.config.execution_slots, queues=queues, shutdown_graceful_timeout=30)


if __name__ == "__main__":
    asyncio.run(main())
