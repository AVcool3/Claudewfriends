/**
 * Input normalisation and prompt-injection heuristics.
 *
 * This module is deliberately free of I/O so it can run on the server before a
 * write and (for the length check) in the browser to give instant feedback.
 * Nothing here is an enforcement boundary on its own — see the note above
 * `detectPromptInjection`.
 */

import { MAX_MESSAGE_LENGTH, validationFailure, validationSuccess } from '@/lib/types'
import type { ValidationResult } from '@/lib/types'

/**
 * The markers that frame untrusted collaborator text inside the Claude prompt.
 * `prompt.ts` imports these rather than re-declaring the literals, because a
 * drift between the marker the prompt writes and the marker this file escapes
 * would silently re-open the injection hole `neutraliseDelimiters` closes.
 */
export const CONTRIBUTION_OPEN = '<<<PARTICIPANT_MESSAGE>>>'
export const CONTRIBUTION_CLOSE = '<<</PARTICIPANT_MESSAGE>>>'

/** score >= 0.7 is treated as suspicious and audited; it never silently blocks. */
export const INJECTION_SUSPICION_THRESHOLD = 0.7

/**
 * Zero-width and bidirectional-control code points.
 *
 * These render as nothing (or reorder visible text) but survive a copy/paste,
 * so they are the standard vehicle for hiding an instruction inside text that
 * looks innocuous to a human reviewer — including the Core Prompter reviewing a
 * pending contribution. Stripping them means what the approver sees is what
 * Claude receives.
 */
const INVISIBLE_CHARS = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g

/**
 * C0/C1 control characters other than tab and newline. They cannot be stored
 * meaningfully and some terminals/log viewers act on them.
 */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g

/** A high or low surrogate that is not part of a valid pair. */
const LONE_SURROGATES = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

export function normaliseMessage(raw: string): string {
  // Line endings first so the blank-line collapse below only has to reason
  // about "\n".
  let text = raw.replace(/\r\n?/g, '\n')

  // Lone surrogates are dropped before `normalize()` and before any database
  // write: Postgres rejects them as invalid UTF-8, so leaving them in turns a
  // user typo into a 500.
  text = text.replace(LONE_SURROGATES, '')

  // NFC so that visually identical strings compare equal — matters for the
  // marker/pattern matching below, where a decomposed form would slip past a
  // literal comparison.
  text = text.normalize('NFC')

  text = text.replace(INVISIBLE_CHARS, '')
  text = text.replace(CONTROL_CHARS, '')

  // Whitespace-only lines become truly empty so the run collapse sees them.
  text = text.replace(/^[ \t]+$/gm, '')

  // Cap paragraph breaks at one blank line; more than two consecutive newlines
  // is padding used to push earlier context out of a reviewer's viewport.
  text = text.replace(/\n{3,}/g, '\n\n')

  return text.trim()
}

export function assertMessageLength(text: string): ValidationResult<string> {
  // Count code points, not UTF-16 units, so an emoji costs the same as a letter
  // and the number matches Postgres' `char_length()` in the schema constraint.
  const length = Array.from(text).length

  if (length === 0) {
    return validationFailure('message.empty', 'A message cannot be empty.', 400)
  }
  if (length > MAX_MESSAGE_LENGTH) {
    return validationFailure(
      'message.too_long',
      `Messages are limited to ${MAX_MESSAGE_LENGTH} characters. Yours is ${length}.`,
      400,
    )
  }
  return validationSuccess(text)
}

/**
 * Matches either framing marker, tolerating the obvious evasions: extra angle
 * brackets, whitespace inside the marker, and case changes. Anything that would
 * be *read* as a closing marker by a model has to be caught here, not just the
 * exact literal.
 */
const DELIMITER_PATTERN = /<{2,}\s*\/?\s*PARTICIPANT_MESSAGE\s*>{2,}/gi

/** Escapes the delimiters we use to frame untrusted text in the Claude prompt. */
export function neutraliseDelimiters(text: string): string {
  // Escaped rather than deleted: the collaborator still sees their words in the
  // transcript, but the angle brackets can no longer terminate the frame and
  // let the following text be read as prompt structure.
  return text.replace(DELIMITER_PATTERN, (match) =>
    match.replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  )
}

export interface InjectionFinding {
  pattern: string
  excerpt: string
  score: number
}

interface InjectionRule {
  id: string
  regex: RegExp
  score: number
}

