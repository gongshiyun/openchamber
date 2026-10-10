import { describe, expect, test } from 'bun:test';

import {
    AUTOMATIC_MOVEMENT_MAX_MS,
    FOLLOW_BURST_HIDDEN_MAX_PX,
    FOLLOW_BURST_HIDDEN_MIN_PX,
    GLIDE_START_GRACE_MS,
    isFollowGlideUnderWay,
    isPositionHeldByFollow,
    resolveFollowGlideTarget,
    resolveFollowBurstThresholdPx,
    resolveViewportAtEnd,
} from './followScroll';

// 16px root font, leading-relaxed.
const thresholdPx = resolveFollowBurstThresholdPx(16 * 1.625);

describe('resolveFollowBurstThresholdPx', () => {
    test('is two lines of message text', () => {
        expect(thresholdPx).toBe(52);
    });

    test('stays within its bounds', () => {
        expect(resolveFollowBurstThresholdPx(10)).toBe(FOLLOW_BURST_HIDDEN_MIN_PX);
        expect(resolveFollowBurstThresholdPx(60)).toBe(FOLLOW_BURST_HIDDEN_MAX_PX);
        expect(resolveFollowBurstThresholdPx(0)).toBe(FOLLOW_BURST_HIDDEN_MIN_PX);
        expect(resolveFollowBurstThresholdPx(Number.NaN)).toBe(FOLLOW_BURST_HIDDEN_MIN_PX);
    });
});

describe('resolveFollowGlideTarget', () => {
    const target = (scroll: number, end: number, burst: boolean, afterSend = false) => resolveFollowGlideTarget({
        end,
        scroll,
        burst,
        thresholdPx,
        afterSend,
    });

    test('plain follow glides to the true end whenever any of it is hidden', () => {
        expect(target(5000, 5000, false)).toBeNull();
        expect(target(5000, 5001, false)).toBeNull();
        expect(target(5000, 5010, false)).toBe(5010);
    });

    test('burst holds while less than the threshold is hidden, then glides to the true end', () => {
        expect(target(5000, 5000 + thresholdPx - 1, true)).toBeNull();
        expect(target(5000, 5000 + thresholdPx, true)).toBe(5000 + thresholdPx);
        expect(target(5000, 5300, true)).toBe(5300);
    });

    test('right after a send burst shows the sent row whole like the plain follow', () => {
        expect(target(5000, 5010, true, true)).toBe(5010);
        expect(target(5000, 5001, true, true)).toBeNull();
    });
});

describe('isFollowGlideUnderWay', () => {
    const glide = { lastTop: 1000, issuedAt: 0, stateEnd: 1400 };

    test('a glide still moving toward an unchanged end is left to finish', () => {
        expect(isFollowGlideUnderWay(glide, 1100, 1400, false, 500)).toBe(true);
        // Not moved yet, but only just issued.
        expect(isFollowGlideUnderWay(glide, 1000, 1400, false, GLIDE_START_GRACE_MS - 1)).toBe(true);
    });

    test('a plain glide is re-aimed once the end moved on; a burst glide runs on', () => {
        expect(isFollowGlideUnderWay(glide, 1100, 1450, false, 500)).toBe(false);
        expect(isFollowGlideUnderWay(glide, 1100, 1450, true, 500)).toBe(true);
    });

    test('a glide that stopped is checked against the true end again', () => {
        // Stopped short where it landed: the scroll no longer moves.
        expect(isFollowGlideUnderWay(glide, 1000, 1400, false, 500)).toBe(false);
        expect(isFollowGlideUnderWay(glide, 1000, 1400, true, 500)).toBe(false);
        expect(isFollowGlideUnderWay(null, 1100, 1400, false, 500)).toBe(false);
    });
});

describe('isPositionHeldByFollow', () => {
    const glide = { from: 1000, target: 1400, issuedAt: 0 };

    test('holds positions a recent follow glide passes through', () => {
        expect(isPositionHeldByFollow(true, glide, 1000, 100)).toBe(true);
        expect(isPositionHeldByFollow(true, glide, 1200, 100)).toBe(true);
        expect(isPositionHeldByFollow(true, glide, 1400, 100)).toBe(true);
    });

    test('measures a scroll the glide does not account for', () => {
        // The thumb or find in page took the viewport above the glide.
        expect(isPositionHeldByFollow(true, glide, 600, 100)).toBe(false);
        // A glide long finished explains nothing.
        expect(isPositionHeldByFollow(true, glide, 1400, AUTOMATIC_MOVEMENT_MAX_MS)).toBe(false);
        expect(isPositionHeldByFollow(true, null, 1400, 100)).toBe(false);
        // The reader took the scroll.
        expect(isPositionHeldByFollow(false, glide, 1200, 100)).toBe(false);
    });
});

describe('resolveViewportAtEnd', () => {
    test('stays at the end for a held position, without measuring', () => {
        let measured = 0;
        const measureAway = () => { measured += 1; return false; };
        expect(resolveViewportAtEnd(true, measureAway)).toBe(true);
        expect(measured).toBe(0);
    });

    test('takes the measured answer otherwise', () => {
        expect(resolveViewportAtEnd(false, () => false)).toBe(false);
        expect(resolveViewportAtEnd(false, () => true)).toBe(true);
    });
});
