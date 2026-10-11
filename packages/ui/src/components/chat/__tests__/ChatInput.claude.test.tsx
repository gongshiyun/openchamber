import { expect, spyOn, test } from 'bun:test';
import { plugin } from 'bun';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import type { RuntimeAPIs } from '@/lib/api/types';
import type { Session } from '@/lib/opencode/model';

/**
 * The `!` shell trigger on a Claude session: Claude has no shell route, so the
 * character stays plain text and the composer never enters shell mode. The
 * same keystroke on an OpenCode session still enters shell mode.
 *
 * Everything is imported after the DOM is installed; the composer's import
 * graph resolves window/document at module evaluation.
 */

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  localStorage: browser.localStorage,
  sessionStorage: browser.sessionStorage,
  Node: browser.Node,
  Text: browser.Text,
  Element: browser.Element,
  HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement,
  HTMLTextAreaElement: browser.HTMLTextAreaElement,
  HTMLFormElement: browser.HTMLFormElement,
  Range: browser.Range,
  Selection: browser.Selection,
  DocumentFragment: browser.DocumentFragment,
  Event: browser.Event,
  KeyboardEvent: browser.KeyboardEvent,
  MouseEvent: browser.MouseEvent,
  FocusEvent: browser.FocusEvent,
  InputEvent: browser.InputEvent,
  CustomEvent: browser.CustomEvent,
  MutationObserver: browser.MutationObserver,
  ResizeObserver: browser.ResizeObserver,
  IntersectionObserver: browser.IntersectionObserver,
  matchMedia: browser.matchMedia.bind(browser),
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  customElements: browser.customElements,
  HTMLDivElement: browser.HTMLDivElement,
  HTMLSpanElement: browser.HTMLSpanElement,
  SVGElement: browser.SVGElement,
  ShadowRoot: browser.ShadowRoot,
  CSSStyleSheet: browser.CSSStyleSheet,
  DOMParser: browser.DOMParser,
  IS_REACT_ACT_ENVIRONMENT: true,
});

// Nothing typed here reaches a server; every request answers empty.
spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
  const path = new URL(input instanceof Request ? input.url : input.toString(), 'http://localhost/').pathname;
  if (path.endsWith('/location')) {
    return Response.json({ directory: '/workspace', project: { id: 'project', directory: '/workspace', canonical: '/workspace' } });
  }
  if (path.endsWith('/session')) return Response.json({ data: [] });
  return Response.json({});
});

// Vite-only module forms the composer's import graph reaches.
plugin({
  name: 'chat-input-claude-vite-modules',
  setup(build) {
    build.onResolve({ filter: /\?worker&url$/ }, ({ path }) => ({ path, namespace: 'worker-url' }));
    build.onLoad({ filter: /.*/, namespace: 'worker-url' }, () => ({ contents: 'export default "";', loader: 'js' }));
    build.onLoad({ filter: /useProviderLogo\.ts$/ }, ({ path }) => {
      const directory = resolve(dirname(path), '../assets/provider-logos');
      const logos = Object.fromEntries(readdirSync(directory).filter((name) => name.endsWith('.svg')).map((name) => [
        `../assets/provider-logos/${name}`, pathToFileURL(resolve(directory, name)).href,
      ]));
      return { contents: readFileSync(path, 'utf8').replace(/import\.meta\.glob<string>\([\s\S]*?\);/, `${JSON.stringify(logos)};`), loader: 'ts' };
    });
  },
});

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { EditorView } = await import('@codemirror/view');
const { I18nProvider } = await import('@/lib/i18n');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { ChatInput } = await import('../ChatInput');
const { SyncProvider } = await import('@/sync/sync-context');
const { useDirectoryStore } = await import('@/stores/useDirectoryStore');
const { useGlobalSessionsStore } = await import('@/stores/useGlobalSessionsStore');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { OpenCode } = await import('@opencode/client');

const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };

const claudeSession: Session = {
  id: 'ses_claude',
  projectID: 'project',
  directory: '/workspace',
  title: 'Claude session',
  cost: 0,
  tokens,
  time: { created: 1, updated: 1 },
  metadata: { openchamber: { backend: 'claude' } },
  model: { providerID: 'claude-code', id: 'opus' },
};

const openCodeSession: Session = {
  ...claudeSession,
  id: 'ses_opencode',
  title: 'OpenCode session',
  metadata: { openchamber: { backend: 'opencode' } },
  model: { providerID: 'openai', id: 'gpt-5' },
};

const sdk = OpenCode.make({
  baseUrl: 'https://sync.test',
  fetch: async (request) => {
    const path = new URL(request instanceof Request ? request.url : request.toString()).pathname;
    if (path.endsWith('/event')) {
      return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    }
    const body = path.endsWith('/location')
      ? { directory: '/workspace', project: { id: 'project', directory: '/workspace', canonical: '/workspace' } }
      : path.endsWith('/session/active') ? {}
      : { data: [] };
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  },
});

// SAFETY: Mounting reads only the runtime descriptor and the source-control
// object's identity; no runtime API method is invoked.
const runtimeAPIs = { runtime: { platform: 'web', isDesktop: false, isVSCode: false }, sourceControl: {} } as RuntimeAPIs;

const mountComposer = async (record: Session) => {
  useDirectoryStore.setState({ currentDirectory: '/workspace' });
  useSessionUIStore.setState({ currentSessionId: record.id, currentSessionDirectory: '/workspace' });
  useGlobalSessionsStore.setState({ entityById: new Map([[record.id, record]]) });

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <RuntimeAPIContext.Provider value={runtimeAPIs}>
        <ThemeSystemProvider>
          <I18nProvider>
            <SyncProvider sdk={sdk} directory="/workspace">
              <ChatInput />
            </SyncProvider>
          </I18nProvider>
        </ThemeSystemProvider>
      </RuntimeAPIContext.Provider>,
    );
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });

  const content = container.querySelector<HTMLElement>('.cm-content');
  const view = content ? EditorView.findFromDOM(content) : null;
  if (!view || !content) throw new Error('The composer editor did not mount');
  return {
    container,
    view,
    content,
    typeCharacter: async (character: string) => {
      await act(async () => {
        view.dispatch({ changes: { from: view.state.doc.length, insert: character }, userEvent: 'input.type' });
      });
    },
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
};

test('a leading `!` on a Claude session stays plain text and never enters shell mode', async () => {
  const composer = await mountComposer(claudeSession);
  try {
    // The keydown that opens shell mode elsewhere is not consumed here.
    const event = new KeyboardEvent('keydown', { key: '!', bubbles: true, cancelable: true });
    await act(async () => { composer.content.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(false);

    await composer.typeCharacter('!');
    expect(composer.view.state.doc.toString()).toBe('!');
    expect(composer.container.querySelector('.font-mono')).toBeNull();
  } finally {
    await composer.cleanup();
  }
});

test('a leading `!` on an OpenCode session still enters shell mode', async () => {
  const composer = await mountComposer(openCodeSession);
  try {
    await composer.typeCharacter('!');
    expect(composer.view.state.doc.toString()).toBe('');
    expect(composer.container.querySelector('.font-mono')).not.toBeNull();
  } finally {
    await composer.cleanup();
  }
});
