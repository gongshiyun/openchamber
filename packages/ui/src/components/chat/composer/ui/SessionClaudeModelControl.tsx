/**
 * The Claude model a running Claude session runs on.
 *
 * Replaces the OpenCode model/agent controls in the composer footer while a
 * Claude session is open. Picking an alias switches the session through the
 * SDK; the session record stays the source of truth, and the picked alias
 * stays on screen until the record catches up.
 */

import React from 'react';

import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { opencodeClient } from '@/lib/opencode/client';
import { CLAUDE_PROVIDER_ID, type ClaudeModelAlias } from '@/lib/sessionBackend';
import { ClaudeModelMenu } from './ClaudeModelMenu';

export const SessionClaudeModelControl: React.FC<{
    sessionId: string;
    directory?: string;
    model: ClaudeModelAlias;
}> = ({ sessionId, directory, model }) => {
    const { t } = useI18n();
    const [pendingModel, setPendingModel] = React.useState<ClaudeModelAlias | null>(null);

    // The server's model-switch event replaces the record; until it lands the
    // picked alias stays on screen.
    React.useEffect(() => {
        if (pendingModel !== null && model === pendingModel) setPendingModel(null);
    }, [model, pendingModel]);

    const handleSelect = React.useCallback(async (next: ClaudeModelAlias) => {
        if (next === model && pendingModel === null) return;
        setPendingModel(next);
        try {
            await opencodeClient.switchSessionModel(sessionId, { providerID: CLAUDE_PROVIDER_ID, id: next }, directory);
        } catch (error) {
            console.warn('[claude] Failed to switch the session model:', error);
            setPendingModel(null);
            toast.error(t('chat.chatInput.backend.switchFailed'));
        }
    }, [directory, model, pendingModel, sessionId, t]);

    return (
        <ClaudeModelMenu
            model={pendingModel ?? model}
            onSelect={handleSelect}
            ariaLabel={t('chat.chatInput.backend.claudeModelLabel')}
        />
    );
};
