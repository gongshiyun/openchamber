import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { ModelRef } from '@/lib/opencode/model';

/**
 * The menu, React and the component are imported after the DOM is installed:
 * base-ui resolves the document at module evaluation, so a static import
 * would capture the previous test's window.
 */

const installDom = () => {
  const browser = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    Element: browser.Element,
    HTMLElement: browser.HTMLElement,
    Node: browser.Node,
    Event: browser.Event,
    MouseEvent: browser.MouseEvent,
    KeyboardEvent: browser.KeyboardEvent,
    ResizeObserver: browser.ResizeObserver,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  return async () => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await browser.happyDOM.close();
  };
};

const switchCalls: Array<{ sessionId: string; model: ModelRef; directory: string | null | undefined }> = [];

const setup = async () => {
  const restoreDom = installDom();
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { opencodeClient } = await import('@/lib/opencode/client');
  const { SessionClaudeModelControl } = await import('./SessionClaudeModelControl');

  const originalSwitchSessionModel = opencodeClient.switchSessionModel;
  switchCalls.length = 0;
  opencodeClient.switchSessionModel = async (sessionId, model, directory) => {
    switchCalls.push({ sessionId, model, directory });
  };

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const renderControl = (model: 'opus' | 'sonnet' | 'haiku' | 'fable') => act(async () => root.render(
    <I18nProvider>
      <SessionClaudeModelControl sessionId="ses_claude" directory="/workspace" model={model} />
    </I18nProvider>,
  ));
  const cleanup = async () => {
    await act(async () => root.unmount());
    opencodeClient.switchSessionModel = originalSwitchSessionModel;
    await restoreDom();
  };
  return { act, renderControl, cleanup };
};

const trigger = () => document.querySelector<HTMLButtonElement>('button[aria-label="Claude model"]');

const pickFromMenu = async (act: typeof import('react').act, label: string) => {
  const button = trigger();
  if (!button) throw new Error('Missing Claude model trigger');
  await act(async () => { button.click(); });
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find((entry) => entry.textContent?.trim() === label);
  if (!item) throw new Error(`Missing menu item ${label}`);
  await act(async () => { item.click(); });
};

test('shows the alias the session record runs on', async () => {
  const { renderControl, cleanup } = await setup();
  try {
    await renderControl('sonnet');
    expect(trigger()?.textContent).toContain('Sonnet');
  } finally {
    await cleanup();
  }
});

test('picking an alias switches the session on the Claude provider and shows it at once', async () => {
  const { act, renderControl, cleanup } = await setup();
  try {
    await renderControl('sonnet');
    await pickFromMenu(act, 'Haiku');

    expect(switchCalls).toEqual([{
      sessionId: 'ses_claude',
      model: { providerID: 'claude-code', id: 'haiku' },
      directory: '/workspace',
    }]);
    expect(trigger()?.textContent).toContain('Haiku');
  } finally {
    await cleanup();
  }
});

test('a failed switch falls back to the alias the record still holds', async () => {
  const { act, renderControl, cleanup } = await setup();
  try {
    await renderControl('sonnet');
    const { opencodeClient } = await import('@/lib/opencode/client');
    opencodeClient.switchSessionModel = async () => { throw new Error('offline'); };
    await pickFromMenu(act, 'Opus');

    expect(trigger()?.textContent).toContain('Sonnet');
  } finally {
    await cleanup();
  }
});
