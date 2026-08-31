/**
 * Footer dispatcher — selects the active footer style.
 *
 * - "hud":     4-line claude-hud inspired layout (default)
 * - "classic": the original pi-open-tui starship-style footer
 *
 * Configure via /open-tui → Footer → Footer style.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OpenTuiConfig } from "./config.ts";
import type { FooterState, ModelMeta } from "./state.ts";
import { installHudFooter } from "./footer-hud.ts";
import { installClassicFooter } from "./footer-classic.ts";

export type { FooterHooks } from "./footer-hud.ts";

export function installFooter(
	ctx: ExtensionContext,
	getState: () => FooterState,
	getConfig: () => OpenTuiConfig,
	getModelMeta: () => ModelMeta,
	hooks: Parameters<typeof installHudFooter>[4] | Parameters<typeof installClassicFooter>[4],
): () => void {
	return getConfig().footerStyle === "classic"
		? installClassicFooter(ctx, getState, getConfig, getModelMeta, hooks)
		: installHudFooter(ctx, getState, getConfig, getModelMeta, hooks);
}
