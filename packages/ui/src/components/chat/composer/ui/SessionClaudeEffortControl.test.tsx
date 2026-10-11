import { expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';

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

type FetchCall = { path: string; method: string; body: BodyInit | null | undefined };

const setup = async (response: () => Response) => {
  const restoreDom = installDom();
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { toast } = await import('sonner');
  const { I18nProvider } = await import('@/lib/i18n');
  const { SessionClaudeEffortControl } = await import('./SessionClaudeEffortControl');

  const calls: FetchCall[] = [];
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : input.toString(), 'http://localhost/').pathname;
    calls.push({
      path,
      method: String(init?.method ?? 'GET'),
      body: init?.body,
    });
    return response();
  });
  const errorToast = spyOn(toast, 'error').mockImplementation(() => 'error-toast');

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const renderControl = (effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null) => act(async () => root.render(
    <I18nProvider>
      <SessionClaudeEffortControl sessionId="ses_claude" directory="/workspace" effort={effort} />
    </I18nProvider>,
  ));
  const cleanup = async () => {
    await act(async () => root.unmount());
    fetchSpy.mockRestore();
    errorToast.mockRestore();
    await restoreDom();
  };
  return { act, calls, errorToast, renderControl, cleanup };
};

const trigger = () => document.querySelector<HTMLButtonElement>('button[aria-label="Reasoning effort"]');

const pickFromMenu = async (act: typeof import('react').act, label: string) => {
  const button = trigger();
  if (!button) throw new Error('Missing effort trigger');
  await act(async () => { button.click(); });
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find((entry) => entry.textContent?.trim() === label);
  if (!item) throw new Error(`Missing menu item ${label}`);
  await act(async () => { item.click(); });
};

test('shows the level the session record holds, and the default when unset', async () => {
  const { renderControl, cleanup } = await setup(() => Response.json({ data: { effort: 'high' } }));
  try {
    await renderControl('high');
    expect(trigger()?.textContent).toContain('High');
    await renderControl(null);
    expect(trigger()?.textContent).toContain('Default');
  } finally {
    await cleanup();
  }
});

test('picking a level calls the endpoint with the right body and shows it at once', async () => {
  const { act, calls, renderControl, cleanup } = await setup(() => Response.json({ data: { effort: 'xhigh' } }));
  try {
    await renderControl(null);
    await pickFromMenu(act, 'xHigh');

    expect(calls).toEqual([{
      path: '/api/session/ses_claude/effort',
      method: 'POST',
      body: JSON.stringify({ effort: 'xhigh' }),
    }]);
    // The record has not caught up yet; the picked level stays on screen.
    expect(trigger()?.textContent).toContain('xHigh');
  } finally {
    await cleanup();
  }
});

test('picking the default clears the level with a null body', async () => {
  const { act, calls, renderControl, cleanup } = await setup(() => Response.json({ data: { effort: null } }));
  try {
    await renderControl('low');
    await pickFromMenu(act, 'Default');

    expect(calls).toEqual([{
      path: '/api/session/ses_claude/effort',
      method: 'POST',
      body: JSON.stringify({ effort: null }),
    }]);
    expect(trigger()?.textContent).toContain('Default');
  } finally {
    await cleanup();
  }
});

test('a failed change rolls back to the record value and toasts', async () => {
  const { act, errorToast, renderControl, cleanup } = await setup(() => new Response('nope', { status: 500 }));
  try {
    await renderControl('medium');
    await pickFromMenu(act, 'Max');

    expect(trigger()?.textContent).toContain('Medium');
    expect(errorToast.mock.calls.length).toBe(1);
  } finally {
    await cleanup();
  }
});
