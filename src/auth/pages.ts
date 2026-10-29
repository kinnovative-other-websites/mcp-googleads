/**
 * Tiny self-contained HTML pages for sign-in errors and the landing page.
 */
import type { Response } from 'express';

export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

const STYLE = `
  :root { color-scheme: light dark; --bg:#f6f7f9; --card:#fff; --text:#1d2433; --muted:#5b6475; --accent:#1a73e8; --line:#e3e6eb; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111418; --card:#1a1f26; --text:#e8eaed; --muted:#9aa3b2; --accent:#8ab4f8; --line:#2b323c; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--text);
         font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; padding:16px; }
  main { max-width:560px; width:100%; background:var(--card); border:1px solid var(--line); border-radius:12px; padding:28px; }
  h1 { font-size:20px; margin:0 0 12px; }
  p { margin:0 0 12px; color:var(--muted); }
  code { font-size:14px; background:var(--bg); padding:1px 5px; border-radius:4px; word-break:break-all; }
  a.button { display:inline-block; margin-top:8px; padding:9px 16px; border-radius:8px; background:var(--accent); color:#fff;
             text-decoration:none; font-weight:600; }
  @media (prefers-color-scheme: dark) { a.button { color:#111418; } }
`;

export function sendPage(
  res: Response,
  status: number,
  title: string,
  paragraphs: string[],
  action?: { href: string; label: string },
): void {
  const body = paragraphs.map((p) => `<p>${p}</p>`).join('\n');
  const button = action ? `<a class="button" href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a>` : '';
  res
    .status(status)
    .set({
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      'x-frame-options': 'DENY',
    })
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
        `<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>` +
        `<body><main><h1>${escapeHtml(title)}</h1>\n${body}\n${button}</main></body></html>`,
    );
}
