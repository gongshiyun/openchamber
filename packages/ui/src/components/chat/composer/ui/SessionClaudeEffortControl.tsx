/**
 * The reasoning effort a running Claude session runs with.
 *
 * The level lives in the session metadata and changes through the OpenChamber
 * extension endpoint; `null` clears it. The server reads effort when a runner
 * starts, so the change applies from the session's next turn. The session
 * record stays the source of truth, and the picked level stays on screen until
 * the record catches up.
 */

import React from 'react';

import { toast } from '@/components/ui';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { CLAUDE_EFFORT_LEVELS, type ClaudeEffort } from '@/lib/sessionBackend';
import { ClaudeOptionMenu } from './ClaudeOptionMenu';

const EFFORT_LABEL_KEYS = {
    low: 'chat.chatInput.backend.effort.low',
    medium: 'chat.chatInput.backend.effort.medium',
    high: 'chat.chatInput.backend.effort.high',
    xhigh: 'chat.chatInput.backend.effort.xhigh',
    max: 'chat.chatInput.backend.effort.max',
} as const satisfies Record<ClaudeEffort, I18nKey>;

export const SessionClaudeEffortControl = React.memo(function SessionClaudeEffortControl({
    sessionId,
    directory,
    effort,
}: {
    sessionId: string;
    directory?: string;
    /** Null reads as unset, shown as the default option. */
    effort: ClaudeEffort | null;
}) {
    const { t } = useI18n();
    // Null is a real pending value (clearing the level), so the sentinel is the
    // wrapper, not the value.
    const [pending, setPending] = React.useState<{ value: ClaudeEffort | null } | null>(null);

    // The metadata update replaces the record; until it lands the picked level
    // stays on screen.
    React.useEffect(() => {
        if (pending !== null && effort === pending.value) setPending(null);
    }, [effort, pending]);

    const handleSelect = React.useCallback(async (next: ClaudeEffort | null) => {
        if (next === effort && pending === null) return;
        setPending({ value: next });
        try {
            const response = await runtimeFetch(`/api/session/${encodeURIComponent(sessionId)}/effort`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ effort: next }),
                directory,
            });
            if (!response.ok) throw new Error(`Effort request failed (${response.status})`);
        } catch (error) {
            console.warn('[claude] Failed to change the reasoning effort:', error);
            setPending(null);
            toast.error(t('chat.chatInput.backend.effortFailed'));
        }
    }, [directory, effort, pending, sessionId, t]);

    const options = React.useMemo<Array<{ value: ClaudeEffort | null; label: string }>>(
        () => [
            { value: null, label: t('chat.chatInput.backend.effort.default') },
            ...CLAUDE_EFFORT_LEVELS.map((value) => ({ value, label: t(EFFORT_LABEL_KEYS[value]) })),
        ],
        [t],
    );

    return (
        <ClaudeOptionMenu
            value={pending ? pending.value : effort}
            options={options}
            onSelect={handleSelect}
            ariaLabel={t('chat.chatInput.backend.effortLabel')}
        />
    );
});
