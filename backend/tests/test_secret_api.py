from types import SimpleNamespace

import httpx
import pytest
from pydantic import SecretStr

from sabre.api import create_app
from sabre.models import DomainError, SecretMetadata, SecretTarget, SecretUpsert, now

OWNER = "owner-test-token-at-least-24"
SLOT = "model.openai.default"


class StoreService:
    def __init__(self):
        self.version = 0
        self.configured = False
        self.value = None
        self.calls = []

    def metadata(self):
        return SecretMetadata(id=SLOT, version=self.version, configured=self.configured, updated_at=now())

    async def secret_targets(self):
        self.calls.append("targets")
        return [SecretTarget(id=SLOT, label="Modelo por defecto · OpenAI")]

    async def list_secrets(self):
        self.calls.append("metadata")
        return [self.metadata()] if self.version else []

    async def upsert_secret(self, secret_id, request: SecretUpsert):
        self.calls.append(("upsert", secret_id, request.expected_version))
        assert isinstance(request.value, SecretStr)
        if request.expected_version != (self.version or None):
            raise DomainError("SECRET_VERSION_CONFLICT", "Private diagnostic must not be returned", 409)
        self.value = request.value
        self.version += 1
        self.configured = True
        return self.metadata()

    async def deactivate_secret(self, secret_id, expected_version):
        self.calls.append(("deactivate", secret_id, expected_version))
        if self.version != expected_version:
            raise DomainError("SECRET_VERSION_CONFLICT", "Private diagnostic must not be returned", 409)
        self.version += 1
        self.configured = False
        self.value = None
        return self.metadata()


def application(service):
    return create_app(service, SimpleNamespace(auth_token=SecretStr(OWNER), allowed_origins=["http://localhost:8000"]))


async def test_secret_routes_require_owner_token_and_deny_other_origins_before_store_calls():
    service = StoreService()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(application(service)), base_url="http://localhost:8000") as client:
        assert (await client.get("/api/v1/secrets")).status_code == 401
        assert (await client.get("/api/v1/secret-targets")).status_code == 401
        response = await client.post(f"/api/v1/secrets/{SLOT}", json={"value": "synthetic-private-value"})
        assert response.status_code == 401
        response = await client.post(f"/api/v1/secrets/{SLOT}", headers={"Authorization": f"Bearer {OWNER}", "Origin": "https://attacker.example"}, json={"value": "synthetic-private-value"})
        assert response.status_code == 403
        assert "synthetic-private-value" not in response.text
    assert service.calls == []


async def test_owner_can_list_targets_write_replace_and_deactivate_with_only_metadata_responses():
    service = StoreService()
    headers = {"Authorization": f"Bearer {OWNER}"}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(application(service)), base_url="http://localhost:8000", headers=headers) as client:
        assert (await client.get("/api/v1/secrets")).json() == []
        assert (await client.get("/api/v1/secret-targets")).json() == [{"id": SLOT, "label": "Modelo por defecto · OpenAI"}]
        first = await client.post(f"/api/v1/secrets/{SLOT}", json={"value": "synthetic-first-value", "expected_version": None})
        assert first.status_code == 200
        assert set(first.json()) == {"id", "version", "configured", "updated_at"}
        assert first.json()["version"] == 1
        assert "synthetic-first-value" not in first.text
        replaced = await client.post(f"/api/v1/secrets/{SLOT}", json={"value": "synthetic-second-value", "expected_version": 1})
        assert replaced.json()["version"] == 2
        assert service.value.get_secret_value() == "synthetic-second-value"
        conflict = await client.post(f"/api/v1/secrets/{SLOT}", json={"value": "synthetic-stale-value", "expected_version": 1})
        assert conflict.status_code == 409
        assert conflict.json()["code"] == "SECRET_VERSION_CONFLICT"
        assert "Private diagnostic" not in conflict.text
        disabled = await client.post(f"/api/v1/secrets/{SLOT}/deactivate", json={"expected_version": 2})
        assert disabled.json()["version"] == 3
        assert not disabled.json()["configured"]
        assert service.value is None
        assert set((await client.get("/api/v1/secrets")).json()[0]) == {"id", "version", "configured", "updated_at"}
        assert "nonce" not in disabled.text and "cipher" not in disabled.text
    assert ("deactivate", SLOT, 2) in service.calls


@pytest.mark.parametrize("body", [
    {"value": "", "expected_version": None},
    {"value": "synthetic-private-value", "expected_version": 0},
    {"value": "synthetic-private-value", "synthetic-private-extra-key": "another-private-value"},
])
async def test_secret_validation_never_echoes_values_or_extra_field_names(body):
    service = StoreService()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(application(service)), base_url="http://localhost:8000", headers={"Authorization": f"Bearer {OWNER}"}) as client:
        response = await client.post(f"/api/v1/secrets/{SLOT}", json=body)
    assert response.status_code == 422
    assert response.json() == {"code": "INVALID_REQUEST", "message": "Review the credential destination, value and version"}
    assert "synthetic-private" not in response.text
    assert service.calls == []


async def test_secret_deactivation_requires_a_version_before_calling_store():
    service = StoreService()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(application(service)), base_url="http://localhost:8000", headers={"Authorization": f"Bearer {OWNER}"}) as client:
        response = await client.post(f"/api/v1/secrets/{SLOT}/deactivate", json={})
    assert response.status_code == 422
    assert service.calls == []


async def test_secret_errors_do_not_reflect_arbitrary_exception_codes_or_messages():
    service = StoreService()

    async def fail(secret_id, request):
        raise DomainError("synthetic-private-value", "synthetic-private-value", 503)

    service.upsert_secret = fail
    async with httpx.AsyncClient(transport=httpx.ASGITransport(application(service)), base_url="http://localhost:8000", headers={"Authorization": f"Bearer {OWNER}"}) as client:
        response = await client.post(f"/api/v1/secrets/{SLOT}", json={"value": "synthetic-private-value"})
    assert response.status_code == 503
    assert response.json()["code"] == "SECRET_STORE_ERROR"
    assert "synthetic-private-value" not in response.text
