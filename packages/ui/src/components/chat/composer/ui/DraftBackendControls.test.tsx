import { afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { I18nProvider } from '@/lib/i18n';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { DraftBackendControls } from './DraftBackendControls';

let browser: Window;
let root: Root;
const descriptors = new Map<string, PropertyDescriptor | undefined>();
const originalSelection = useSessionUIStore.getState();

beforeEach(() => {
  browser = new Window({ url: 'http://localhost' });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    localStorage: browser.localStorage,
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
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
  useSessionUIStore.setState(originalSelection);
});

const openDraft = (claudeBackend?: { model: 'opus' | 'sonnet' | 'haiku' | 'fable' }) => {
  useSessionUIStore.setState({
    currentSessionId: null,
    newSessionDraft: {
      draftId: 21,
      open: true,
      directoryOverride: '/repo',
      parentID: null,
      target: 'project',
      claudeBackend,
    },
  });
};

const triggerLabels = () => [...document.querySelectorAll('button')]
  .map((node) => node.textContent?.trim() ?? '')
  .filter(Boolean);

test('offers OpenCode by default, without a Claude model picker', async () => {
  openDraft(undefined);
  await act(async () => root.render(
    <I18nProvider>
      <DraftBackendControls />
    </I18nProvider>,
  ));

  const labels = triggerLabels();
  expect(labels).toContain('OpenCode');
  expect(labels).not.toContain('Claude Code');
  expect(labels).not.toContain('Opus');
});

test('a Claude draft shows the backend and its selected model alias', async () => {
  openDraft(undefined);
  await act(async () => root.render(
    <I18nProvider>
      <DraftBackendControls />
    </I18nProvider>,
  ));

  await act(async () => useSessionUIStore.getState().setDraftClaudeBackend({ model: 'sonnet' }));

  const labels = triggerLabels();
  expect(labels).toContain('Claude Code');
  expect(labels).toContain('Sonnet');
  expect(labels).not.toContain('OpenCode');
});
