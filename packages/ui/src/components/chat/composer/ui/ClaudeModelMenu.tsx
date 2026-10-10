/**
 * The Claude model picker, shared by the draft backend control and a running
 * Claude session's composer control: one trigger showing the selected alias
 * and a menu of the static alias list.
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
import { CLAUDE_MODEL_ALIASES, type ClaudeModelAlias } from '@/lib/sessionBackend';

/** Chrome-less trigger chrome shared with the composer's other value pickers. */
export const claudeMenuTriggerClassName = 'normal-case px-1.5 hover:bg-transparent data-[popup-open]:bg-transparent';

const modelLabel = (alias: ClaudeModelAlias) => alias.charAt(0).toUpperCase() + alias.slice(1);

export const ClaudeMenuCheck: React.FC<{ selected: boolean }> = ({ selected }) => (
    selected ? <Icon name="check" className="size-4 shrink-0 text-muted-foreground" /> : null
);

export const ClaudeModelMenu: React.FC<{
    model: ClaudeModelAlias;
    onSelect: (model: ClaudeModelAlias) => void;
    ariaLabel: string;
}> = ({ model, onSelect, ariaLabel }) => (
    <DropdownMenu>
        <DropdownMenuTrigger asChild>
            <Button
                variant="ghost"
                size="sm"
                className={claudeMenuTriggerClassName}
                aria-label={ariaLabel}
            >
                <span className="truncate">{modelLabel(model)}</span>
                <Icon name="arrow-down-s" className="size-3.5 shrink-0 opacity-60" />
            </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="min-w-36">
            {CLAUDE_MODEL_ALIASES.map((alias) => (
                <DropdownMenuItem
                    key={alias}
                    className="typography-meta"
                    onSelect={() => onSelect(alias)}
                >
                    <div className="flex w-full min-w-0 items-center justify-between gap-2">
                        <span className="truncate font-medium text-foreground">{modelLabel(alias)}</span>
                        <ClaudeMenuCheck selected={model === alias} />
                    </div>
                </DropdownMenuItem>
            ))}
        </DropdownMenuContent>
    </DropdownMenu>
);
