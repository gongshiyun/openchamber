import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import type { Session, UserMessage } from '@/lib/opencode/model';
import { I18nProvider } from '@/lib/i18n';
import { dict as en } from '@/lib/i18n/messages/en';
import { SyncProvider } from '@/sync/sync-context';
import { getSyncChildStores } from '@/sync/sync-refs';
import { SessionErrorNotice } from './SessionErrorNotice';

/**
 * The session error notice in each backend's name: a Claude session reports a
 * stopped turn as Claude Code and offers no OpenCode status button; an
 * OpenCode session keeps its wording and button.
 */

const directory = '/repo';
const sessionId = 'ses_error';

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
  outcome: 'interrupted',
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

const DOM_GLOBAL_NAMES = ['window', 'document', 'navigator', 'Node', 'Text', 'Element', 'HTMLElement', 'localStorage', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT'] as const;

const installDom = () => {
  const win = new Window({ url: 'http://localhost' });
  const previous = DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const values = {
    window: win, document: win.document, navigator: win.navigator, Node: win.Node, Text: win.Text,
    Element: win.Element, HTMLElement: win.HTMLElement, localStorage: win.localStorage,
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

describe('SessionErrorNotice backend wording', () => {
  let root: Root;
  let dom: ReturnType<typeof installDom>;
  // Bootstrap stays pending, so each test owns the directory store's contents.
  const sdk = OpenCode.make({ baseUrl: 'http://notice.test', fetch: () => new Promise<Response>(() => undefined) });

  const stage = (record: Session) => act(async () => {
    const store = getSyncChildStores().getChild(directory);
    if (!store) throw new Error('Expected mounted directory store');
    store.setState({
      session: [record],
      message: { [sessionId]: [userMessage] },
      part: {},
      session_status: { [sessionId]: { type: 'idle' } },
      sessionStatusReady: true,
    });
  });

  const statusButtons = () => [...dom.container.querySelectorAll('button')]
    .filter((button) => button.textContent === en['chat.sessionError.showStatus']);

  beforeEach(async () => {
    dom = installDom();
    root = createRoot(dom.container);
    await act(async () => root.render(
      <I18nProvider>
        <SyncProvider sdk={sdk} directory={directory}>
          <SessionErrorNotice sessionId={sessionId} directory={directory} />
        </SyncProvider>
      </I18nProvider>,
    ));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    dom.restore();
  });

  test('a Claude session reports the stop as Claude Code and hides the status button', async () => {
    await stage(claudeSession);
    expect(dom.container.textContent).toContain(en['chat.sessionError.claude.interrupted']);
    expect(dom.container.textContent).toContain(en['chat.sessionError.claude.noDetails']);
    expect(dom.container.textContent).not.toContain(en['chat.sessionError.interrupted']);
    expect(statusButtons()).toHaveLength(0);
  });

  test('an OpenCode session keeps its wording and status button', async () => {
    await stage(openCodeSession);
    expect(dom.container.textContent).toContain(en['chat.sessionError.interrupted']);
    expect(dom.container.textContent).toContain(en['chat.sessionError.noDetails']);
    expect(dom.container.textContent).not.toContain(en['chat.sessionError.claude.interrupted']);
    expect(statusButtons()).toHaveLength(1);
  });
});
