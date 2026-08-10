/**
 * The name every adapter uses for the structured answer, in one place so the adapter that
 * asks for it and the adapter that reads it back cannot drift, and so the boundary test has
 * something stable to look for.
 *
 * Anthropic and Ollama both express structured output as a tool the model must call, so
 * both need a name for it. OpenAI's response format needs a name too, for the same reason.
 */
export const STRUCTURED_TOOL_NAME = 'structured_answer'

export const structuredToolDescription =
  'Record your answer in the required structure. This is the only way to answer; do not reply in prose.'
