import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import type { AssistantMessage, Message, Part, Session, UserMessage } from '@/lib/opencode/model';
import { I18nProvider } from '@/lib/i18n';
import { dict as en } from '@/lib/i18n/messages/en';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { SyncProvider } from '@/sync/sync-context';
import { getSyncChildStores } from '@/sync/sync-refs';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { StatusRowContainer } from './StatusRowContainer';

/**
 * The composer status row for a cold-starting Claude session: busy with no
 * assistant parts yet must say "Claude Code is starting…" instead of a generic
 * working phrase, and an OpenCode session must keep its own generic phrase.
 */

const directory = '/repo';
const sessionId = 'ses_status';

const claudeSession: Session = {
  id: sessionId,
  projectID: 'project',
  directory,
  title: 'Claude session',
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
  metadata: { openchamber: { backend: 'claude' } },
  model: { providerID: 'claude-code', id: 'opus' },
};

const openCodeSession: Session = {
  ...claudeSession,
  title: 'OpenCode session',
  metadata: { openchamber: { backend: 'opencode' } },
  model: { providerID: 'openai', id: 'gpt-5' },
};

const userMessage: UserMessage = {
  id: 'msg_user',
  sessionID: sessionId,
  role: 'user',
  time: { created: 1 },
};

const assistantMessage: AssistantMessage = {
  id: 'msg_assistant',
  sessionID: sessionId,
  role: 'assistant',
  agent: 'claude',
  providerID: 'claude-code',
  modelID: 'opus',
  time: { created: 2 },
};

const textPart: Part = {
  id: 'prt_1',
  sessionID: sessionId,
  messageID: assistantMessage.id,
  type: 'text',
  text: 'Working on it',
};

const DOM_GLOBAL_NAMES = [
  'window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'Node', 'Text', 'Element', 'HTMLElement',
  'Event', 'MouseEvent', 'KeyboardEvent', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver',
  'matchMedia', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT',
] as const;

const installDom = () => {
  const win = new Window({ url: 'http://localhost' });
  const previous = DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const values = {
    window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage,
    sessionStorage: win.sessionStorage, Node: win.Node, Text: win.Text, Element: win.Element,
    HTMLElement: win.HTMLElement, Event: win.Event, MouseEvent: win.MouseEvent, KeyboardEvent: win.KeyboardEvent,
    MutationObserver: win.MutationObserver, ResizeObserver: win.ResizeObserver,
    IntersectionObserver: win.IntersectionObserver, matchMedia: win.matchMedia.bind(win),
    getComputedStyle: win.getComputedStyle.bind(win), requestAnimationFrame: win.requestAnimationFrame.bind(win),
    cancelAnimationFrame: win.cancelAnimationFrame.bind(win), IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const name of DOM_GLOBAL_NAMES) {
    Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  return {
    container,
    restore: () => {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
      void win.happyDOM.close();
    },
  };
};

describe('StatusRowContainer Claude cold start', () => {
  let root: Root;
  let dom: ReturnType<typeof installDom>;
  let fetchSpy: ReturnType<typeof spyOn>;
  const originalSelection = useSessionUIStore.getState();
  // Bootstrap stays pending, so each test owns the directory store's contents.
  const sdk = OpenCode.make({ baseUrl: 'http://status.test', fetch: () => new Promise<Response>(() => undefined) });

  const store = () => {
    const result = getSyncChildStores().getChild(directory);
    if (!result) throw new Error('Expected mounted directory store');
    return result;
  };

  const stage = (record: Session, state: {
    messages: Message[];
    parts?: Record<string, Part[]>;
    busy?: boolean;
  }) => act(async () => {
    store().setState({
      session: [record],
      message: { [sessionId]: state.messages },
      part: state.parts ?? {},
      session_status: { [sessionId]: { type: state.busy === false ? 'idle' : 'busy' } },
      sessionStatusReady: true,
    });
  });

  beforeEach(async () => {
    dom = installDom();
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const path = new URL(input instanceof Request ? input.url : input.toString(), 'http://localhost/').pathname;
      if (path.endsWith('/event')) {
        return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } });
    });
    useSessionUIStore.setState({ currentSessionId: sessionId, currentSessionDirectory: directory });
    root = createRoot(dom.container);
    await act(async () => root.render(
      <ThemeSystemProvider>
        <I18nProvider>
          <SyncProvider sdk={sdk} directory={directory}>
            <StatusRowContainer />
          </SyncProvider>
        </I18nProvider>
      </ThemeSystemProvider>,
    ));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    useSessionUIStore.setState(originalSelection);
    fetchSpy.mockRestore();
    dom.restore();
  });

  test('a busy Claude session with no assistant parts yet shows the starting hint', async () => {
    await stage(claudeSession, { messages: [userMessage] });
    expect(dom.container.textContent).toContain(en['chat.composerStatus.claudeStarting']);
    // The hint is a complete message, not a status the model name prefixes.
    expect(dom.container.textContent).not.toContain(`Opus is ${en['chat.composerStatus.claudeStarting']}`);
  });

  test('a busy OpenCode session keeps the generic working status', async () => {
    await stage(openCodeSession, { messages: [userMessage] });
    expect(dom.container.textContent).not.toContain(en['chat.composerStatus.claudeStarting']);
    expect(dom.container.textContent?.trim().length).toBeGreaterThan(0);
  });

  test('a Claude session whose newest assistant message has parts drops the hint', async () => {
    await stage(claudeSession, {
      messages: [userMessage, assistantMessage],
      parts: { [assistantMessage.id]: [textPart] },
    });
    expect(dom.container.textContent).not.toContain(en['chat.composerStatus.claudeStarting']);
    expect(dom.container.textContent?.trim().length).toBeGreaterThan(0);
  });

  test('an idle Claude session shows no starting hint', async () => {
    await stage(claudeSession, { messages: [userMessage], busy: false });
    expect(dom.container.textContent).not.toContain(en['chat.composerStatus.claudeStarting']);
    expect(dom.container.textContent?.trim()).toBe('');
  });
});
