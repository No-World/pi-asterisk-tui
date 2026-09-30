import type { TUI } from "@earendil-works/pi-tui";
import { piVersionAtLeast } from "./utils.ts";

export const MIN_FULLSCREEN_WHEEL_SCROLL_LINES = 1;
export const MAX_FULLSCREEN_WHEEL_SCROLL_LINES = 10;
export const DEFAULT_FULLSCREEN_WHEEL_SCROLL_LINES = 4;

/** pi 0.99 ships fullscreenWheelScrollLines natively (public
 * TUI.setWheelScrollLines, "auto" acceleration, /settings entry) and re-applies
 * its own setting at startup and on settings changes — two owners of one knob
 * would fight. On such runtimes our setting stands down (ADR-0009). */
export function hasNativeFullscreenWheelScroll(): boolean {
	return piVersionAtLeast("0.99.0");
}

export function normalizeFullscreenWheelScrollLines(
	value: unknown,
	fallback = DEFAULT_FULLSCREEN_WHEEL_SCROLL_LINES,
): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(
		MAX_FULLSCREEN_WHEEL_SCROLL_LINES,
		Math.max(MIN_FULLSCREEN_WHEEL_SCROLL_LINES, Math.floor(value)),
	);
}

type FullscreenWheelTui = TUI & { wheelScrollLines?: unknown };

/**
 * Pi 0.84.2 keeps this constructor option in a private runtime field. Remove
 * this shim once Pi exposes a public setter; incompatible versions are no-ops.
 */
export function applyFullscreenWheelScrollLines(tui: TUI, value: number): boolean {
	if (hasNativeFullscreenWheelScroll()) return false; // native owns the knob
	try {
		const fullscreenTui = tui as FullscreenWheelTui;
		if (fullscreenTui.mode !== "fullscreen" || typeof fullscreenTui.wheelScrollLines !== "number") {
			return false;
		}
		return Reflect.set(fullscreenTui, "wheelScrollLines", normalizeFullscreenWheelScrollLines(value));
	} catch {
		return false;
	}
}
