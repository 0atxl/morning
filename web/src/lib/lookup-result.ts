import { object, RequestError } from "./command-api.ts";
import { validSpeechLanguage, type SpeechLanguage } from "./language.ts";

export type LookupQuery = {
  kind: "hotels" | "weather" | "news" | "web" | "time" | "wiki" | "briefing";
  terms: string;
  place: string;
  today: boolean;
};

export type LookupSource = {
  title: string;
  url: string;
  publisher: string;
  excerpt?: string;
  published_at?: string;
};

export type LookupContext = {
  query: LookupQuery;
  city?: string;
  reply_language?: SpeechLanguage;
};

export function parseLookupContext(data: unknown): LookupContext {
  const value = object(data);
  const query = object(value?.query);
  if (
    !value ||
    !onlyKeys(value, ["query", "city", "reply_language"]) ||
    !validSpeechLanguage(value.reply_language) ||
    !query ||
    !onlyKeys(query, ["kind", "terms", "place", "today"]) ||
    typeof query.kind !== "string" ||
    !["hotels", "weather", "time", "briefing"].includes(query.kind) ||
    query.terms !== "" ||
    query.today !== (query.kind === "briefing") ||
    (query.place !== "" && !text(query.place, 120)) ||
    (value.city !== undefined && !text(value.city, 100))
  )
    invalid();
  return {
    query: {
      kind: query.kind as LookupQuery["kind"],
      terms: "",
      place: query.place as string,
      today: query.today as boolean,
    },
    ...(value.city === undefined ? {} : { city: value.city as string }),
    ...(value.reply_language === undefined
      ? {}
      : { reply_language: value.reply_language }),
  };
}

// Progress copy only. Go/Groq still own intent classification and validation.
export function lookupProgress(transcript: string, context?: LookupContext) {
  return (
    continuesLookupContext(transcript, context) ||
    /\b(?:weather|hotels?|headlines?|news|search|look\s+up|wiki|wikipedia|briefing|morning\s+briefing|who\s+(?:was|is)|tell\s+me\s+about|summar(?:y|ize)|mausam|khabar|samachar|dhoondho)\b|ब्रीफिंग|मौसम|होटल|खबर|समाचार|कितने बजे|जानकारी|के\s+बारे\s+में|\b(?:latest|stable)\b.*\b(?:release|version)\b|\bwhat(?:'s|\s+is)?\s+(?:the\s+)?time\b/i.test(
      transcript,
    )
  );
}

export function continuesLookupContext(
  transcript: string,
  context?: LookupContext,
): boolean {
  if (!context) return false;
  if (
    /^\s*(?:(?:please|actually|can you|could you|no|maybe)[,.\s]+)*(?:remind\s+me\b|(?:set|create|add|schedule|book)\b|(?:draft|write|compose)\b|(?:make|move|change|reschedule|update|edit|shorten|expand|revise|rewrite)\s+(?:it|that|the|my)\b)/i.test(
      transcript,
    ) ||
    /^\s*(?:hi|hello|hey|good\s+(?:morning|afternoon|evening)|thanks|thank\s+you|cancel|never\s*mind|stop|what\s+can\s+you\s+do|help\b|नमस्ते|हैलो|धन्यवाद|रद्द\s+करो|क्या\s+कर\s+सकते)/i.test(
      transcript,
    ) ||
    /याद\s+दिला|yaad\s+dila|रिमाइंडर|(?:ईमेल|ड्राफ्ट)\s*(?:लिख|बना|बदल)|(?:उसे|उसको|इसे|इसको)\s+.+\s+कर\s*(?:दो|दें)/i.test(
      transcript,
    )
  ) {
    return false;
  }
  const wantsWeather =
    /\b(?:weather|temperature|forecast|mausam)\b|मौसम|तापमान/i.test(transcript);
  const wantsTime =
    /\bwhat(?:'s|\s+is)?\s+(?:the\s+)?(?:local\s+)?time\b|\bcurrent\s+time\b|कितने\s+बजे|क्या\s+समय|\bkitne\s+baje\b/i.test(
      transcript,
    );
  const wantsHotels = /\bhotels?\b|होटल/i.test(transcript);
  const wantsNews =
    /\b(?:headlines?|news|khabar|samachar)\b|खबर|समाचार/i.test(transcript);
  const wantsWeb =
    /\b(?:latest|stable)\b.*\b(?:release|version)\b|\b(?:search\s+for|look\s+up)\b/i.test(
      transcript,
    );
  if (
    wantsNews ||
    wantsWeb ||
    (wantsWeather && context.query.kind !== "weather") ||
    (wantsTime && context.query.kind !== "time") ||
    (wantsHotels && context.query.kind !== "hotels")
  ) {
    return false;
  }
  return true;
}

