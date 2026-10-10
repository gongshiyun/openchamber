// How the chat follows a live reply, and the rules that decide it.
//
// `glide` (the default) trails the growing tail with one native smooth scroll
// after another, which keeps the compositor producing frames for the whole
// reply. `burst` is an experiment: the viewport stands still while the tail
// grows past the visible end (under the floating composer, into the tail
// spacer that is there anyway), and once the hidden part reaches a couple of
// lines one glide goes to the true end. No space is added anywhere. Pure: no
// DOM, no React.

type FollowScrollMode = 'glide' | 'burst';

// Switch at runtime from DevTools, no rebuild and no UI:
//   localStorage.setItem('openchamber.experimental.followScroll', 'burst'); dispatchEvent(new Event('openchamber:follow-scroll-mode'))
// and back with removeItem(...) plus the same event. Another tab picks the
// change up through the `storage` event.
const FOLLOW_SCROLL_STORAGE_KEY = 'openchamber.experimental.followScroll';
const FOLLOW_SCROLL_MODE_EVENT = 'openchamber:follow-scroll-mode';

// A burst glide starts once this many lines of message text are hidden past
// the visible end, within these bounds.
const FOLLOW_BURST_HIDDEN_LINES = 2;
export const FOLLOW_BURST_HIDDEN_MIN_PX = 40;
export const FOLLOW_BURST_HIDDEN_MAX_PX = 80;

const readStoredMode = (): FollowScrollMode => {
    try {
        return globalThis.localStorage?.getItem(FOLLOW_SCROLL_STORAGE_KEY) === 'burst' ? 'burst' : 'glide';
    } catch {
        return 'glide';
    }
};

// Read once at startup and again only when told to: the follow path asks for
// the mode on every frame, so it must not reach localStorage.
let currentMode: FollowScrollMode = readStoredMode();
const browserWindow = globalThis.window;
if (browserWindow) {
    const refreshMode = () => {
        currentMode = readStoredMode();
    };
    browserWindow.addEventListener('storage', (event) => {
        if (event.key === null || event.key === FOLLOW_SCROLL_STORAGE_KEY) refreshMode();
    });
    browserWindow.addEventListener(FOLLOW_SCROLL_MODE_EVENT, refreshMode);
}

export const getFollowScrollMode = (): FollowScrollMode => currentMode;

export const resolveFollowBurstThresholdPx = (lineHeightPx: number): number => {
    const lines = Number.isFinite(lineHeightPx) && lineHeightPx > 0 ? lineHeightPx * FOLLOW_BURST_HIDDEN_LINES : 0;
    return Math.min(FOLLOW_BURST_HIDDEN_MAX_PX, Math.max(FOLLOW_BURST_HIDDEN_MIN_PX, Math.round(lines)));
};

// How long a just-issued follow glide counts as moving before it has moved:
// a smooth scroll starts a frame or two after it is issued.
export const GLIDE_START_GRACE_MS = 50;

interface FollowGlideProgress {
    // Scroll offset when last checked.
    readonly lastTop: number;
    readonly issuedAt: number;
    // The content end per the list's state when the glide was issued.
    readonly stateEnd: number;
}

/**
 * Whether a follow glide is still under way and should be left to finish,
 * decided from the list's state alone so these frames read no layout. A
 * plain glide is re-issued once the end moved on (re-issuing restarts the
 * animation, so only then); a burst glide runs to its end regardless.
 */
export const isFollowGlideUnderWay = (
    glide: FollowGlideProgress | null,
    stateScroll: number,
    stateEnd: number,
    burst: boolean,
    now: number,
): boolean => (
    glide !== null
    && (Math.abs(stateScroll - glide.lastTop) > 0.5 || now - glide.issuedAt < GLIDE_START_GRACE_MS)
    && (burst || Math.abs(glide.stateEnd - stateEnd) <= 1)
);

interface FollowGlideInput {
    // The true end, from the scroll node (the list's state can lag it).
    readonly end: number;
    readonly scroll: number;
    readonly burst: boolean;
    // How much of the tail may stay hidden in burst mode before a glide.
    readonly thresholdPx: number;
    // Just after a send: the sent row and the start of the reply are shown
    // whole, so burst holding does not apply yet.
    readonly afterSend: boolean;
}

/**
 * Where a follow glide should go, or null to hold still. The end is the true
 * end (the tail just above the composer, through the tail spacer). In burst
 * mode the tail may stay hidden past the visible end until the hidden part
 * reaches the threshold; then, as in plain mode, the glide goes to the end.
 */
export const resolveFollowGlideTarget = ({
    end,
    scroll,
    burst,
    thresholdPx,
    afterSend,
}: FollowGlideInput): number | null => {
    const hidden = end - scroll;
    if (hidden <= 1) return null;
    if (burst && !afterSend && hidden < thresholdPx) return null;
    return Math.max(0, end);
};

// Longer than any native smooth scroll runs: a movement issued longer ago no
// longer accounts for where the viewport is.
export const AUTOMATIC_MOVEMENT_MAX_MS = 1000;

interface AutomaticMovement {
    readonly from: number;
    readonly target: number;
    readonly issuedAt: number;
}

/**
 * Whether a scroll position is one an automatic follow movement (a follow
 * glide, plain or burst) is passing through: the view is
 * following, the movement is recent, and the position lies between where it
 * started and where it goes.
 */
export const isPositionHeldByFollow = (
    following: boolean,
    movement: AutomaticMovement | null,
    scrollTop: number,
    now: number,
): boolean => (
    following
    && movement !== null
    && now - movement.issuedAt < AUTOMATIC_MOVEMENT_MAX_MS
    && scrollTop >= Math.min(movement.from, movement.target) - 1
    && scrollTop <= Math.max(movement.from, movement.target) + 1
);

/**
 * Whether chrome that mirrors the reader's position (the recap hint) treats
 * the viewport as on the end. While an automatic follow movement is passing
 * through the viewport's position it is, whatever the momentary distance:
 * text arrives ahead of the glide, and measuring then flips the answer
 * several times a second. Any other scroll (a gesture, the scrollbar thumb,
 * find in page) is measured; a held position is not measured at all.
 */
export const resolveViewportAtEnd = (heldByFollow: boolean, measureAtEnd: () => boolean): boolean => (
    heldByFollow || measureAtEnd()
);