/**
 * Weights are calibrated so that one strong signal (0.7) trips the threshold on
 * its own, while two moderate signals (0.45) also do. Phrases that occur in
 * legitimate conversation about prompting are scored low deliberately.
 */
const INJECTION_RULES: InjectionRule[] = [
  { id: 'ignore_previous_instructions', regex: /ignore\s+(?:all\s+)?(?:the\s+)?previous\s+instructions?/i, score: 0.7 },
  { id: 'disregard_the_above', regex: /disregard\s+(?:the\s+)?(?:above|everything|prior|preceding)/i, score: 0.6 },
  { id: 'you_are_now', regex: /\byou\s+are\s+now\b/i, score: 0.35 },
  { id: 'new_system_prompt', regex: /\bnew\s+system\s+prompt\b/i, score: 0.7 },
  { id: 'system_turn_prefix', regex: /^\s*system\s*:/im, score: 0.5 },
  { id: 'system_tag', regex: /<\/?\s*system\s*>/i, score: 0.7 },
  { id: 'act_as_core_prompter', regex: /\bact\s+as\s+(?:the\s+)?core\s+prompter\b/i, score: 0.7 },
  { id: 'reveal_prompt', regex: /\b(?:reveal|show|print|repeat|output)\s+(?:me\s+)?(?:your|the)\s+(?:system\s+)?prompt\b/i, score: 0.7 },
  { id: 'developer_mode', regex: /\bdeveloper\s+mode\b/i, score: 0.5 },
  // Impersonating another participant. The framed contribution names its sender,
  // so text that reports what someone *else* said is forging a turn — scored
  // high on its own.
  { id: 'participant_impersonation', regex: /\b(?:core\s+prompter|the\s+administrator|the\s+owner|claude|the\s+assistant)\s+(?:says|said|instructed|told\s+you)\s*:/i, score: 0.7 },
  // The weaker form: a bare speaker label at the start of a line. Common in
  // pasted transcripts, so it only contributes.
  { id: 'speaker_label', regex: /^\s*(?:core\s+prompter|administrator|assistant|claude|human|user)\s*:/im, score: 0.4 },
  { id: 'instruction_section', regex: /^\s*(?:instruction|instructions|directive)\s*:/im, score: 0.45 },
]

/** A base64-looking blob long enough to hide a full instruction set. */
const BASE64_BLOB = /[A-Za-z0-9+/]{200,}={0,2}/

function excerptAround(text: string, index: number, matchLength: number): string {
  const start = Math.max(0, index - 24)
  const end = Math.min(text.length, index + matchLength + 24)
  const slice = text.slice(start, end).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${slice}${end < text.length ? '…' : ''}`
}

/**
 * Scored heuristic for prompt-injection attempts.
 *
 * DEFENCE IN DEPTH ONLY. The real protection is structural: collaborator text
 * is always wrapped in the `CONTRIBUTION_OPEN`/`CONTRIBUTION_CLOSE` frame (with
 * those markers escaped out of the payload) and the system prompt states that
 * framed content is data describing what a participant said, never an
 * instruction to follow. This function exists so an operator can *see* an
 * attempt in the audit log — pattern matching on natural language cannot be
 * made complete, and treating it as a gate would block legitimate discussion
 * about prompting while still missing paraphrases.
 */
export function detectPromptInjection(text: string): { score: number; findings: InjectionFinding[] } {
  const findings: InjectionFinding[] = []

  for (const rule of INJECTION_RULES) {
    const match = rule.regex.exec(text)
    if (!match) continue
    findings.push({
      pattern: rule.id,
      excerpt: excerptAround(text, match.index, match[0].length),
      score: rule.score,
    })
  }

  const blob = BASE64_BLOB.exec(text)
  if (blob) {
    findings.push({
      pattern: 'base64_blob',
      // Only the head of the blob — the point is that it exists, and the full
      // payload is already stored on the message row.
      excerpt: `${blob[0].slice(0, 48)}… (${blob[0].length} chars)`,
      score: 0.5,
    })
  }

  // Combine as independent probabilities rather than summing, so a message with
  // five weak signals cannot outrank one unambiguous "ignore previous
  // instructions", and the total stays inside 0..1 without a hard clamp.
  const combined = findings.reduce((acc, finding) => acc + (1 - acc) * finding.score, 0)

  return { score: Math.round(combined * 1000) / 1000, findings }
}
