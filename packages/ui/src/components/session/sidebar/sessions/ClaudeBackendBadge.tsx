import React from 'react';

import type { Session } from '@/lib/opencode/model';
import { useI18n } from '@/lib/i18n';
import { isClaudeBackendSession } from '@/lib/sessionBackend';
import { cn } from '@/lib/utils';

/**
 * Marks a session row whose session runs on the Claude Code backend.
 *
 * The backend is fixed at creation and carried on the session record's
 * metadata. OpenCode sessions stay unmarked, so the badge only ever says
 * "this row is different", never "this row is the normal case".
 */
export const ClaudeBackendBadge: React.FC<{
    session: Pick<Session, 'metadata'>;
    className?: string;
}> = ({ session, className }) => {
    const { t } = useI18n();
    if (!isClaudeBackendSession(session)) return null;
    const label = t('sessions.sidebar.session.backend.claude');
    return (
        <span
            className={cn('shrink-0 rounded bg-[var(--surface-subtle)] px-1 pb-px typography-micro leading-none text-muted-foreground', className)}
            title={label}
            aria-label={label}
        >
            Claude
        </span>
    );
};
