import { Pipe, PipeTransform } from '@angular/core';
import { marked } from 'marked';

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// breaks: a single newline is a line break, which is how models write chat prose.
// html: raw tags from the model are shown as text, never mounted. Angular's sanitizer
// already defuses them, but it keeps <img>, and a remote src is a beacon.
marked.use({
  gfm: true,
  breaks: true,
  renderer: { html: ({ text }) => escapeHtml(text) },
});

/**
 * Agent replies come back as markdown. The result is bound with [innerHTML], which
 * Angular runs through DomSanitizer — that is what strips scripts, on* handlers and
 * javascript: URLs, so no separate sanitizer is pulled in. Never bypass it here.
 */
@Pipe({ name: 'markdown' })
export class Markdown implements PipeTransform {
  transform(value: string | undefined): string {
    if (!value) return '';
    const html = marked.parse(value) as string;
    // marked has already escaped every href; this only bolts on static attributes.
    return html.replace(/<a href=/g, '<a target="_blank" rel="noopener noreferrer" href=');
  }
}
