/**
 * A Claude composer value picker: one trigger showing the selected option and a
 * menu of options with a check. Shared by the permission-mode and effort
 * controls, next to the Claude model picker (ClaudeModelMenu), which keeps its
 * own bespoke alias list.
 *
 * The option list is data: labels are resolved by the caller with `t(...)`, so
 * a locale switch re-renders them like every other composer string.
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
import { ClaudeMenuCheck, claudeMenuTriggerClassName } from './ClaudeModelMenu';

export type ClaudeOption<T extends string | null> = {
    value: T;
    label: string;
};

export function ClaudeOptionMenu<T extends string | null>({
    value,
    options,
    onSelect,
    ariaLabel,
}: {
    value: T;
    options: ReadonlyArray<ClaudeOption<T>>;
    onSelect: (value: T) => void;
    ariaLabel: string;
}) {
    const selectedLabel = options.find((option) => option.value === value)?.label ?? '';
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="ghost"
                    size="sm"
                    className={claudeMenuTriggerClassName}
                    aria-label={ariaLabel}
                >
                    <span className="truncate">{selectedLabel}</span>
                    <Icon name="arrow-down-s" className="size-3.5 shrink-0 opacity-60" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="min-w-36">
                {options.map((option) => (
                    <DropdownMenuItem
                        key={option.value ?? 'unset'}
                        className="typography-meta"
                        onSelect={() => onSelect(option.value)}
                    >
                        <div className="flex w-full min-w-0 items-center justify-between gap-2">
                            <span className="truncate font-medium text-foreground">{option.label}</span>
                            <ClaudeMenuCheck selected={option.value === value} />
                        </div>
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
