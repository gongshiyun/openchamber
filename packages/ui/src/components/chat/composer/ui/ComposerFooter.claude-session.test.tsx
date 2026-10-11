import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { RuntimeAPIs } from '@/lib/api/types';
import type { ChildStoreManager } from '@/sync/child-store';
import type { Session } from '@/lib/opencode/model';
import type { PermissionMode } from '@/stores/utils/permissionAutoAccept';
import type { BtwSelection } from '@/stores/useBtwStore';

/**
 * Which model controls the desktop footer shows for an open session: a Claude
 * session picks its Claude alias in place of the OpenCode model/agent
 * controls, an OpenCode session keeps them.
 *
 * Everything is imported after the DOM is installed: base-ui and the sync
 * layer resolve window/document at module evaluation.
 */

const installDom = () => {
  const browser = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    localStorage: browser.localStorage,
    sessionStorage: browser.sessionStorage,
    Node: browser.Node,
    Text: browser.Text,
    Element: browser.Element,
    HTMLElement: browser.HTMLElement,
    Event: browser.Event,
    MouseEvent: browser.MouseEvent,
    KeyboardEvent: browser.KeyboardEvent,
    MutationObserver: browser.MutationObserver,
    ResizeObserver: browser.ResizeObserver,
    IntersectionObserver: browser.IntersectionObserver,
    matchMedia: browser.matchMedia.bind(browser),
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

const claudeRecord: Session = {
  id: 'ses_claude',
  projectID: 'project',
  directory: '/workspace',
  title: 'Claude session',
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
  metadata: { openchamber: { backend: 'claude', permissionMode: 'acceptEdits', effort: 'high' } },
  model: { providerID: 'claude-code', id: 'sonnet' },
};

const openCodeRecord: Session = {
  ...claudeRecord,
  id: 'ses_opencode',
  title: 'OpenCode session',
  metadata: { openchamber: { backend: 'opencode' } },
  model: { providerID: 'openai', id: 'gpt-5' },
};

type ChildStoreHolder = { current: ChildStoreManager | null };

const renderFooter = async (record: Session, options?: { pinnedSelection?: BtwSelection | null }) => {
  const restoreDom = installDom();
  const { act, useEffect } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { spyOn } = await import('bun:test');
  const { I18nProvider } = await import('@/lib/i18n');
  const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { SyncProvider, useChildStoreManager } = await import('@/sync/sync-context');
  const { OpenCode } = await import('@opencode/client');
  const { ComposerFooter } = await import('./ComposerFooter');
  const { useSessionUIStore } = await import('@/sync/session-ui-store');
  const { useDirectoryStore } = await import('@/stores/useDirectoryStore');

  // The sync layer reads through the runtime transport; keep it quiet and
  // answer the event stream so the provider settles.
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const path = new URL(input instanceof Request ? input.url : input.toString(), 'http://localhost/').pathname;
    if (path.endsWith('/event')) {
      return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } });
  });

  // The directory child store only exists once something demands it; the
  // footer reads the session from that store, so the demand stands in for the
  // production useSessionListSync owner.
  const childStoresHolder: ChildStoreHolder = { current: null };
  const ChildStoreHarness = () => {
    const childStores = useChildStoreManager();
    useEffect(() => {
      childStoresHolder.current = childStores;
      childStores.setBootstrapDemand('composer-footer-test', [
        { directory: '/workspace', priority: 'selected', reason: 'current-directory' },
      ]);
      return () => {
        childStoresHolder.current = null;
        childStores.clearBootstrapDemand('composer-footer-test');
      };
    }, [childStores]);
    return null;
  };

  const sdk = OpenCode.make({
    baseUrl: 'https://sync.test',
    fetch: async (request) => {
      const path = new URL(request instanceof Request ? request.url : request.toString()).pathname;
      if (path.endsWith('/event')) {
        return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } });
    },
  });

  // SAFETY: the footer only reads the runtime descriptor and the source
  // control object's identity; no runtime API method is invoked.
  const runtimeAPIs = { runtime: { platform: 'web', isDesktop: false, isVSCode: false }, sourceControl: {} } as RuntimeAPIs;
  const btwSelection: BtwSelection = { agent: undefined, model: null, variant: undefined };

  const originalSelection = useSessionUIStore.getState();
  useDirectoryStore.setState({ currentDirectory: '/workspace' });
  useSessionUIStore.setState({
    currentSessionId: record.id,
    currentSessionDirectory: '/workspace',
    newSessionDraft: { ...useSessionUIStore.getState().newSessionDraft, open: false },
  });

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(
    <RuntimeAPIContext.Provider value={runtimeAPIs}>
      <ThemeSystemProvider>
        <I18nProvider>
          <SyncProvider sdk={sdk} directory="/workspace">
            <ChildStoreHarness />
            <ComposerFooter
              isMobile={false}
              isVSCode={false}
              sessionId={record.id}
              directory="/workspace"
              newSessionDraftOpen={false}
              messageLength={0}
              radius="12px"
              footerPaddingClass="px-2.5 py-1.5"
              footerGapClass="gap-x-2"
              footerIconButtonClass="h-6 w-6"
              iconSizeClass="h-[18px] w-[18px]"
              sendIconSizeClass="h-4 w-4"
              stopIconSizeClass="h-5 w-5"
              canSend={false}
              canAbort={false}
              hasContent={false}
              isExpandedInput={false}
              permissionMode={'ask' satisfies PermissionMode}
              isPermissionAutoAcceptInteractive={false}
              dictationActive={false}
              onPickLocalFiles={() => undefined}
              onOpenGitHubPicker={() => undefined}
              onOpenAttachSheet={() => undefined}
              onToggleExpandedInput={() => undefined}
              onCyclePermissionMode={() => undefined}
              onPrimaryAction={() => undefined}
              onQueueMessage={() => undefined}
              onAbort={() => undefined}
              onStartDictation={() => undefined}
              onDictationInsert={() => undefined}
              onDictationInsertAndSend={() => undefined}
              onDictationSendStart={() => undefined}
              onDictationStart={() => undefined}
              onDictationContentHeightChange={() => undefined}
              btwSelection={btwSelection}
              pinnedSelection={options?.pinnedSelection}
              waitingForOpenCode={false}
            />
          </SyncProvider>
        </I18nProvider>
      </ThemeSystemProvider>
    </RuntimeAPIContext.Provider>,
  ));
  // Seed the session the directory store would hold after its bootstrap.
  await act(async () => {
    childStoresHolder.current?.getChild('/workspace')?.setState({ session: [record] });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const cleanup = async () => {
    await act(async () => root.unmount());
    useSessionUIStore.setState(originalSelection);
    fetchSpy.mockRestore();
    await restoreDom();
  };
  return { container, cleanup };
};

test('a Claude session shows the Claude model control and no OpenCode model/agent controls', async () => {
  const { container, cleanup } = await renderFooter(claudeRecord);
  try {
    const claudeControl = container.querySelector('[aria-label="Claude model"]');
    expect(claudeControl).not.toBeNull();
    expect(claudeControl?.textContent).toContain('Sonnet');
    expect(container.querySelector('.model-controls__model-trigger')).toBeNull();
    // The Claude session's own controls read the record's metadata.
    expect(container.querySelector('[aria-label="Permission mode"]')?.textContent).toContain('Accept edits');
    expect(container.querySelector('[aria-label="Reasoning effort"]')?.textContent).toContain('High');
  } finally {
    await cleanup();
  }
});

test('an OpenCode session keeps the OpenCode model controls', async () => {
  const { container, cleanup } = await renderFooter(openCodeRecord);
  try {
    expect(container.querySelector('[aria-label="Claude model"]')).toBeNull();
    expect(container.querySelector('[aria-label="Permission mode"]')).toBeNull();
    expect(container.querySelector('[aria-label="Reasoning effort"]')).toBeNull();
    expect(container.querySelector('.model-controls__model-trigger')).not.toBeNull();
  } finally {
    await cleanup();
  }
});

test('a pinned Claude session swaps its controls too', async () => {
  const { container, cleanup } = await renderFooter(claudeRecord, {
    pinnedSelection: { agent: 'build', model: { providerId: 'openai', modelId: 'gpt-5' }, variant: undefined },
  });
  try {
    expect(container.querySelector('[aria-label="Claude model"]')?.textContent).toContain('Sonnet');
    expect(container.querySelector('.model-controls__model-trigger')).toBeNull();
  } finally {
    await cleanup();
  }
});

/** The goal button's label depends on whether a checker model is available. */
const goalButton = (container: HTMLElement) => [...container.querySelectorAll('button')].find((button) => {
  const label = button.getAttribute('aria-label') ?? '';
  return label === 'Start a goal with the next message' || label.startsWith('Goals need a Small Model');
});

test('a Claude session offers no goal control; an OpenCode session keeps it', async () => {
  const claude = await renderFooter(claudeRecord);
  try {
    expect(goalButton(claude.container)).toBeUndefined();
  } finally {
    await claude.cleanup();
  }

  const opencode = await renderFooter(openCodeRecord);
  try {
    expect(goalButton(opencode.container)).toBeDefined();
  } finally {
    await opencode.cleanup();
  }
});
