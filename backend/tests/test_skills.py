"""Skills are reviewed files; their digests are pinned by published definitions and flows."""

import pytest

from sabre.skills import DEFAULT_SKILLS, ROLES, SKILLS, load_skills, parse_skill

# Published agent definitions and resolved flows pin these digests. Changing a skill file
# changes its digest on purpose: update the value here in the same reviewed change.
PINNED = {
    "engineering": ("49b495498857676168e34d9ae0f1a220f0357df5a7bc789f09090118237a200c", {"analyst", "architect", "supervisor", "developer"}),
    "verification": ("5452742a0843efad6a5088f9f1e330580e42ee209ebc26996935ff5a4d627610", {"qa", "developer"}),
    "review": ("ae878469e96b2596fb15a0274a1bc02a5c358ceeb6cf40870049af7ab8e85f63", {"reviewer"}),
    "security": ("439356fbceb13fefe658d69104cdb2a4dea99c992dcf24224a7653d2e1981407", {"security"}),
}


def test_the_packaged_skills_keep_their_pinned_digests_and_roles():
    assert {name: (skill.digest, set(skill.roles)) for name, skill in SKILLS.items()} == PINNED
    for skill in SKILLS.values():
        assert "\n" not in skill.instruction and "  " not in skill.instruction


def test_every_default_skill_exists_and_may_be_used_by_some_role():
    assert {name for names in DEFAULT_SKILLS.values() for name in names} <= set(SKILLS)
    assert all(skill.roles <= ROLES for skill in SKILLS.values())


def test_line_breaks_in_a_skill_file_are_layout_and_do_not_change_its_digest():
    wrapped = parse_skill("example", "---\nroles: qa, developer\n---\nTest observable behavior.\nExecute registered checks.\n")
    single = parse_skill("example", "---\r\nroles: developer,qa\r\n---\r\n\r\nTest observable behavior.   Execute registered checks.")
    assert wrapped == single and wrapped.instruction == "Test observable behavior. Execute registered checks."


@pytest.mark.parametrize("name,text", [
    ("example", "Test observable behavior."),
    ("example", "---\nroles: qa\nTest observable behavior."),
    ("example", "---\nroles: owner\n---\nTest observable behavior."),
    ("example", "---\nroles:\n---\nTest observable behavior."),
    ("example", "---\nroles: qa\ntools: execute\n---\nTest observable behavior."),
    ("example", "---\nroles: qa\n---\n   \n"),
    ("example", "---\nroles: qa\n---\n" + "x" * 4001),
    ("Bad-Name", "---\nroles: qa\n---\nTest observable behavior."),
])
def test_a_malformed_skill_file_is_refused(name, text):
    with pytest.raises(ValueError, match="Skill"):
        parse_skill(name, text)


def test_skills_are_loaded_from_markdown_files_by_name(tmp_path):
    (tmp_path / "review.md").write_text("---\nroles: reviewer\n---\nReview the actual diff.\n", encoding="utf-8")
    (tmp_path / "notes.txt").write_text("not a skill", encoding="utf-8")
    loaded = load_skills(tmp_path)
    assert list(loaded) == ["review"] and loaded["review"].roles == {"reviewer"}
