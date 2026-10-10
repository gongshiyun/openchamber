/**
 * The backend a new session will run on, and — when Claude Code is chosen —
 * the Claude model alias it starts on.
 *
 * Draft-only: an existing session's backend is fixed at creation, and its
 * composer uses SessionClaudeModelControl instead. Desktop composer footer
 * only (the mobile control cluster is out of v1 scope), next to the model
 * controls it replaces while Claude is selected.
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useI18n } from '@/lib/i18n';
import { DEFAULT_CLAUDE_MODEL } from '@/lib/sessionBackend';
import { cn } from '@/lib/utils';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { ClaudeMenuCheck, ClaudeModelMenu, claudeMenuTriggerClassName } from './ClaudeModelMenu';

/** Product names stay literal in every locale. */
const BACKEND_LABELS = { opencode: 'OpenCode', claude: 'Claude Code' } as const;

function DraftBackendControlsView({ className }: { className?: string }) {
    const { t } = useI18n();
    const claudeBackend = useSessionUIStore((state) => state.newSessionDraft.claudeBackend);
    const setDraftClaudeBackend = useSessionUIStore((state) => state.setDraftClaudeBackend);
    const backend = claudeBackend ? 'claude' : 'opencode';

    return (
        <div className={cn('flex flex-shrink-0 items-center gap-x-1', className)}>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button
                        variant="ghost"
                        size="sm"
                        className={claudeMenuTriggerClassName}
                        aria-label={t('chat.chatInput.backend.label')}
                    >
                        <span className="truncate">{BACKEND_LABELS[backend]}</span>
                        <Icon name="arrow-down-s" className="size-3.5 shrink-0 opacity-60" />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="start" className="min-w-40">
                    {(['opencode', 'claude'] as const).map((option) => (
                        <DropdownMenuItem
                            key={option}
                            className="typography-meta"
                            onSelect={() => setDraftClaudeBackend(
                                option === 'claude' ? { model: claudeBackend?.model ?? DEFAULT_CLAUDE_MODEL } : null,
                            )}
                        >
                            <div className="flex w-full min-w-0 items-center justify-between gap-2">
                                <span className="truncate font-medium text-foreground">{BACKEND_LABELS[option]}</span>
                                <ClaudeMenuCheck selected={backend === option} />
                            </div>
                        </DropdownMenuItem>
                    ))}
                </DropdownMenuContent>
            </DropdownMenu>
            {claudeBackend ? (
                <ClaudeModelMenu
                    model={claudeBackend.model}
                    onSelect={(model) => setDraftClaudeBackend({ model })}
                    ariaLabel={t('chat.chatInput.backend.claudeModelLabel')}
                />
            ) : null}
        </div>
    );
}

/** Memoized: the composer re-renders on every keystroke, and nothing here depends on the draft text. */
export const DraftBackendControls = React.memo(DraftBackendControlsView);
