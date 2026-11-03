import type { Contact, ContactOption } from "./contacts.ts";
import { validSpeechLanguage, type SpeechLanguage } from "./language.ts";
import {
  parseLookupContext,
  parseLookupResult,
  type LookupContext,
  type LookupResult,
} from "./lookup-result.ts";

export type CommandRequest = {
  command_id: string;
  transcript: string;
  now: string;
  timezone: string;
  contacts?: Contact[];
  selected_contact_id?: string;
  reminder_context?: { id: string; due_at: string };
  selected_reminder_id?: string;
  draft_context?: {
    id: string;
    subject: string;
    body: string;
    recipient: string;
    to: string;
  };
  selected_draft_id?: string;
  lookup_context?: LookupContext;
};

export type ReminderAction = {
  type: "create_reminder";
  title: string;
  due_at: string;
};

export type DraftAction = {
  type: "draft_email";
  to_contact_id: string;
  subject: string;
  body: string;
};
export type RescheduleAction = {
  type: "reschedule_reminder";
  reminder_id: string;
  due_at: string;
};
export type UpdateDraftAction = {
  type: "update_draft";
  draft_id: string;
  subject: string;
  body: string;
};
export type CommandAction =
  ReminderAction | DraftAction | RescheduleAction | UpdateDraftAction;
export type CommandResponse = (
  | { kind: "actions"; actions: CommandAction[] }
  | { kind: "reply"; text: string }
  | { kind: "lookup"; result: LookupResult }
  | {
      kind: "clarification";
      question: string;
      options: ContactOption[];
      lookupContext?: LookupContext;
    }
) & { replyLanguage?: SpeechLanguage };

export class RequestError extends Error {
  readonly retryAt: number;
  readonly lookupOnly: boolean;
  constructor(message: string, retryAt = 0, lookupOnly = false) {
    super(message);
    this.name = "RequestError";
    this.retryAt = retryAt;
    this.lookupOnly = lookupOnly;
  }
}

export function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function postJSON(
  path: string,
  body: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]),
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = object(object(data)?.error);
    const message =
      typeof error?.message === "string"
        ? error.message
        : response.status === 429
          ? "Morning's request limit was reached. Please wait, then retry."
          : response.status === 504
            ? "Morning's server timed out (HTTP 504). Your transcript is still available. Please retry."
            : `Morning's server returned HTTP ${response.status}. Your transcript is still available. Please retry.`;
    const retryAfter =
      response.status === 429
        ? Number(response.headers.get("Retry-After")) || 60
        : 0;
    throw new RequestError(
      message,
      retryAfter > 0 && Number.isFinite(retryAfter)
        ? Date.now() + retryAfter * 1000
        : 0,
      typeof error?.code === "string" &&
        (error.code.startsWith("lookup_") ||
          error.code === "search_not_configured"),
    );
  }
  if (!object(data))
    throw new RequestError(
      "Morning received an invalid server response. Please retry.",
    );
  return data;
}

export async function voiceToken(signal: AbortSignal) {
  const data = object(await postJSON("/api/voice/token", {}, signal))!;
  if (
    typeof data.access_token !== "string" ||
    !data.access_token.trim() ||
    typeof data.websocket_url !== "string" ||
    typeof data.expires_in !== "number" ||
    data.expires_in <= 0
  ) {
    throw new RequestError(
      "Morning couldn't get a valid voice token. Please retry.",
    );
  }
  // Never send the temporary bearer token to an arbitrary returned host or URL query.
  const url = new URL(data.websocket_url);
  if (
    url.protocol !== "wss:" ||
    url.hostname !== "api.deepgram.com" ||
    url.port ||
    url.pathname !== "/v1/listen" ||
    url.username ||
    url.password ||
    url.searchParams.get("model") !== "nova-3" ||
    url.searchParams.get("language") !== "multi" ||
    url.searchParams.getAll("language_hint").length !== 2 ||
    !["en", "hi"].every((language) =>
      url.searchParams.getAll("language_hint").includes(language),
    ) ||
    url.searchParams.get("interim_results") !== "true" ||
    [...url.searchParams.keys()].some((key) =>
      /token|key|authorization/i.test(key),
    )
  ) {
    throw new RequestError(
      "Morning received an unsupported voice connection. Please retry.",
    );
  }
  return { token: data.access_token, url: url.toString() };
}

