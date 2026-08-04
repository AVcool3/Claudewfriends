import 'server-only'

import type Anthropic from '@anthropic-ai/sdk'

import type { Database, Json } from '@/lib/database.types'
import { createAdminClient } from '@/lib/supabase/admin'
import { recordAudit } from '@/lib/server/audit'
import type { RepoAccessMode, RepoConnection, RepoTool } from '@/lib/types'
import { MAX_REPO_TOOL_CALLS_PER_TURN, REPO_WRITE_TOOLS } from '@/lib/types'
import { GithubError } from '@/lib/github/app'
import {
  listFiles,
  openPullRequest,
  readFile,
  safeBranchName,
  searchCode,
} from '@/lib/github/repo'

/**
 * The bridge between Claude's tool calls and the GitHub layer.
 *
 * Authority never comes from the model. Which tools are offered, and whether a
 * write is executed when called, are both derived from `RepoToolContext` —
 * facts established by the server before the turn began. A prompt-injected
 * "open a PR" in a collaborator room fails here with a recorded denial, not in
 * the model's judgement.
 */

export interface RepoToolContext {
  connection: RepoConnection
  roomId: string
  /** The message that triggered this turn, for the action record. */
  messageId: string | null
  /** The verified user whose message triggered the turn. */
  actorId: string
  /** True only when the triggering actor is the room's Core Prompter. */
  actorIsCorePrompter: boolean
}

const LIST_TOOL: Anthropic.Tool = {
  name: 'repo_list_files',
  description:
    'List files in the connected GitHub repository. Call this to orient yourself before reading files. Use recursive=true to see the full tree (paths only), or a path to list one directory.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory to list. Omit for the repository root.' },
      recursive: {
        type: 'boolean',
        description: 'When true, return the full tree under path in one call.',
      },
    },
    additionalProperties: false,
  },
}

const READ_TOOL: Anthropic.Tool = {
  name: 'repo_read_file',
  description:
    'Read one file from the connected GitHub repository at the default branch. Call this whenever the conversation refers to code, configuration, or documentation in the repository — quote from the real file rather than guessing its contents.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path from the repository root.' },
    },
    required: ['path'],
    additionalProperties: false,
  },
}

const SEARCH_TOOL: Anthropic.Tool = {
  name: 'repo_search_code',
  description:
    'Search code in the connected GitHub repository. Use this to find where a symbol, string, or concept lives when you do not know the file path.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search terms. Plain text; qualifiers are not needed.' },
      limit: { type: 'integer', description: 'Maximum results, 1-30. Default 10.' },
    },
    required: ['query'],
    additionalProperties: false,
  },
}

const PR_TOOL: Anthropic.Tool = {
  name: 'repo_open_pull_request',
  description:
    'Create a branch with the given file changes and open a pull request against the default branch of the connected repository. Only available when the Core Prompter sent the current message and the room allows repository writes; otherwise propose the change as text instead. Each change replaces the whole file, so include the complete new contents.',
  input_schema: {
    type: 'object',
    properties: {
      branch: {
        type: 'string',
        description: 'New branch name, e.g. "claude/fix-login-copy". Must not already exist.',
      },
      title: { type: 'string', description: 'Pull request title, also used as the commit message.' },
      body: { type: 'string', description: 'Pull request description in Markdown.' },
      changes: {
        type: 'array',
        description: 'Files to write. Content is the complete new file; null deletes the file.',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            content: { type: ['string', 'null'] },
          },
          required: ['path', 'content'],
          additionalProperties: false,
        },
      },
    },
    required: ['branch', 'title', 'body', 'changes'],
    additionalProperties: false,
  },
}

/**
 * The tool set offered for a turn.
 *
 * The PR tool is only *offered* when this turn could legitimately use it. It
 * would also be blocked at execution, but not offering it keeps the model from
 * planning around a capability it does not have.
 */
export function repoToolsFor(
  accessMode: RepoAccessMode,
  actorIsCorePrompter: boolean,
): Anthropic.Tool[] {
  const tools = [LIST_TOOL, READ_TOOL, SEARCH_TOOL]
  if (accessMode === 'read_pr' && actorIsCorePrompter) {
    tools.push(PR_TOOL)
  }
  return tools
}

