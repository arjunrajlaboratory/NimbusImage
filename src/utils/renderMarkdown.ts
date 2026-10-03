import { marked } from "marked";
import DOMPurify from "dompurify";

// Render assistant/LLM markdown to sanitized HTML for use with v-html.
// marked produces HTML from untrusted model output, so the result must be
// sanitized before it is injected into the DOM. Kept in one place so both
// the AI panel and the chat component render markdown identically and
// safely, and so the `marked` import stays out of the components.
export function renderAssistantMarkdown(text: string): string {
  return DOMPurify.sanitize(marked(text) as string);
}
