import { object } from "./command-api.ts";

export type Captions = { final: string; interim: string };

// Final segments are keyed by audio position, never by their text. Repeated words
// at different positions are meaningful; replayed Results frames are not new words.
export class TranscriptBuffer {
  private segments = new Map<number, { text: string; end: number }>();
  private interim = { start: 0, text: "" };

  accept(data: unknown): Captions {
    const value = object(data);
    if (value?.type !== "Results") return this.captions();
    const channel = object(value.channel);
    const alternative = Array.isArray(channel?.alternatives)
      ? object(channel.alternatives[0])
      : null;
    if (
      typeof alternative?.transcript !== "string" ||
      typeof value.start !== "number" ||
      !Number.isFinite(value.start) ||
      value.start < 0 ||
      typeof value.duration !== "number" ||
      !Number.isFinite(value.duration) ||
      value.duration < 0 ||
      typeof value.is_final !== "boolean"
    ) {
      throw new Error(
        "Morning received invalid captions. Your captured words are still available.",
      );
    }
    const text = alternative.transcript.trim();
    const end = value.start + value.duration;
    if (value.is_final) {
      const existing = this.segments.get(value.start);
      if (text && (!existing || end >= existing.end))
        this.segments.set(value.start, { text, end });
      if (this.interim.start <= end) this.interim = { start: end, text: "" };
    } else {
      const finalizedEnd = Math.max(
        0,
        ...[...this.segments.values()].map((segment) => segment.end),
      );
      if (value.start >= finalizedEnd - 0.001)
        this.interim = { start: value.start, text };
    }
    return this.captions();
  }

  captions(): Captions {
    return {
      final: [...this.segments.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, segment]) => segment.text)
        .join(" "),
      interim: this.interim.text,
    };
  }
}
