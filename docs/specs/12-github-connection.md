# 12 · GitHub connection

## Outcome
Replace the three pasted GitHub tokens with one connection made from the console. The owner clicks Connect GitHub, approves on github.com which repositories the factory may use, and returns. Nothing is pasted, access is per repository, and every operation runs with a short-lived token scoped to that operation. Existing token destinations keep working until the owner connects.

## Why a GitHub App
A GitHub App registered from a manifest is the only option that needs no pasted secret, grants access per repository and lets the factory ask for a token narrower than its installation on each call. A classic OAuth app's `repo` scope covers every repository of the account, and a fine-grained personal token is still a pasted secret bound to one resource owner. Reading, delivering and creating remain three separate switches because they are three separate risks; they stop being three credentials.

## Interfaces and behavior
**Connect.** The console posts a manifest form to GitHub from the paired browser: `/settings/apps/new` for a personal account or `/organizations/{org}/settings/apps/new` for an organization. The owner chooses which, because a private app installs only on the account that owns it. The manifest disables webhook delivery (the instance has no public address), names a loopback `redirect_url` and `setup_url` on the console's own origin and declares the permissions below. GitHub returns a one-time `code`; the control service exchanges it at `POST /app-manifests/{code}/conversions` within the hour and stores the app id, client id, client secret and private key as write-only vault destinations. The `state` value is single-use, bound to the paired browser session and checked on return. The owner is then sent to the app's installation page to choose the repositories.

**Installation.** The `installation_id` that arrives on the setup address is untrusted: the service lists the app's installations with its own JWT and accepts only an id it finds there. The console shows the account, the app and the repositories the installation reaches, with a link to manage them on GitHub. Disconnect removes the stored app credentials and says where to uninstall or delete the app; it never claims to have revoked anything upstream.

**Tokens.** The service signs a JWT (RS256, issuer the client id, at most ten minutes) and requests an installation token per operation, restricted with `repository_ids` to the one repository and with `permissions` to what the operation needs:

| Operation | Permissions |
| --- | --- |
| Browse, import, clone | `contents: read` |
| Read CI for a delivered commit | `checks: read`, `statuses: read` |
| Push a branch and open a draft pull request | `contents: write`, `pull_requests: write`; `workflows: write` only when the change touches `.github/workflows` and the run's permissions allow it |
| Create a repository in an organization | `repository_creation: write`, on an installation made by an organization owner |

Tokens live for one hour, are held in memory until they expire, re-minted on a 401 and never persisted or logged. Redaction and secret scanning recognise installation tokens by their documented prefix and must not assume a length. Requests pin `X-GitHub-Api-Version`.

**Signed commits and attribution.** A branch pushed with git over an installation token carries unsigned commits, which a "Require signed commits" rule rejects or leaves unmergeable. The publisher therefore creates delivery commits through the API as the app, with no custom author, committer or signature, so GitHub signs them and shows them as verified, authored by `<slug>[bot]`. The pull request body keeps naming the run and the owner who approved delivery. Git push stays available for repositories without that rule.

**Personal accounts and repository creation.** The documentation does not confirm that an installation token may create a repository under a personal account. Until a test settles it, creation under a personal account uses a user access token obtained with the authorization-code flow and PKCE on the loopback address, stored like any other credential and renewed with its single-use refresh token. Creation in an organization uses the installation.

**Compatibility.** `github.read`, `github.publish` and `github.create` remain the three capability switches with their revisions. While no app is connected they use their token destinations exactly as today. Once connected, each capability uses the installation and the console offers to remove the old tokens. No credential is imported from the operator's CLI or keychain.

## Console
Tools › GitHub opens on one card. Not connected: one Connect GitHub button and what will happen. Connected: the account, the app, the repositories it reaches, Manage on GitHub and Disconnect. The three capability rows follow with their switches. Adding a project lists the installation's repositories directly ([13](13-projects.md)).

## Acceptance
Against a synthetic GitHub: a forged or replayed `state`, an expired `code`, a spoofed `installation_id` and a lost conversion response are each refused or reconciled without leaving partial credentials. A read operation never receives a write token, and a token for one repository is refused by another. Disabling a capability blocks its next call. A delivery to a repository that requires signed commits produces verified commits; a repository without the rule still accepts a git push. Redaction covers every token format. An installation that still uses pasted tokens keeps delivering unchanged until it connects.

Live evidence against github.com, for a personal account and for an organization, is required before the connection is described as available.
