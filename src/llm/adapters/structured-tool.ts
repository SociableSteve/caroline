/**
 * The name every adapter uses for the structured answer, in one place so the adapter that
 * asks for it and the adapter that reads it back cannot drift, and so the boundary test has
 * something stable to look for.
 *
 * Anthropic expresses structured output as a tool the model must call, so it needs a name
 * for it, and OpenAI's response format needs one too. Ollama sends the schema in `format`
 * and needs no name, which is why its adapter does not import this.
 */
export const STRUCTURED_TOOL_NAME = 'structured_answer'

export const structuredToolDescription =
  'Record your answer in the required structure. This is the only way to answer; do not reply in prose.'
