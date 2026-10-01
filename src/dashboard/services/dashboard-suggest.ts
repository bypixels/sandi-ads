/**
 * Dashboard suggestions — one-shot Claude interpretation of an analysis result.
 *
 * Called from `/api/dashboard/suggest` after the user runs the URL analyzer.
 * Streams Claude tokens via callback so the UI can render them live.
 *
 * Deliberate non-features (vs. the agent loop):
 *   - No tool use. Pure text in/out.
 *   - No conversation persistence. Doesn't pollute the chat history.
 *   - Cheaper/faster model (haiku). Interpretation is not multi-turn reasoning.
 */

import Anthropic from '@anthropic-ai/sdk';
import { createServiceLogger } from '../../utils/logger.js';

const log = createServiceLogger('dashboard-suggest');

const MODEL = process.env.SUGGEST_MODEL || 'claude-haiku-4-5';
const MAX_OUTPUT_TOKENS = 2000;

export type SuggestEvent =
  | { type: 'delta'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

/** True when ANTHROPIC_API_KEY is set in the running process. */
export function isSuggestConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

function buildClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY no configurado. Agregá tu key en Settings.');
  }
  return new Anthropic({ apiKey });
}

/**
 * Stream Claude's interpretation of an analysis JSON to the caller.
 * The `analysis` is the full payload returned by `/api/dashboard?url=...`.
 */
export async function streamSuggestions(
  args: { url: string; analysis: unknown },
  onEvent: (e: SuggestEvent) => void,
): Promise<void> {
  const client = buildClient();
  const json = JSON.stringify(args.analysis, null, 2);

  const systemPrompt = [
    'Sos un analista experto en performance, SEO, accessibility y seguridad web.',
    'Recibís el JSON crudo de una auditoría que ya corrió contra una URL del usuario.',
    '',
    'Tu tarea:',
    '1. Identificá los **3-5 hallazgos más impactantes** (no todos los issues — sólo los que mueven la aguja).',
    '2. Por cada hallazgo proponé una **acción concreta** que el usuario pueda ejecutar.',
    '3. Priorizá por impacto real, no por severidad nominal.',
    '4. Si dos issues comparten causa raíz, decilo y propones una sola acción para ambos.',
    '',
    'Formato:',
    '- Encabezado breve (1 línea) con el diagnóstico general.',
    '- Lista de acciones priorizadas. Cada una con:',
    '  - **Qué hacer** (1 frase imperativa)',
    '  - **Por qué importa** (1-2 frases con el dato concreto del JSON)',
    '  - **Cómo medirlo** (qué métrica del audit cambia si lo aplicás)',
    '',
    'Reglas:',
    '- Markdown. Viñetas. Negritas para los puntos clave.',
    '- En español (es-CR).',
    '- No regurgites el JSON. No copies arrays/listas crudas.',
    '- Si el sitio está en buen estado en general, decilo en una línea y enfocate en ajustes finos.',
    '- Si una acción requiere ejecutar una tool mutativa (ej. publicar tag, subir media), mencionalo: "esto requiere aprobación en el chat del asistente".',
  ].join('\n');

  const userMessage = `URL auditada: ${args.url}\n\nResultados:\n\`\`\`json\n${json}\n\`\`\``;

  log.info('Streaming dashboard suggestions', { url: args.url, model: MODEL });

  try {
    const stream = await client.messages.stream({
      model: MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        onEvent({ type: 'delta', text: event.delta.text });
      }
    }
    onEvent({ type: 'done' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Suggestions failed', {
      error: err instanceof Error ? err : new Error(msg),
    });
    onEvent({ type: 'error', message: msg });
  }
}
