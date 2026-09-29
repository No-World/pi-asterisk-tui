/**
 * Footer dispatcher — selects the active footer style.
 *
 * - "hud":     4-line claude-hud inspired layout (default)
 * - "classic": the original starship-style footer
 *
 * Configure via /*tui → Footer → Footer style.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OpenTuiConfig } from "./config.ts";
import type { InlineBorderContent } from "./editor.ts";
import type { FooterState, ModelMeta } from "./state.ts";
import { installHudFooter } from "./footer-hud.ts";
import { installClassicFooter } from "./footer-classic.ts";

export type { FooterHooks } from "./footer-hud.ts";

export interface FooterHandle {
	cleanup(): void;
	/** Inline footer provider (classic content in editor borders). The HUD
	 * footer cannot inline its four-line layout and reports disabled. */
	inline: InlineBorderContent;
}

export function installFooter(
	ctx: ExtensionContext,
	getState: () => FooterState,
	getConfig: () => OpenTuiConfig,
	getModelMeta: () => ModelMeta,
	hooks: Parameters<typeof installHudFooter>[4] | Parameters<typeof installClassicFooter>[4],
): FooterHandle {
	return getConfig().footerStyle === "classic"
		? installClassicFooter(ctx, getState, getConfig, getModelMeta, hooks)
		: installHudFooter(ctx, getState, getConfig, getModelMeta, hooks);
}