export function parseCommandResponse(
  data: unknown,
  request: CommandRequest,
): CommandResponse {
  const value = object(data);
  if (
    !value ||
    value.command_id !== request.command_id ||
    !Array.isArray(value.actions)
  ) {
    throw new RequestError(
      "Morning returned a mismatched command response. Please retry.",
    );
  }
  if (!validSpeechLanguage(value.reply_language))
    throw new RequestError(
      "Morning returned an invalid reply language. Please retry.",
    );
  const language =
    value.reply_language === "hi" ? { replyLanguage: "hi" as const } : {};
  if (value.lookup !== undefined || value.lookup_context !== undefined) {
    if (
      value.actions.length !== 0 ||
      value.reply !== undefined ||
      value.clarification_options !== undefined ||
      Object.keys(value).some(
        (key) =>
          ![
            "command_id",
            "actions",
            "clarification",
            "lookup",
            "lookup_context",
            "reply_language",
          ].includes(key),
      )
    )
      throw new RequestError(
        "Morning returned a mixed lookup and action. Please retry.",
      );
    if (value.lookup !== undefined) {
      if (value.lookup_context !== undefined || value.clarification !== null)
        throw new RequestError(
          "Morning returned an incomplete lookup. Please retry.",
        );
      const result = parseLookupResult(value.lookup);
      if (value.reply_language === "hi") result.reply_language = "hi";
      if (
        request.lookup_context &&
        result.kind !== request.lookup_context.query.kind
      )
        throw new RequestError(
          "Morning returned a different lookup. Please retry.",
        );
      return { kind: "lookup", result, ...language };
    }
    if (
      typeof value.clarification !== "string" ||
      !value.clarification.trim() ||
      [...value.clarification].length > 240
    )
      throw new RequestError(
        "Morning returned an invalid place question. Please retry.",
      );
    const lookupContext = parseLookupContext(value.lookup_context);
    if (
      request.lookup_context &&
      lookupContext.query.kind !== request.lookup_context.query.kind
    )
      throw new RequestError(
        "Morning returned a different pending lookup. Please retry.",
      );
    return {
      kind: "clarification",
      question: value.clarification.trim(),
      options: [],
      lookupContext,
      ...language,
    };
  }
  if (request.lookup_context)
    throw new RequestError(
      "Morning did not finish the pending lookup. No action was saved.",
    );
  if (
    value.actions.length === 0 &&
    value.clarification === null &&
    value.clarification_options === undefined &&
    typeof value.reply === "string" &&
    value.reply.trim() &&
    [...value.reply].length <= 240
  )
    return { kind: "reply", text: value.reply.trim(), ...language };
  if (value.reply !== undefined)
    throw new RequestError(
      "Morning returned a mixed reply and action. Nothing was saved. Please retry.",
    );
  if (
    value.actions.length === 0 &&
    typeof value.clarification === "string" &&
    value.clarification.trim()
  ) {
    const options: ContactOption[] = [];
    if (value.clarification_options !== undefined) {
      if (
        !Array.isArray(value.clarification_options) ||
        value.clarification_options.length > 20
      )
        throw new RequestError(
          "Morning returned invalid contact choices. Please retry.",
        );
      for (const item of value.clarification_options) {
        const option = object(item);
        const contact = request.contacts?.find(
          (candidate) => candidate.id === option?.contact_id,
        );
        if (
          !contact ||
          option?.name !== contact.name ||
          option.email !== contact.email ||
          options.some((entry) => entry.contact_id === contact.id)
        )
          throw new RequestError(
            "Morning returned a contact outside this command's address book. Please retry.",
          );
        options.push({
          contact_id: contact.id,
          name: contact.name,
          email: contact.email,
        });
      }
    }
    return {
      kind: "clarification",
      question: value.clarification.trim(),
      options,
      ...language,
    };
  }
  if (
    value.actions.length < 1 ||
    value.actions.length > 2 ||
    value.clarification !== null ||
    value.clarification_options !== undefined
  ) {
    throw new RequestError(
      "Morning returned an incomplete command. Nothing was saved. Please retry.",
    );
  }
  const actions: CommandAction[] = [];
  for (const item of value.actions) {
    const action = object(item);
    if (!action || actions.some((entry) => entry.type === action.type))
      throw new RequestError(
        "Morning returned duplicate or invalid actions. Nothing was saved. Please retry.",
      );
    if (action.type === "create_reminder") {
      if (
        Object.keys(action).some(
          (key) => !["type", "title", "due_at"].includes(key),
        ) ||
        typeof action.title !== "string" ||
        !action.title.trim() ||
        [...action.title].length > 200 ||
        typeof action.due_at !== "string" ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?[+-]\d\d:\d\d$/.test(
          action.due_at,
        ) ||
        !Number.isFinite(Date.parse(action.due_at)) ||
        Date.parse(action.due_at) <= Date.parse(request.now)
      ) {
        throw new RequestError(
          "Morning returned an invalid reminder. Nothing was saved. Please retry.",
        );
      }
      actions.push({
        type: "create_reminder",
        title: action.title.trim(),
        due_at: action.due_at,
      });
    } else if (action.type === "reschedule_reminder") {
      if (
        value.actions.length !== 1 ||
        !request.reminder_context ||
        action.reminder_id !== request.reminder_context.id ||
        (request.selected_reminder_id &&
          action.reminder_id !== request.selected_reminder_id) ||
        Object.keys(action).some(
          (key) => !["type", "reminder_id", "due_at"].includes(key),
        ) ||
        typeof action.due_at !== "string" ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?[+-]\d\d:\d\d$/.test(
          action.due_at,
        ) ||
        !Number.isFinite(Date.parse(action.due_at)) ||
        Date.parse(action.due_at) <= Date.parse(request.now)
      )
        throw new RequestError(
          "Morning returned an invalid reminder update. Nothing was changed. Please retry.",
        );
      actions.push({
        type: "reschedule_reminder",
        reminder_id: request.reminder_context.id,
        due_at: action.due_at,
      });
    } else if (action.type === "update_draft") {
      if (
        value.actions.length !== 1 ||
        !request.draft_context ||
        action.draft_id !== request.draft_context.id ||
        (request.selected_draft_id &&
          action.draft_id !== request.selected_draft_id) ||
        Object.keys(action).some(
          (key) => !["type", "draft_id", "subject", "body"].includes(key),
        ) ||
        typeof action.subject !== "string" ||
        !action.subject.trim() ||
        [...action.subject].length > 200 ||
        typeof action.body !== "string" ||
        !action.body.trim() ||
        [...action.body].length > 8000
      )
        throw new RequestError(
          "Morning returned an invalid draft update. Nothing was changed. Please retry.",
        );
      actions.push({
        type: "update_draft",
        draft_id: request.draft_context.id,
        subject: action.subject,
        body: action.body,
      });
    } else if (action.type === "draft_email") {
      const recipient = request.contacts?.find(
        (contact) => contact.id === action.to_contact_id,
      );
      if (
        Object.keys(action).some(
          (key) => !["type", "to_contact_id", "subject", "body"].includes(key),
        ) ||
        !recipient ||
        (request.selected_contact_id &&
          recipient.id !== request.selected_contact_id) ||
        typeof action.subject !== "string" ||
        !action.subject.trim() ||
        [...action.subject].length > 200 ||
        typeof action.body !== "string" ||
        !action.body.trim() ||
        [...action.body].length > 8000
      ) {
        throw new RequestError(
          "Morning returned an invalid email draft. Nothing was saved. Please retry.",
        );
      }
      actions.push({
        type: "draft_email",
        to_contact_id: recipient.id,
        subject: action.subject,
        body: action.body,
      });
    } else
      throw new RequestError(
        "Morning returned an unsupported action. Nothing was saved. Please retry.",
      );
  }
  if (
    request.selected_contact_id &&
    !actions.some((action) => action.type === "draft_email")
  )
    throw new RequestError(
      "The selected contact's draft is missing. Nothing was saved. Please retry.",
    );
  if (
    (request.selected_reminder_id &&
      !actions.some((action) => action.type === "reschedule_reminder")) ||
    (request.selected_draft_id &&
      !actions.some((action) => action.type === "update_draft"))
  )
    throw new RequestError(
      "Morning didn't update the selected item. Nothing was changed. Please retry.",
    );
  return { kind: "actions", actions, ...language };
}

