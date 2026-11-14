// HTML written as template strings. Everything put into one is escaped,
// unless it is HTML made the same way.

export class Html {
  constructor(readonly text: string) {}
  toString(): string {
    return this.text;
  }
}

// Text that is HTML already, such as a stylesheet.
export const raw = (text: string) => new Html(text);

export type Part = Html | string | number | false | null | undefined | Part[];

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function render(part: Part): string {
  if (part instanceof Html) return part.text;
  if (Array.isArray(part)) return part.map(render).join('');
  if (part === null || part === undefined || part === false) return '';
  return String(part).replace(/[&<>"']/g, (letter) => ESCAPES[letter]!);
}

export function html(strings: TemplateStringsArray, ...parts: Part[]): Html {
  let text = strings[0]!;
  parts.forEach((part, index) => (text += render(part) + strings[index + 1]));
  return new Html(text);
}
