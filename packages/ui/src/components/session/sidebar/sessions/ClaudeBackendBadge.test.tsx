import { afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { Session } from '@/lib/opencode/model';
import { I18nProvider } from '@/lib/i18n';
import { ClaudeBackendBadge } from './ClaudeBackendBadge';

let browser: Window;
let root: Root;
const descriptors = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
  browser = new Window({ url: 'http://localhost' });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    localStorage: browser.localStorage,
    HTMLElement: browser.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const renderBadge = (metadata: Session['metadata']) => root.render(
  <I18nProvider>
    <ClaudeBackendBadge session={{ metadata }} />
  </I18nProvider>,
);

const badgeElement = () => [...document.querySelectorAll('span')]
  .find((node) => node.textContent === 'Claude') ?? null;

test('a Claude session row carries the badge', async () => {
  await act(async () => renderBadge({ openchamber: { backend: 'claude' } }));
  const badge = badgeElement();
  expect(badge).not.toBeNull();
  expect(badge?.getAttribute('title')).toBeTruthy();
});

test('an OpenCode session row stays unmarked', async () => {
  await act(async () => renderBadge({ openchamber: { backend: 'opencode' } }));
  expect(badgeElement()).toBeNull();

  await act(async () => renderBadge(undefined));
  expect(badgeElement()).toBeNull();
});