export function withSelectedContact(
  request: CommandRequest,
  options: readonly ContactOption[],
  contactId: string,
): CommandRequest {
  if (
    !options.some((option) => option.contact_id === contactId) ||
    !request.contacts?.some((contact) => contact.id === contactId)
  )
    throw new RequestError("Choose one of the offered contacts.");
  return {
    ...request,
    contacts: request.contacts.map((contact) => ({ ...contact })),
    selected_contact_id: contactId,
  };
}

export function withSelectedReminder(
  request: CommandRequest,
  options: readonly { id: string; dueAt: string }[],
  id: string,
): CommandRequest {
  const reminder = options.find((option) => option.id === id);
  if (!reminder) throw new RequestError("Choose one of the offered reminders.");
  return {
    ...request,
    reminder_context: { id: reminder.id, due_at: reminder.dueAt },
    selected_reminder_id: reminder.id,
  };
}

export function withSelectedDraft(
  request: CommandRequest,
  options: readonly {
    id: string;
    subject: string;
    body: string;
    recipient: string;
    to: string;
  }[],
  id: string,
): CommandRequest {
  const draft = options.find((option) => option.id === id);
  if (!draft) throw new RequestError("Choose one of the offered drafts.");
  const { subject, body, recipient, to } = draft;
  return {
    ...request,
    draft_context: { id, subject, body, recipient, to },
    selected_draft_id: id,
  };
}

export async function interpretCommand(
  request: CommandRequest,
  signal: AbortSignal,
) {
  return parseCommandResponse(
    await postJSON("/api/commands", request, signal),
    request,
  );
}
