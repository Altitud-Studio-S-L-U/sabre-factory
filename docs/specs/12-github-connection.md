# 12 · GitHub connection

## Outcome
Replace the three pasted GitHub tokens with one connection made from the console. The owner clicks Connect GitHub, approves on github.com which repositories the factory may use, and returns. Nothing is pasted, access is per repository, and every operation runs with a short-lived token scoped to that operation. Existing token destinations keep working until the owner connects.

## Why a GitHub App
A GitHub App registered from a manifest is the only option that needs no pasted secret, grants access per repository and lets the factory ask for a token narrower than its installation on each call. A classic OAuth app's `repo` scope covers every repository of the account, and a fine-grained personal token is still a pasted secret bound to one resource owner. Reading, delivering and creating remain three separate switches because they are three separate risks; they stop being three credentials.

## Built so far
- *Connect.* Tools › GitHub opens on a connection card. Connect GitHub posts the manifest from the paired browser to a personal account or to a named organization, with webhook delivery off and the return addresses on the console's origin. The `state` is used once, by the browser it was issued to, within the hour. The returned code is exchanged for the app's credentials: the private key and the client secret go to the vault, the app's public details to the database, and a failure at any point leaves neither. A lost answer says where to delete the app on GitHub, because the code is spent and the key was never received.
- *Installation.* Only an installation the app itself lists is kept; the identifier a browser brings is a hint. Without one, a single listed installation is taken, and none or several leave the choice to the owner. Disconnect removes the app's credentials here and says that nothing was revoked on GitHub.
- *Tokens.* Reading and delivering ask for an installation token per operation, with `repositories` naming the one repository and `permissions` naming what the operation needs: `contents: read` to browse, import and clone, `contents: write` and `pull_requests: write` to deliver. A token lives in memory until two minutes before its hour ends, is minted again when GitHub answers 401, is never stored and is known to the secret guard, which now recognises GitHub tokens by prefix whatever their length. The executor names the repository it is about to read, so the control answers with a token for that one.
- *Signed commits.* Delivery already creates its commits through the API. Through the connection a commit names no author, committer or signature, so GitHub creates it as the app and signs it. With a pasted token it names SABRE as before.
- *Compatibility.* `github.read`, `github.publish` and `github.create` stay three switches. While no app is installed they use their token destinations exactly as before. Once installed, reading and delivering use the installation and the console stops offering a token for them; creating repositories keeps its own token.
- *Projects.* Importing a repository lists what the installation reaches instead of searching an account.

Not built: creating a repository through the app. The documentation consulted did not confirm which permission an installation needs to create one in an organization, so the manifest does not ask for it, and the user access token with PKCE for personal accounts is not built either. Reading CI (`checks`, `statuses`) and the `workflows` permission are declared and asked for at registration, but no operation uses them yet. The console does not offer to delete the old tokens.

**None of this has met github.com.** Every behaviour above was exercised against a synthetic GitHub that checks the app token's signature and enforces each installation token by repository and permission. Until the owner connects a personal account and an organization, the connection is not to be described as available.

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
