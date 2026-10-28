/**
 * One place that builds AND parses the inline tokens a task description carries:
 *
 *   ![name](attachment-<id>)   an image attachment
 *   @[name](attachment-<id>)   a non-image attachment
 *   @[Label](mention-<id>)     an employee mention (tiptap's link form)
 *   [@ id="…" label="…"]       the serialized span older rows still hold
 *
 * Builders escape the name so a `]`/`)` in a filename can't terminate the target,
 * and parsers validate the id before it reaches an href/src — the two sides must
 * agree, which is exactly why they live together.
 */

/** ids that end up in URLs: uuid/slug tokens only */
const TOKEN_ID_RE = /^[A-Za-z0-9_-]+$/;
/** characters that would break the markdown target or the line */
const UNSAFE_NAME = /[[\]()\r\n]+/g;

const safeName = (name: string) => name.replace(UNSAFE_NAME, '_').trim() || 'file';

/** the src/ref a markdown attachment marker carries — one format for the token
 * builder, the editor image node and the render fallback */
export function attachmentRef(id: string): string {
  return `attachment-${id}`;
}

export function attachmentToken(mime: string, filename: string, id: string): string {
  const marker = mime.startsWith('image/') ? '!' : '@';
  return `${marker}[${safeName(filename)}](${attachmentRef(id)})`;
}

export function mentionToken(label: string, id: string): string {
  return `@[${safeName(label)}](mention-${id})`;
}

export type TaskTextPart =
  | { type: 'text'; body: string }
  | { type: 'mention'; label: string }
  | { type: 'image'; id: string; alt: string }
  | { type: 'file'; id: string; name: string };

const ATTACHMENT_RE = /!\[([^\]]*)\]\(attachment-([^)]*)\)|@\[([^\]]*)\]\(attachment-([^)]*)\)/g;
const MENTION_RE = /@\[([^\]]+)\]\(mention-[^)]+\)|\[@\s*id="[^"]*"\s+label="([^"]+)"\]/g;

/** split a description into text + attachment + mention parts for rendering */
export function parseTaskText(text: string): TaskTextPart[] {
  const parts: TaskTextPart[] = [];
  let last = 0;
  for (const m of text.matchAll(ATTACHMENT_RE)) {
    if (m.index > last) pushText(text.slice(last, m.index));
    // v8 ignore next 1 -- one of the two regex arms always binds an id group; the '' tail is defensive
    const id = m[2] ?? m[4] ?? '';
    if (TOKEN_ID_RE.test(id)) {
      if (m[2] !== undefined) {
        // v8 ignore next 1 -- the alt group always binds; '' is defensive
        parts.push({ type: 'image', id, alt: m[1] ?? '' });
      } else {
        // v8 ignore next 1 -- the name group always binds; '' is defensive
        parts.push({ type: 'file', id, name: m[3] ?? '' });
      }
    } else {
      // unparseable target: show the source text rather than building a URL from it
      parts.push({ type: 'text', body: m[0] });
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) pushText(text.slice(last));
  return parts;

  function pushText(body: string) {
    let at = 0;
    for (const m of body.matchAll(MENTION_RE)) {
      if (m.index > at) parts.push({ type: 'text', body: body.slice(at, m.index) });
      // v8 ignore next 1 -- both mention regexes require a non-empty label; the '' tail is defensive
      parts.push({ type: 'mention', label: m[1] ?? m[2] ?? '' });
      at = m.index + m[0].length;
    }
    if (at < body.length) parts.push({ type: 'text', body: body.slice(at) });
  }
}
