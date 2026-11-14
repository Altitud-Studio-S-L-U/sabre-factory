"""Fixed-purpose bootstrap clients for trusted broker and channel processes."""

import httpx

from sabre.models import DomainError


async def fetch_credentials(api_url: str, token: str, purpose: str, *, client=None, repository: str | None = None):
    fields = {"github-read": {"token"}, "slack": {"bot_token", "app_token"}}
    if purpose not in fields or not token:
        raise DomainError("CREDENTIAL_ADAPTER", "The credential adapter is not configured", 503)
    result = None
    try:
        headers = {"Authorization": "Bearer " + token}
        # The repository about to be read, so the control can answer with a credential for that one only.
        params = {"repository": repository} if repository else None
        if client is not None:
            response = await client.get("/internal/credentials/" + purpose, headers=headers, params=params)
        else:
            async with httpx.AsyncClient(base_url=api_url, timeout=10, follow_redirects=False) as transport:
                response = await transport.get("/internal/credentials/" + purpose, headers=headers, params=params)
        if response.status_code == 200:
            data = response.json()
            if isinstance(data, dict) and set(data) == fields[purpose] and all(isinstance(value, str) for value in data.values()):
                result = data
    except Exception:
        result = None
    if result is None:
        raise DomainError("CREDENTIAL_ADAPTER", "Could not obtain the authorized credential from the control", 503)
    return result
