import type { Contact, ContactOption } from "./contacts.ts";

export type CommandRequest = {
  command_id: string;
  transcript: string;
  now: string;
  timezone: string;
  contacts?: Contact[];
  selected_contact_id?: string;
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
export type CommandAction = ReminderAction | DraftAction;
export type CommandResponse =
  | { kind: "actions"; actions: CommandAction[] }
  | { kind: "clarification"; question: string; options: ContactOption[] };

export class RequestError extends Error {
  readonly retryAt: number;
  constructor(message: string, retryAt = 0) {
    super(message);
    this.name = "RequestError";
    this.retryAt = retryAt;
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
        : "Morning couldn't reach the server. Please retry.";
    const retryAfter =
      response.status === 429 ? Number(response.headers.get("Retry-After")) : 0;
    throw new RequestError(
      message,
      retryAfter > 0 && Number.isFinite(retryAfter)
        ? Date.now() + retryAfter * 1000
        : 0,
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
  return { kind: "actions", actions };
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

export async function interpretCommand(
  request: CommandRequest,
  signal: AbortSignal,
) {
  return parseCommandResponse(
    await postJSON("/api/commands", request, signal),
    request,
  );
}