/** One line for the system prompt describing the connection and its limits. */
export function repoSystemNote(connection: RepoConnection, actorIsCorePrompter: boolean): string {
  const repoName = `${connection.owner}/${connection.repo}`
  const lines = [
    `This room is connected to the GitHub repository ${repoName} (default branch: ${connection.default_branch}). Use the repo_* tools to consult it whenever the conversation concerns its contents; prefer reading the actual files over recalling or guessing.`,
  ]
  if (connection.access_mode === 'read_pr' && actorIsCorePrompter) {
    lines.push(
      'You may open a pull request when the Core Prompter asks for a change. Never push to the default branch — every change goes through a pull request for human review.',
    )
  } else {
    lines.push(
      'Repository access is read-only in this turn. If a change is wanted, describe it — or provide the patch as text — so the Core Prompter can act on it.',
    )
  }
  return lines.join(' ')
}

interface ToolOutcome {
  /** Serialised result content handed back to the model. */
  content: string
  isError: boolean
  ok: boolean
  summary: string
  pullRequestUrl: string | null
  deniedWrite: boolean
}

async function persistAction(
  ctx: RepoToolContext,
  tool: RepoTool,
  args: Record<string, unknown>,
  outcome: ToolOutcome,
): Promise<void> {
  const admin = createAdminClient()

  // PR contents can be large; the action record keeps the shape of the call,
  // not the full payload. The pull request itself is the durable artifact.
  const compactArgs: Record<string, unknown> = { ...args }
  if (tool === 'repo_open_pull_request' && Array.isArray(compactArgs.changes)) {
    compactArgs.changes = (compactArgs.changes as Array<{ path?: unknown }>).map((change) => ({
      path: typeof change.path === 'string' ? change.path : '(invalid)',
    }))
  }

  const payload: Database['public']['Tables']['repo_actions']['Insert'] = {
    room_id: ctx.roomId,
    message_id: ctx.messageId,
    actor_id: ctx.actorId,
    tool,
    arguments: compactArgs as Json,
    ok: outcome.ok,
    summary: outcome.summary,
    pull_request_url: outcome.pullRequestUrl,
  }

  const { error } = await admin.from('repo_actions').insert(payload as never)
  if (error) {
    // Same posture as recordAudit: a failed action record must not fail the
    // turn, but it must not vanish silently either.
    console.error('[github] repo_actions insert failed', { message: error.message })
  }
}

function isRepoTool(name: string): name is RepoTool {
  return (
    name === 'repo_list_files' ||
    name === 'repo_read_file' ||
    name === 'repo_search_code' ||
    name === 'repo_open_pull_request'
  )
}

/**
 * Executes one tool call. Never throws: every failure becomes an is_error tool
 * result so the model can recover or explain, and every call — success, failure
 * or denial — lands in repo_actions.
 */
export async function executeRepoTool(
  ctx: RepoToolContext,
  name: string,
  input: unknown,
): Promise<{ content: string; isError: boolean; pullRequestUrl: string | null; deniedWrite: boolean }> {
  if (!isRepoTool(name)) {
    return {
      content: `Unknown tool "${name}".`,
      isError: true,
      pullRequestUrl: null,
      deniedWrite: false,
    }
  }

  const args =
    typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}

  const outcome = await runTool(ctx, name, args)
  await persistAction(ctx, name, args, outcome)

  if (name === 'repo_open_pull_request') {
    await recordAudit({
      roomId: ctx.roomId,
      actorId: ctx.actorId,
      action: outcome.deniedWrite
        ? 'repo.write_denied'
        : outcome.ok
          ? 'repo.pull_request_opened'
          : 'repo.tool_error',
      targetId: ctx.messageId,
      metadata: { summary: outcome.summary, url: outcome.pullRequestUrl },
    })
  }

  return {
    content: outcome.content,
    isError: outcome.isError,
    pullRequestUrl: outcome.pullRequestUrl,
    deniedWrite: outcome.deniedWrite,
  }
}

