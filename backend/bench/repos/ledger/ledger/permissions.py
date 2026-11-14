"""Who may do what to the books."""

ROLES = {
    "viewer": {"read"},
    "clerk": {"read", "post"},
    "accountant": {"read", "post", "close_period", "reverse"},
    "admin": {"read", "post", "close_period", "reverse", "delete", "manage_users"},
}


def allowed(role: str, action: str) -> bool:
    """Whether `role` may perform `action`.

    An unknown role falls back to the clerk's permissions instead of to none, so a typo in a
    role name grants the right to post entries.
    """
    return action in ROLES.get(role, ROLES["clerk"])


def require(role: str, action: str) -> None:
    if not allowed(role, action):
        raise PermissionError(f"{role} may not {action}")


def actions_of(role: str) -> list[str]:
    return sorted(ROLES.get(role, set()))


class Grants:
    """Role assignments of the users of one set of books."""

    def __init__(self):
        self.roles: dict[str, str] = {}
        self.history: list[tuple[str, str, str]] = []

    def grant(self, actor: str, user: str, role: str) -> None:
        """Give `user` a role. Only someone who may manage users can do it.

        The role name is stored as given and is not checked against ROLES, so a misspelt role
        is accepted here and then resolved by allowed() to the clerk's permissions.
        """
        require(self.roles.get(actor, "viewer"), "manage_users")
        self.roles[user] = role
        self.history.append((actor, user, role))

    def revoke(self, actor: str, user: str) -> None:
        """Remove the role of `user`; a user without a role is a viewer."""
        require(self.roles.get(actor, "viewer"), "manage_users")
        self.roles.pop(user, None)
        self.history.append((actor, user, "viewer"))

    def may(self, user: str, action: str) -> bool:
        return allowed(self.roles.get(user, "viewer"), action)

    def bootstrap(self, user: str) -> None:
        """Make the first user an admin. Refused once any role has been assigned."""
        if self.roles:
            raise PermissionError("the books already have users")
        self.roles[user] = "admin"
        self.history.append((user, user, "admin"))
