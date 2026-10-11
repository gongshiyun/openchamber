/**
 * The permission mode a running Claude session runs with.
 *
 * Claude's own modes (default/acceptEdits/bypassPermissions) live in the
 * session metadata and change through the OpenChamber extension endpoint — not
 * the SDK. The session record stays the source of truth, and the picked mode
 * stays on screen until the record catches up.
 */

import React from 'react';

import { toast } from '@/components/ui';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { CLAUDE_PERMISSION_MODES, type ClaudePermissionMode } from '@/lib/sessionBackend';
import { ClaudeOptionMenu } from './ClaudeOptionMenu';

const PERMISSION_MODE_LABEL_KEYS = {
    default: 'chat.chatInput.backend.permissionMode.default',
    acceptEdits: 'chat.chatInput.backend.permissionMode.acceptEdits',
    bypassPermissions: 'chat.chatInput.backend.permissionMode.bypassPermissions',
} as const satisfies Record<ClaudePermissionMode, I18nKey>;

export const SessionClaudePermissionModeControl = React.memo(function SessionClaudePermissionModeControl({
    sessionId,
    directory,
    mode,
}: {
    sessionId: string;
    directory?: string;
    mode: ClaudePermissionMode;
}) {
    const { t } = useI18n();
    const [pendingMode, setPendingMode] = React.useState<ClaudePermissionMode | null>(null);

    // The metadata update replaces the record; until it lands the picked mode
    // stays on screen.
    React.useEffect(() => {
        if (pendingMode !== null && mode === pendingMode) setPendingMode(null);
    }, [mode, pendingMode]);

    const handleSelect = React.useCallback(async (next: ClaudePermissionMode) => {
        if (next === mode && pendingMode === null) return;
        setPendingMode(next);
        try {
            const response = await runtimeFetch(`/api/session/${encodeURIComponent(sessionId)}/permission-mode`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode: next }),
                directory,
            });
            if (!response.ok) throw new Error(`Permission mode request failed (${response.status})`);
        } catch (error) {
            console.warn('[claude] Failed to change the permission mode:', error);
            setPendingMode(null);
            toast.error(t('chat.chatInput.backend.permissionModeFailed'));
        }
    }, [directory, mode, pendingMode, sessionId, t]);

    const options = React.useMemo(
        () => CLAUDE_PERMISSION_MODES.map((value) => ({ value, label: t(PERMISSION_MODE_LABEL_KEYS[value]) })),
        [t],
    );

    return (
        <ClaudeOptionMenu
            value={pendingMode ?? mode}
            options={options}
            onSelect={handleSelect}
            ariaLabel={t('chat.chatInput.backend.permissionModeLabel')}
        />
    );
});
