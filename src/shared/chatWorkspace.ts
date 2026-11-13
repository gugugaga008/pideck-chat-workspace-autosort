/** Host-owned settings: plugins may change only the enabled flag. */
export type ChatWorkspaceSettings = {
	enabled: boolean;
	/** Read-only host facts; no plugin-supplied paths are accepted. */
	rootPath?: string;
	supported?: boolean;
};

export type ChatWorkspaceSettingsUpdate = {
	enabled: boolean;
};

/** Optional plugin broker port; authorization is rechecked immediately before commit. */
export interface ChatWorkspaceSettingsPort {
	getSettings(): Promise<ChatWorkspaceSettings>;
	updateSettings(input: ChatWorkspaceSettingsUpdate, beforeAttempt?: () => boolean): Promise<ChatWorkspaceSettings>;
}
