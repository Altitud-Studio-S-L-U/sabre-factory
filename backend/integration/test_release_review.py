"""Adversarial release regressions: immutable source and protected CI identity."""

import pytest

from integration.test_release_candidates import candidate
from integration.test_release_candidates import release_service as release_service
from sabre.models import DomainError
from sabre.release_candidates import ReleaseAuthorization, ReleasePreparation, ReleasePublication

pytest_plugins = ["integration.test_postgres"]


async def authorize(service, prepared):
    return await service.authorize(prepared.id, ReleaseAuthorization(version=1, expected_revision=prepared.revision,
        candidate_digest=prepared.digest, authorize_publication=True))


async def test_tag_moved_during_asset_upload_blocks_before_irreversible_publication(release_service):
    service, remote, work, _ = release_service
    prepared = await candidate(service, work)
    approved = await authorize(service, prepared)
    original = service.github.request

    async def moved_tag(method, path, **kwargs):
        response = await original(method, path, **kwargs)
        if method == "POST" and path.endswith("/assets"):
            remote["tag_sha"] = "e" * 40
        return response

    service.github.request = moved_tag
    with pytest.raises(DomainError):
        await service.publish(prepared.id, ReleasePublication(version=1, expected_revision=approved.revision,
            candidate_digest=approved.digest, idempotency_key="review-tag-moved"))
    assert remote["publish_count"] == 0
    assert remote["release"]["draft"] is True


@pytest.mark.parametrize("field", ["body", "target_commitish"])
async def test_draft_identity_changed_during_upload_blocks_before_publication(release_service, field):
    service, remote, work, _ = release_service
    prepared = await candidate(service, work)
    approved = await authorize(service, prepared)
    original = service.github.request

    async def changed_draft(method, path, **kwargs):
        response = await original(method, path, **kwargs)
        if method == "POST" and path.endswith("/assets"):
            remote["release"][field] = ("Different notes\n\nSABRE candidate: " + approved.digest) if field == "body" else "e" * 40
        return response

    service.github.request = changed_draft
    with pytest.raises(DomainError):
        await service.publish(prepared.id, ReleasePublication(version=1, expected_revision=approved.revision,
            candidate_digest=approved.digest, idempotency_key="review-draft-" + field))
    assert remote["publish_count"] == 0


async def test_check_name_from_wrong_app_cannot_satisfy_protected_ci_identity(release_service):
    service, remote, work, _ = release_service
    prepared = await candidate(service, work)
    original = service.github.request

    async def spoofed_check(method, path, **kwargs):
        response = await original(method, path, **kwargs)
        if path.endswith("/protection/required_status_checks"):
            return {"contexts": [], "checks": [{"context": "unit", "app_id": 123}]}
        if path.endswith("/check-runs"):
            return {**response, "check_runs": [{**item, "app": {"id": 999}} for item in response["check_runs"]]}
        return response

    service.github.request = spoofed_check
    with pytest.raises(DomainError):
        await authorize(service, prepared)
    assert (await service._row(prepared.id))["publication_grant"] is None
    assert remote["create_count"] == 0


async def test_successful_legacy_commit_status_can_satisfy_its_required_context(release_service):
    service, remote, work, _ = release_service
    remote["required"] = ["legacy-security"]
    original = service.github.request

    async def legacy_status(method, path, **kwargs):
        response = await original(method, path, **kwargs)
        if path.endswith("/status"):
            return {"sha": work.evidence.commit, "state": "success", "total_count": 1,
                "statuses": [{"context": "legacy-security", "state": "success"}]}
        return response

    service.github.request = legacy_status
    prepared = await service.prepare(ReleasePreparation(version=1, work_id=work.id, package_version="2.0.0",
        idempotency_key="review-legacy-status", required_checks=["unit", "legacy-security"]))
    assert prepared.blockers == []
    assert (await authorize(service, prepared)).status == "authorized"
    assert remote["create_count"] == 0
