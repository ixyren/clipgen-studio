import { parseFlexibleTimestamp } from "./time";

export interface ParsedClip {
  title: string;
  start: number;
  end: number;
  notes?: string;
}

export interface ParseJsonResult {
  success: boolean;
  streamUrl: string | null;
  clips: ParsedClip[];
  error?: string;
}

export function parseClipGenJson(rawText: string): ParseJsonResult {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return {
      success: false,
      streamUrl: null,
      clips: [],
      error: "El texto ingresado está vacío.",
    };
  }

  let parsed: any;
  try {
    let cleaned = trimmed;
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    }
    parsed = JSON.parse(cleaned);
  } catch (err: any) {
    return {
      success: false,
      streamUrl: null,
      clips: [],
      error: `Sintaxis JSON inválida: ${err?.message || "Revisa comas y comillas."}`,
    };
  }

  if (!parsed || typeof parsed !== "object") {
    return {
      success: false,
      streamUrl: null,
      clips: [],
      error: "El JSON debe ser un objeto con formato { stream_url?, clips: [...] }.",
    };
  }

  const rawClips = Array.isArray(parsed.clips) ? parsed.clips : null;
  if (!rawClips || rawClips.length === 0) {
    return {
      success: false,
      streamUrl: null,
      clips: [],
      error: "El JSON debe contener un arreglo 'clips' con al menos un elemento.",
    };
  }

  const validClips: ParsedClip[] = [];
  for (let i = 0; i < rawClips.length; i++) {
    const c = rawClips[i];
    if (!c || typeof c !== "object") {
      return {
        success: false,
        streamUrl: null,
        clips: [],
        error: `El clip #${i + 1} no es un objeto válido.`,
      };
    }

    const title =
      typeof c.title === "string" && c.title.trim()
        ? c.title.trim()
        : `Clip ${i + 1}`;

    const start = parseFlexibleTimestamp(c.start);
    if (start === null) {
      return {
        success: false,
        streamUrl: null,
        clips: [],
        error: `Clip "${title}" (#${i + 1}): valor 'start' inválido. Usa segundos o HH:MM:SS.`,
      };
    }

    const end = parseFlexibleTimestamp(c.end);
    if (end === null) {
      return {
        success: false,
        streamUrl: null,
        clips: [],
        error: `Clip "${title}" (#${i + 1}): valor 'end' inválido. Usa segundos o HH:MM:SS.`,
      };
    }

    if (end <= start) {
      return {
        success: false,
        streamUrl: null,
        clips: [],
        error: `Clip "${title}" (#${i + 1}): 'end' (${end}s) debe ser mayor que 'start' (${start}s).`,
      };
    }

    validClips.push({
      title,
      start,
      end,
      notes: typeof c.notes === "string" ? c.notes : undefined,
    });
  }

  const streamUrl =
    typeof parsed.stream_url === "string" && parsed.stream_url.trim()
      ? parsed.stream_url.trim()
      : null;

  return {
    success: true,
    streamUrl,
    clips: validClips,
  };
}
