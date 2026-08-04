# GitHub integration

Two independent features, added in migration `0002_github.sql` and the
`src/lib/github/*` modules. Either can be left unconfigured.

1. **GitHub sign-in** — a "Continue with GitHub" button on the login screen,
   backed by Supabase's GitHub OAuth provider. It sits alongside email/password
   and magic links; it does not replace them.
2. **Repository connection** — a room can be bound to one GitHub repository
   through a GitHub App installation, giving that room's Claude the ability to
   read the code and (optionally) open pull requests.

## Why a GitHub App, not a stored token

The room credential is a GitHub App *installation*, and the only thing stored is
its numeric id. Access tokens are minted on demand from the app's private key
(`src/lib/github/app.ts`), live one hour, and are scoped to exactly the
repositories the installer selected. Nothing long-lived is persisted, so a
database leak exposes no repository access, and revoking the installation in
GitHub's UI ends our access within the hour with no cleanup on our side.

## The write gate

This is the load-bearing security decision. A collaborator's message reaches
Claude as framed data, but it still *steers* what Claude decides to do. If a
collaborator could cause a pull request, a successful prompt injection would end
in a branch pushed to the owner's repository.

So repository writes require a turn the **Core Prompter sent themselves**:

| Trigger | Repo reads | Repo writes (PR) |
| --- | --- | --- |
| Core Prompter sends a message | yes | yes, if mode is `read_pr` |
| Collaborator sends (open mode) | yes | **no** |
| Collaborator message the owner *approves* | yes | **no** |
| Combined contributions the owner sends | yes | **no** |

Approval mode does not unlock writes. Approval gates which *messages* reach
Claude; it does not change who authored the text driving the turn. The pipeline
passes `actorIsCorePrompter: false` on every approve/combine path
(`src/lib/server/pipeline.ts`) for exactly this reason.

The gate is enforced in two places that must both hold:

- `repoToolsFor()` only *offers* the `repo_open_pull_request` tool when the
  turn is a Core Prompter turn in a `read_pr` room, so Claude never plans around
  a capability it lacks.
- `executeRepoTool()` re-checks the same condition at execution and records a
  `repo.write_denied` audit entry if a write is attempted anyway.

## Access modes

- `read` — browse the tree, read files, search code. Nothing is written.
- `read_pr` — additionally, the Core Prompter can have Claude push a branch and
  open a pull request. There is deliberately **no** mode that writes to the
  default branch: every change goes through GitHub's own review.

## The tools Claude sees

Defined in `src/lib/github/tools.ts`, executed against `src/lib/github/repo.ts`:

| Tool | Effect |
| --- | --- |
| `repo_list_files` | List a directory or the whole tree (paths only). |
| `repo_read_file` | Read one file (capped at 120 KB, binary rejected). |
| `repo_search_code` | Search code, scoped server-side to the connected repo. |
| `repo_open_pull_request` | Branch + commit + PR in one atomic changeset. Gated. |

Every call — read, write, or denied write — is recorded in `repo_actions`,
which the room can see in the repository panel. Model-supplied paths and branch
names are validated (`safeRepoPath`, `safeBranchName`) to reject traversal and
malformed refs before they reach GitHub.

## Ownership binding

A room can only be pointed at an installation its **own owner** completed. The
`guard_repo_connection` trigger (`0002_github.sql`) raises if the installation's
`installed_by` is not the room owner, which stops an owner who learned a
stranger's installation id — they are small integers that appear in GitHub URLs
— from reading a repository they were never granted. The `/github/setup`
callback additionally verifies each installation id against GitHub, as the app,
before recording the claim.

## Data flow of a repo-aware turn

1. A message enters the normal nine-step pipeline (auth, validators, storage).
2. `dispatchToClaude` loads the room's `repo_connections` row.
3. If connected, it appends a one-line repo note to the (otherwise frozen)
   system prompt and offers the read tools — plus the PR tool only on a Core
   Prompter turn in `read_pr` mode.
4. `runClaudeToolTurn` runs the manual tool loop: Claude calls a tool, the
   server executes it under the room's installation token, the result returns,
   repeat until Claude answers or the per-turn tool budget (16 calls) is spent.
5. Claude's final text is saved as the assistant message; each tool call is
   saved to `repo_actions`. A pull request URL surfaces both in Claude's reply
   and in the repository panel.

## Environment

See `.env.example`. `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, and
`GITHUB_APP_PRIVATE_KEY` are server-only. GitHub sign-in needs no app env var —
the OAuth client secret lives in Supabase.

## What is not included

- No webhook handling. Installation suspension/deletion is reflected lazily,
  the next time a token mint fails, rather than in real time.
- The installation-token cache is in-memory and per-instance, like the rate
  limiter. This is correct (a second instance simply mints its own token) but
  worth knowing.
- Pull requests replace whole files; there is no line-level patch tool.
