import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

// Browser ESM in a repository whose build scripts are CJS: do not change package semantics.
const sourceURL = new URL('../site-experience.js', import.meta.url);
const source = (await readFile(sourceURL, 'utf8')).replaceAll('import.meta.url', JSON.stringify(sourceURL.href));
const { documentRoute, shouldHandleLink, repositorySnapshot, cachedSnapshot, METADATA_TTL, REPOSITORY } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const base = new URL('https://example.org/home-studio/');
const repository = { full_name: REPOSITORY, private: false, html_url: `https://github.com/${REPOSITORY}`, stargazers_count: 23, forks_count: 7, pushed_at: '2026-10-30T11:22:33Z' };

test('only the six documentation pages are navigated within the site prefix', () => {
  for (const path of ['', 'index.html', 'install.html', 'ai-setup.html', 'privacy.html', 'planner/guide.html?lang=ja#door', 'planner/publishing.html']) assert.equal(documentRoute(path, base)?.href, new URL(path, base).href);
  for (const path of ['planner/', 'planner/index.html', 'planner/?example=patterns', 'docs/a.html', '/install.html', '../other/install.html', 'https://elsewhere.org/home-studio/install.html', 'javascript:alert(1)', 'https://user:password@example.org/home-studio/install.html', 'install.html/']) assert.equal(documentRoute(path, base), null, path);
  assert(documentRoute('/privacy.html', new URL('https://example.org/')), 'custom domain root is supported');
  assert.equal(documentRoute('file:///tmp/install.html', new URL('file:///tmp/')), null);
});

test('ordinary link affordances are preserved', () => {
  const event = { button: 0, defaultPrevented: false };
  const link = (attrs = {}) => ({ href: new URL('install.html', base).href, hasAttribute: name => name in attrs, getAttribute: name => attrs[name] ?? null });
  assert(shouldHandleLink(event, link(), base));
  for (const field of ['defaultPrevented', 'metaKey', 'ctrlKey', 'shiftKey', 'altKey']) assert(!shouldHandleLink({ ...event, [field]: true }, link(), base));
  assert(!shouldHandleLink({ ...event, button: 1 }, link(), base));
  for (const attrs of [{ target: '_blank' }, { download: '' }, { 'data-native-navigation': '' }]) assert(!shouldHandleLink(event, link(attrs), base));
  assert(shouldHandleLink(event, link({ target: '_self' }), base));
});

test('metadata accepts only the public repository and bounded numeric values', () => {
  assert.deepEqual(repositorySnapshot(repository, 42), { checkedAt: 42, stars: 23, forks: 7, pushedAt: repository.pushed_at });
  for (const patch of [{ private: true }, { full_name: 'another/repository' }, { html_url: 'https://other.example/' }, { stargazers_count: -1 }, { forks_count: '7' }, { stargazers_count: Infinity }, { forks_count: Number.MAX_SAFE_INTEGER + 1 }]) assert.equal(repositorySnapshot({ ...repository, ...patch }), null);
  assert.equal(repositorySnapshot({ ...repository, pushed_at: '<img onerror=alert(1)>' }).pushedAt, null);
  assert.equal(repositorySnapshot(null), null);
});

test('cache freshness is bounded and corrupted, future, or old entries are ignored', () => {
  const now = 10_000_000_000;
  const row = { version: 1, checkedAt: now - 100, data: repository };
  assert.equal(cachedSnapshot(JSON.stringify(row), now).fresh, true);
  assert.equal(cachedSnapshot({ ...row, checkedAt: now - METADATA_TTL }, now).fresh, false);
  for (const value of ['{broken', null, { ...row, version: 2 }, { ...row, checkedAt: now + 1 }, { ...row, checkedAt: now - 8 * 86400000 }, { ...row, data: { ...repository, private: true } }]) assert.equal(cachedSnapshot(value, now), null);
});
