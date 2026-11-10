// Every link in whatever was pasted: bare, in markdown or HTML, in a list or
// in a sentence, with or without https://.

// Endings that make a bare word a file name, not a site, when nothing follows
// it. Real site endings that are also file types (bun.sh, docs.rs) aren't here.
const FILE_ENDINGS = new Set([
  'md',
  'txt',
  'py',
  'js',
  'ts',
  'go',
  'rb',
  'css',
  'html',
  'json',
  'pdf',
  'png',
  'jpg',
  'gif',
  'zip',
]);

const LINK = /\bhttps?:\/\/[^\s<>"'`]+|(?<![@\w.-])(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>"'`]*)?/gi;

// Punctuation after a link belongs to the sentence, and a closing bracket
// belongs to the link only if the link opened one.
function trim(link: string): string {
  let end = link.replace(/[.,;:!?'"]+$/, '');
  while (/[)\]}>]$/.test(end)) {
    const close = end.at(-1)!;
    const open = { ')': '(', ']': '[', '}': '{', '>': '<' }[close]!;
    if (end.split(open).length > end.split(close).length - 1) break;
    end = end.slice(0, -1).replace(/[.,;:!?'"]+$/, '');
  }
  return end;
}

export function linksIn(text: string): string[] {
  const found = new Set<string>();
  for (const [match] of text.matchAll(LINK)) {
    const link = trim(match);
    const bare = !/^https?:\/\//i.test(link);
    try {
      const url = new URL(bare ? `https://${link}` : link);
      const ending = url.hostname.split('.').at(-1)!.toLowerCase();
      if (bare && url.pathname === '/' && FILE_ENDINGS.has(ending)) continue;
      found.add(url.href);
    } catch {
      // not an address after all
    }
  }
  return [...found];
}
