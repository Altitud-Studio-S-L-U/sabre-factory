import asyncio

from sabre.runtime import Runtime
from sabre.settings import settings


async def main():
    async with Runtime(settings()):
        pass


if __name__ == "__main__":
    asyncio.run(main())
