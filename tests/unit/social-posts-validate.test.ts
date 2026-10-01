import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateDraft } from '../../src/dashboard/services/social-posts-store.js';

const siteId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherSite = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const site = { bindings: { metaPageId: '111', metaIgUserId: '222' } };
const now = Date.UTC(2026, 9, 1, 12, 0, 0);
const MIN = 60_000;
const DAY = 86_400_000;
const file = '0f8fad5b-d9cb-469f-a165-70867728950e.jpg';
const img = `https://media.example.com/sites/${siteId}/2026/10/${file}`;
const base = { siteId, platforms: ['facebook' as const], message: 'Hola', imageUrl: null, scheduledAt: null };

beforeEach(() => vi.stubEnv('R2_PUBLIC_BASE_URL', 'https://media.example.com'));
afterEach(() => vi.unstubAllEnvs());

describe('validateDraft', () => {
  it('accepts a valid Facebook text post published as soon as approved', () => {
    expect(validateDraft(base, site, now)).toEqual([]);
  });
  it('accepts a valid Instagram + Facebook post with an R2 image of the same site', () => {
    expect(validateDraft({ ...base, platforms: ['facebook', 'instagram'], imageUrl: img }, site, now)).toEqual([]);
  });
  it('requires at least one platform and rejects unknown ones', () => {
    expect(validateDraft({ ...base, platforms: [] }, site, now).join()).toMatch(/al menos una plataforma/);
    expect(validateDraft({ ...base, platforms: ['twitter' as never] }, site, now).join()).toMatch(/Plataforma no válida/);
  });
  it('Instagram requires an image; Facebook requires message or image', () => {
    expect(validateDraft({ ...base, platforms: ['instagram'] }, site, now).join()).toMatch(/Instagram requiere una imagen/);
    expect(validateDraft({ ...base, message: '  ' }, site, now).join()).toMatch(/Facebook requiere un mensaje o una imagen/);
    expect(validateDraft({ ...base, message: '', imageUrl: img }, site, now)).toEqual([]);
  });
  it('enforces caption limits per platform', () => {
    const long = 'a'.repeat(2201);
    expect(validateDraft({ ...base, message: long }, site, now)).toEqual([]);
    expect(validateDraft({ ...base, platforms: ['instagram'], message: long, imageUrl: img }, site, now).join()).toMatch(/2200/);
    expect(validateDraft({ ...base, message: 'a'.repeat(63207) }, site, now).join()).toMatch(/63206/);
  });
  it('scheduledAt must be between now+5 min and now+60 days', () => {
    expect(validateDraft({ ...base, scheduledAt: now + 4 * MIN }, site, now).join()).toMatch(/5 minutos/);
    expect(validateDraft({ ...base, scheduledAt: now + 6 * MIN }, site, now)).toEqual([]);
    expect(validateDraft({ ...base, scheduledAt: now + 61 * DAY }, site, now).join()).toMatch(/60 días/);
    expect(validateDraft({ ...base, scheduledAt: Number.NaN }, site, now).join()).toMatch(/fecha programada no es válida/);
  });
  it('approval skips the minimum-lead rule so past schedules are treated as due', () => {
    expect(validateDraft({ ...base, scheduledAt: now - DAY }, site, now)).not.toEqual([]);
    expect(validateDraft({ ...base, scheduledAt: now - DAY }, site, now, { forApproval: true })).toEqual([]);
    expect(validateDraft({ ...base, scheduledAt: now + 61 * DAY }, site, now, { forApproval: true })).not.toEqual([]);
  });
  it('requires site bindings for each platform', () => {
    expect(validateDraft(base, { bindings: { metaIgUserId: '222' } }, now).join()).toMatch(/página de Facebook/);
    expect(validateDraft({ ...base, platforms: ['instagram'], imageUrl: img }, { bindings: { metaPageId: '111' } }, now).join())
      .toMatch(/cuenta de Instagram/);
    expect(validateDraft(base, null, now).join()).toMatch(/El sitio no existe/);
  });
  it('only accepts images from the configured R2 public base URL under this site', () => {
    const bad = [
      'https://evil.com/x.jpg',
      'https://media.example.com.evil.com/sites/' + siteId + '/x.jpg',
      `https://media.example.com/sites/${otherSite}/2026/10/x.jpg`,
      `https://media.example.com/sites/${siteId}/../${otherSite}/x.jpg`,
    ];
    for (const imageUrl of bad) {
      expect(validateDraft({ ...base, imageUrl }, site, now).join(), imageUrl).toMatch(/no se aceptan URL externas/);
    }
  });
  it('rejects any image when R2 is not configured', () => {
    vi.stubEnv('R2_PUBLIC_BASE_URL', '');
    expect(validateDraft({ ...base, imageUrl: img }, site, now).join()).toMatch(/R2/);
  });
  it('image key must match the image URL', () => {
    const imageKey = `sites/${siteId}/2026/10/${file}`;
    expect(validateDraft({ ...base, imageUrl: img, imageKey }, site, now)).toEqual([]);
    expect(validateDraft({ ...base, imageUrl: img, imageKey: 'sites/x/y.jpg' }, site, now).join()).toMatch(/no coincide/);
    expect(validateDraft({ ...base, imageUrl: img, imageKey: `sites/${otherSite}/2026/10/${file}` }, site, now).join()).toMatch(/no coincide/);
  });
  it('the path after sites/<siteId>/ must be exactly YYYY/MM/<lowercase uuid>.jpg (no encoding tricks)', () => {
    const prefix = `https://media.example.com/sites/${siteId}/`;
    const bad = [
      `${prefix}%2e%2e/${otherSite}/2026/10/${file}`,
      `${prefix}%2E%2E/${otherSite}/2026/10/${file}`,
      `${prefix}2026%2F10/${file}`,
      `${prefix}2026/10/${file.toUpperCase().replace('.JPG', '.jpg')}`,
      `${prefix}2026/10/extra/${file}`,
      `${prefix}x/2026/10/${file}`,
      `${prefix}2026/10/${file}?v=1`,
      `${prefix}2026/10/${file}#frag`,
      `${prefix}2026/10/x.jpg`,
      `${prefix}2026/10/${file}.png`,
      `${prefix}2026/10/${file.replace('.jpg', '%2ejpg')}`,
    ];
    for (const imageUrl of bad) {
      expect(validateDraft({ ...base, imageUrl }, site, now).join(), imageUrl).toMatch(/no se aceptan URL externas/);
    }
    expect(validateDraft({ ...base, imageUrl: `${prefix}2026/10/${file}` }, site, now)).toEqual([]);
  });
  it('rejects duplicated platforms', () => {
    expect(validateDraft({ ...base, platforms: ['facebook', 'facebook'] }, site, now).join()).toMatch(/repetida/);
    expect(validateDraft({ ...base, platforms: ['facebook', 'instagram', 'instagram'], imageUrl: img }, site, now).join()).toMatch(/repetida/);
  });
});
