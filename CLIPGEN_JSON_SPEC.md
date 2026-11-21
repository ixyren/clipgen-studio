# ClipGen Studio — Especificación de Formato JSON para Clips

Este documento define la estructura y reglas del archivo JSON que **ClipGen Studio** acepta para importar automáticamente la lista de clips y la URL del stream para su corte y descarga de alto rendimiento.

Puedes copiar este documento o adjuntarlo a cualquier Inteligencia Artificial (Gemini, Claude, ChatGPT, etc.) junto con la transcripción de un stream para que genere automáticamente los cortes óptimos.

---

## 1. Estructura JSON Oficial

El archivo o bloque JSON debe ser un objeto raíz con la clave `stream_url` y la lista de `clips`:

```json
{
  "stream_url": "https://www.youtube.com/watch?v=EjemploStreamId",
  "clips": [
    {
      "title": "Victoria épica contra el primer jefe",
      "start": 1420.5,
      "end": 1465.0,
      "notes": "Gritos de emoción y remate con golpe crítico"
    },
    {
      "title": "Momento gracioso con caída inesperada",
      "start": "01:15:30",
      "end": "01:16:15",
      "notes": "Pico de audio detectado: risas del streamer"
    }
  ]
}
```

---

## 2. Tipos de Datos y Restricciones

| Campo | Tipo | Requerido | Descripción |
|---|---|---|---|
| `stream_url` | `string` | Opcional | URL completa del video o directo (YouTube, Twitch, Kick, etc.). Si está presente, ClipGen Studio la cargará automáticamente en el reproductor. |
| `clips` | `array` | **Sí** | Lista de segmentos a cortar. |
| `clips[].title` | `string` | **Sí** | Nombre limpio y descriptivo del clip (máximo 80 caracteres recomendado). Evita caracteres especiales no válidos en archivos de Windows (`\ / : * ? " < > \|`). |
| `clips[].start` | `number` \| `string` | **Sí** | Marca de inicio. Puede ser un número en segundos (`1420` o `1420.5`) o una marca de tiempo en formato `"HH:MM:SS"` o `"MM:SS"`. |
| `clips[].end` | `number` \| `string` | **Sí** | Marca de fin. Aplica el mismo formato que `start`. **Regla obligatoria:** `end` debe ser estrictamente mayor que `start`. |
| `clips[].notes` | `string` | Opcional | Explicación o contexto del corte (ej. "Reacción al drop", "Pico de audio", "Jugada destacada"). |

---

## 3. Reglas de Calidad para la Inteligencia Artificial

1. **Duración recomendada por clip:** Entre **15 y 90 segundos** para clips estándar de redes sociales (TikTok, Reels, YouTube Shorts) o hasta **3 a 5 minutos** para partidas/momentos extendidos.
2. **Contexto de corte:** El `start` debe comenzar unos segundos antes de la acción para que el espectador entienda el contexto. El `end` debe terminar justo cuando concluye la reacción o remate.
3. **Consistencia cronológica:** Ordena los clips cronológicamente por `start`.
4. **Títulos atractivos:** Usa títulos en formato oración o gancho (ej. *"01. Derrotando al dragón ancestral sin recibir daño"*).
5. **Formato limpio:** Devuelve estrictamente el bloque JSON dentro de un bloque de código ```json ... ``` sin texto introductorio ni explicaciones superfluas.

---

## 4. Prompt Maestro para la IA (Gemini / Claude / ChatGPT)

Copia y pega el siguiente prompt a tu IA junto con la transcripción o resumen de tu directo:

```text
Actúa como un editor de video y creador de contenido profesional para YouTube Shorts, TikTok y Reels.

Analiza la siguiente transcripción con marcas de tiempo (timestamps) y picos de audio de un stream de YouTube. Tu objetivo es seleccionar los mejores momentos y clips más virales, entretenidos, graciosos o de mayor tensión de todo el directo.

Genera ÚNICAMENTE un bloque de código JSON válido con la siguiente especificación exacta para importarlo directamente en ClipGen Studio:

{
  "stream_url": "URL_DEL_STREAM_AQUI",
  "clips": [
    {
      "title": "Título descriptivo y atractivo del clip",
      "start": 1420,
      "end": 1465,
      "notes": "Motivo del corte y momento destacado"
    }
  ]
}

Reglas:
1. "start" y "end" deben ser números en segundos o marcas en formato "HH:MM:SS".
2. "end" debe ser estrictamente mayor que "start".
3. Incluye unos 2 a 5 segundos de contexto previo antes del momento cumbre y 2 a 4 segundos de reacción posterior.
4. Si en la transcripción hay etiquetas [PICO DE AUDIO], prioriza esos segmentos porque indican gritos, risas o momentos de máxima emoción.
5. No inventes marcas de tiempo fuera del rango de la transcripción.
6. Devuelve EXCLUSIVAMENTE el JSON dentro de un bloque ```json ``` sin explicaciones adicionales.

Transcripción del stream:
[PEGA AQUÍ TU TRANSCRIPCIÓN CON TIMESTAMPS Y PICOS DE AUDIO]
```
