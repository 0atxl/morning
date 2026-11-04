export type SpeechLanguage = "en" | "hi";

export function speechLanguage(text: string): SpeechLanguage {
  return /\p{Script=Devanagari}/u.test(text) ? "hi" : "en";
}

export function validSpeechLanguage(
  value: unknown,
): value is SpeechLanguage | undefined {
  return value === undefined || value === "en" || value === "hi";
}

// Picker behavior must also recognize the controlled Hindi follow-up wording.
export function clarificationTarget(
  question: string,
): "reminder" | "draft" | "contact" | null {
  if (
    /(?:which|what)\b.*\b(?:reminder|task)|कौन\s*सा.*रिमाइंडर|किस\s*रिमाइंडर|kaun\s*sa.*reminder/i.test(
      question,
    )
  )
    return "reminder";
  if (
    /(?:which|what)\b.*\b(?:draft|email|message)|कौन\s*सा.*(?:ड्राफ्ट|ईमेल)|किस\s*(?:ड्राफ्ट|ईमेल)|kaun\s*sa.*(?:draft|email)/i.test(
      question,
    )
  )
    return "draft";
  if (/contact|address|recipient|संपर्क|पता/i.test(question)) return "contact";
  return null;
}