async function runTool(
  ctx: RepoToolContext,
  tool: RepoTool,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const target = {
    installationId: ctx.connection.installation_id,
    owner: ctx.connection.owner,
    repo: ctx.connection.repo,
  }

  /*
   * The write gate, re-checked at execution even though the tool may not have
   * been offered. Belt and braces: the offering logic and this check are in
   * different functions, and only one of them failing should never be enough
   * to let a collaborator-triggered turn write to the repository.
   */
  if (REPO_WRITE_TOOLS.includes(tool)) {
    if (ctx.connection.access_mode !== 'read_pr') {
      return deny('This room\'s repository connection is read-only.')
    }
    if (!ctx.actorIsCorePrompter) {
      return deny(
        'Only a turn initiated by the Core Prompter may open a pull request. Describe the proposed change instead.',
      )
    }
  }

  try {
    switch (tool) {
      case 'repo_list_files': {
        const path = typeof args.path === 'string' ? args.path : undefined
        const recursive = args.recursive === true
        const { entries, truncated } = await listFiles(target, { path, recursive })

        // 400 entries keeps a monorepo listing from swamping the turn's token
        // budget; the count line tells the model there is more.
        const shown = entries.slice(0, 400)
        const lines = shown.map((entry) =>
          entry.type === 'dir' ? `${entry.path}/` : `${entry.path}${entry.size !== null ? ` (${entry.size} B)` : ''}`,
        )
        const suffix =
          entries.length > shown.length || truncated
            ? `\n… ${entries.length - shown.length} more entries not shown. Narrow with a path.`
            : ''
        return okOutcome(
          lines.length > 0 ? lines.join('\n') + suffix : '(empty directory)',
          `Listed ${shown.length} entries${path ? ` under ${path}` : ''}`,
        )
      }

      case 'repo_read_file': {
        const path = typeof args.path === 'string' ? args.path : ''
        const file = await readFile(target, { path })
        const header = `// ${file.path} (${file.size} B${file.truncated ? ', truncated' : ''})\n`
        return okOutcome(header + file.content, `Read ${file.path}`)
      }

      case 'repo_search_code': {
        const query = typeof args.query === 'string' ? args.query : ''
        const limit = typeof args.limit === 'number' ? args.limit : undefined
        const hits = await searchCode(target, { query, limit })
        if (hits.length === 0) {
          return okOutcome('No matches.', `Searched "${query}": no matches`)
        }
        const rendered = hits
          .map((hit) =>
            [`## ${hit.path}`, ...hit.fragments.map((fragment) => '```\n' + fragment + '\n```')].join('\n'),
          )
          .join('\n\n')
        return okOutcome(rendered, `Searched "${query}": ${hits.length} files matched`)
      }

      case 'repo_open_pull_request': {
        const branch = typeof args.branch === 'string' ? safeBranchName(args.branch) : ''
        const title = typeof args.title === 'string' ? args.title.trim() : ''
        const body = typeof args.body === 'string' ? args.body : ''
        const rawChanges = Array.isArray(args.changes) ? args.changes : []

        if (!branch || !title) {
          return errorOutcome('A branch name and a title are required.')
        }

        const changes = rawChanges.map((change) => {
          const record =
            typeof change === 'object' && change !== null
              ? (change as { path?: unknown; content?: unknown })
              : {}
          return {
            path: typeof record.path === 'string' ? record.path : '',
            content:
              record.content === null ? null : typeof record.content === 'string' ? record.content : '',
          }
        })

        const result = await openPullRequest(target, {
          baseBranch: ctx.connection.default_branch,
          headBranch: branch,
          title,
          body:
            body +
            `\n\n---\n_Opened from the collaborative room by Claude at the Core Prompter's request._`,
          changes,
        })

        return {
          content: `Opened pull request #${result.number}: ${result.url}\nBranch: ${result.branch}\nFiles: ${result.changedFiles.join(', ')}`,
          isError: false,
          ok: true,
          summary: `Opened PR #${result.number} (${result.changedFiles.length} files)`,
          pullRequestUrl: result.url,
          deniedWrite: false,
        }
      }
    }
  } catch (error) {
    const message =
      error instanceof GithubError ? error.message : 'The repository request failed unexpectedly.'
    if (!(error instanceof GithubError)) {
      console.error('[github] unexpected tool failure', error)
    }
    return errorOutcome(message)
  }
}

function okOutcome(content: string, summary: string): ToolOutcome {
  return { content, isError: false, ok: true, summary, pullRequestUrl: null, deniedWrite: false }
}

function errorOutcome(message: string): ToolOutcome {
  return {
    content: message,
    isError: true,
    ok: false,
    summary: message.slice(0, 200),
    pullRequestUrl: null,
    deniedWrite: false,
  }
}

function deny(message: string): ToolOutcome {
  return {
    content: message,
    isError: true,
    ok: false,
    summary: `Write denied: ${message.slice(0, 160)}`,
    pullRequestUrl: null,
    deniedWrite: true,
  }
}

export { MAX_REPO_TOOL_CALLS_PER_TURN }