// Store the entire snapshot in its originating conversation. History and Play
// reply read it locally. Only an explicit retry submits another lookup.
export type LookupResult = {
  kind: LookupQuery["kind"];
  query: string;
  status: "answered" | "empty";
  answer: string;
  speech: string;
  sources: LookupSource[];
  looked_up_at: string;
  timezone?: string;
  data_time?: string;
  window_start?: string;
  window_end?: string;
  reply_language?: SpeechLanguage;
};

function text(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    [...value].length <= max &&
    !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)
  );
}

function timestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(
      value,
    ) &&
    Number.isFinite(Date.parse(value))
  );
}

export function safeLookupLink(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    value !== value.trim() ||
    !/^https?:\/\//.test(value) ||
    /[\\\u0000-\u0020\u007f]/u.test(value)
  )
    return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (
      url.username ||
      url.password ||
      !host ||
      host === "localhost" ||
      host.endsWith(".localhost") ||
      !host.includes(".") ||
      host.startsWith("[") ||
      /^\d+(?:\.\d+){3}$/.test(host)
    )
      return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function invalid(): never {
  throw new RequestError(
    "Morning returned an invalid lookup. Your words are still available to retry.",
  );
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).every((key) => keys.includes(key));
}

export function parseLookupResult(data: unknown): LookupResult {
  const value = object(data);
  if (
    !value ||
    !onlyKeys(value, [
      "kind",
      "query",
      "status",
      "answer",
      "speech",
      "sources",
      "looked_up_at",
      "timezone",
      "data_time",
      "window_start",
      "window_end",
      "reply_language",
    ]) ||
    !validSpeechLanguage(value.reply_language) ||
    typeof value.kind !== "string" ||
    !["hotels", "weather", "news", "web", "time", "wiki", "briefing"].includes(
      value.kind,
    ) ||
    typeof value.status !== "string" ||
    !["answered", "empty"].includes(value.status) ||
    !text(value.query, 430) ||
    typeof value.answer !== "string" ||
    !(["wiki", "briefing"].includes(value.kind)
      ? text(value.answer.replace(/\n/g, " "), 2000)
      : text(value.answer, 2000)) ||
    !text(value.speech, 240) ||
    !timestamp(value.looked_up_at) ||
    !Array.isArray(value.sources) ||
    value.sources.length > 3 ||
    (value.status === "answered"
      ? value.sources.length === 0
      : value.sources.length !== 0)
  )
    invalid();

  const sources = value.sources.map((item): LookupSource => {
    const source = object(item);
    if (
      !source ||
      !onlyKeys(source, [
        "title",
        "url",
        "publisher",
        "excerpt",
        "published_at",
      ]) ||
      !text(source.title, 200) ||
      !text(source.publisher, 253) ||
      (source.excerpt !== undefined && !text(source.excerpt, 1800)) ||
      (source.published_at !== undefined && !timestamp(source.published_at))
    )
      invalid();
    const url = safeLookupLink(source.url);
    if (!url) invalid();
    return {
      title: source.title,
      url,
      publisher: source.publisher,
      ...(source.excerpt === undefined
        ? {}
        : { excerpt: source.excerpt as string }),
      ...(source.published_at === undefined
        ? {}
        : { published_at: source.published_at as string }),
    };
  });

  for (const key of ["data_time", "window_start", "window_end"] as const) {
    if (value[key] !== undefined && !timestamp(value[key])) invalid();
  }
  if (value.timezone !== undefined) {
    if (!text(value.timezone, 100) || value.timezone === "Local") invalid();
    try {
      new Intl.DateTimeFormat("en", { timeZone: value.timezone });
    } catch {
      invalid();
    }
  }
  if (
    (value.kind === "weather" ||
      value.kind === "time" ||
      value.kind === "briefing") &&
    value.status === "answered" &&
    (value.data_time === undefined || value.timezone === undefined)
  )
    invalid();
  if (value.kind === "news") {
    if (
      !timestamp(value.window_start) ||
      !timestamp(value.window_end) ||
      !text(value.timezone, 100)
    )
      invalid();
    const start = Date.parse(value.window_start),
      end = Date.parse(value.window_end);
    if (
      start > end ||
      sources.some(
        (source) =>
          !source.published_at ||
          Date.parse(source.published_at) < start ||
          Date.parse(source.published_at) > end,
      )
    )
      invalid();
  }
  return {
    kind: value.kind as LookupResult["kind"],
    query: value.query,
    status: value.status as LookupResult["status"],
    answer: value.answer,
    speech: value.speech,
    sources,
    ...(value.reply_language === undefined
      ? {}
      : { reply_language: value.reply_language }),
    looked_up_at: value.looked_up_at,
    ...(value.timezone === undefined
      ? {}
      : { timezone: value.timezone as string }),
    ...(value.data_time === undefined
      ? {}
      : { data_time: value.data_time as string }),
    ...(value.window_start === undefined
      ? {}
      : { window_start: value.window_start as string }),
    ...(value.window_end === undefined
      ? {}
      : { window_end: value.window_end as string }),
  };
}
