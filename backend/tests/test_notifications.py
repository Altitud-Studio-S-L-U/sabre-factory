import hashlib
import hmac
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from pydantic import ValidationError

from sabre.models import DomainError
from sabre.notifications import Notification, WebhookDelivery, WebhookDestination, signed_headers


def test_webhook_signature_binds_date_identifier_and_exact_bytes():
    secret = "synthetic-signing-material-for-tests-only"
    body = b'{"version":1}'
    signed = signed_headers("event-one", body, secret, 17)
    expected = hmac.new(secret.encode(), b"17.event-one." + body, hashlib.sha256).hexdigest()
    assert signed["X-Sabre-Signature"] == "v1=" + expected
    assert signed_headers("event-two", body, secret, 17) != signed
    assert signed_headers("event-one", body + b" ", secret, 17) != signed
    assert signed_headers("event-one", body, secret, 18) != signed


@pytest.mark.parametrize("endpoint", ["http://example.com", "https://127.0.0.1", "https://localhost", "https://example.com:8443", "https://user:password@example.com", "https://example.com?token=private"])
def test_webhooks_reject_private_or_ambiguous_destinations(endpoint):
    with pytest.raises((DomainError, ValidationError)):
        WebhookDestination(endpoint=endpoint)


def test_webhooks_never_accept_arbitrary_message_content():
    with pytest.raises(ValidationError):
        Notification(id="one", work_id="work", project_id="project", plan_revision=1,
            status="running", phase="review", prompt="private content")


async def test_changed_destination_does_not_receive_an_old_delivery():
    credentials = SimpleNamespace(resolve=AsyncMock())
    delivery = WebhookDelivery(None, {}, credentials)
    item = {"destination": "removed:old", "id": "one", "attempts": 1}
    delivery.claim = AsyncMock(return_value=[item])
    delivery.settle = AsyncMock()
    await delivery.deliver()
    credentials.resolve.assert_not_called()
    delivery.settle.assert_awaited_once_with(item, error="DESTINATION_CHANGED")
