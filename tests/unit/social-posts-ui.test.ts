import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html = readFileSync('src/dashboard/ui/index.html', 'utf8');
const section = html.slice(html.indexOf('  const PST_STATUSES ='), html.indexOf('  function metaRender()'));
const esc = (value: unknown) => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
const ui = () => runInNewContext(`${section}; ({ pstCardHtml, pstResolution, pstState });`, {
  esc, metaTrunc: (value: string) => value, Date,
}) as {
  pstCardHtml(post: Record<string, unknown>, site: { name: string }): string;
  pstResolution(post: Record<string, unknown>, values: Record<string, { remoteId?: string; notPublished?: boolean }>): { outcome: string; remoteIds: Record<string, string> };
  pstState: Record<string, unknown>;
};
const post = (status: string, extra: Record<string, unknown> = {}) => ({
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status, platforms: ['facebook', 'instagram'], message: '<script>alert(1)</script>',
  scheduledAt: null, createdBy: 'admin', createdAt: 0, remoteIds: {}, ...extra,
});

describe('social posts recovery UI', () => {
  it.each([
    ['late', 'publish-now', 'Publicar ahora'], ['failed', 'retry', 'Reintentar pendientes'],
    ['needs_review', 'resolve', 'Verificar en Meta'],
  ])('offers the correct action for %s without sending immediately', (status, action, label) => {
    const card = ui().pstCardHtml(post(status), { name: 'Cliente' });
    expect(card).toContain(`data-act="${action}"`);
    expect(card).toContain(label);
    expect(card).not.toContain('data-act="recovery-ok"');
    expect(card).toContain('&lt;script&gt;');
    expect(card).not.toContain('<script>');
    expect(card).not.toContain('llega en la Fase 2b');
  });
  it.each(['draft', 'approved', 'publishing', 'published', 'cancelled', 'rejected'])('does not offer recovery for %s', status => {
    const card = ui().pstCardHtml(post(status), { name: 'Cliente' });
    expect(card).not.toMatch(/data-act="(resolve|retry|publish-now)"/);
  });
  it('shows a per-platform review and explicit confirmation, escaping identifiers and client names', () => {
    const view = ui();
    view.pstState.recoveryId = post('needs_review').id;
    view.pstState.recoveryAction = 'resolve';
    const card = view.pstCardHtml(post('needs_review', { remoteIds: { facebook: '<img onerror=x>' } }), { name: '<Cliente>' });
    expect(card).toContain('data-remote-id="instagram"');
    expect(card).toContain('data-not-published="instagram"');
    expect(card).not.toContain('data-remote-id="facebook"');
    expect(card).toContain('&lt;img onerror=x&gt;');
    expect(card).toContain('Confirmar verificación');
    expect(card).toContain('role="alert"');
  });
  it('requires the admin to check every unresolved platform', () => {
    const view = ui();
    expect(() => view.pstResolution(post('needs_review'), {})).toThrow('Verificá Facebook');
    expect(() => view.pstResolution(post('needs_review'), { facebook: { remoteId: '111_5' } })).toThrow('Verificá Instagram');
    expect(() => view.pstResolution(post('needs_review'), { facebook: { remoteId: '111_5', notPublished: true } })).toThrow('no ambos');
    expect(() => view.pstResolution(post('needs_review'), { facebook: { remoteId: 'http://evil' } })).toThrow('ID de Facebook');
  });
  it('records partial success and queues only the platform verified as not published', () => {
    const result = ui().pstResolution(post('needs_review'), { facebook: { remoteId: '111_5' }, instagram: { notPublished: true } });
    expect(result).toEqual({ outcome: 'not_published', remoteIds: { facebook: '111_5' } });
  });
  it('confirms all platforms published without requeueing', () => {
    const result = ui().pstResolution(post('needs_review', { remoteIds: { facebook: '111_5' } }), { instagram: { remoteId: '222' } });
    expect(result).toEqual({ outcome: 'published', remoteIds: { instagram: '222' } });
  });
  it('keeps versioned recovery and double-submission guards wired into actual click handling', () => {
    expect(section).toContain('pstState.recoveryVersion = post.version');
    expect(section).toContain('pstState.recoveryVersion, extra');
    expect(section).toContain('if (stale() || pstState.busy) return');
    expect(section).toContain("if (err.status === 409) { pstState.approvingId = null; pstState.recoveryId = null; }");
  });
});
