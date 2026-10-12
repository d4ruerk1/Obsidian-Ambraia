import type { ProviderId } from './sync/providers';
import type { Alg, KdfType } from './sync/crypto';

/** One cloud service the vault is synced with. */
export interface SyncTarget {
	id: string;
	provider: ProviderId;
	/** Folder used on the cloud, e.g. "Ambraia/My vault". */
	folder: string;
	enabled: boolean;
	/** The cloud folder is expected to be end-to-end encrypted. */
	encrypt: boolean;
	alg: Alg;
	names: boolean;
	/** Keep the unlocked data key in the OS secret storage of this device. */
	remember: boolean;
	/** true = same master key as the other services, false = dedicated key. */
	sharedKey: boolean;
}
import type { AiModel } from './ai/providers';

export type AiMode = 'chat' | 'vault' | 'agent';

export interface Space {
	id: string;
	name: string;
	icon: string;
	items: string[];
	collapsed?: boolean;
}

export interface NavCustomButton {
	id: string;
	/** Lucide icon name. */
	icon: string;
	/** Command id (as in Obsidian's command palette). */
	command: string;
	label: string;
	/** Native button this one replaces (shown in its place). */
	replaces?: string;
}

export interface DbSavedConfig {
	[key: string]: unknown;
}

export interface AmbraiaSettings {
	// Aspetto
	notionTheme: boolean;
	/** Hides the properties block inside notes (CSS only; still editable in the side panel). */
	hideProperties: boolean;
	font: 'standard' | 'obsidian' | 'serif' | 'mono';
	contentWidth: 'normal' | 'wide' | 'full';
	showHeader: boolean;
	bannerHeight: number;
	iconKey: string;
	bannerKey: string;
	minimalUI: boolean;
	explorerIcons: boolean;
	/** Notes without an icon show one picked from their name. */
	autoIcons: boolean;
	/** The note menu (⋯ in the top right corner) shows only the essential actions. */
	compactNoteMenu: boolean;
	// Esplora file
	folderNotes: boolean;
	pinned: string[];
	spaces: Space[];
	icons: Record<string, string>;
	expanded: string[];
	/** The "New note" button of the file explorer opens a menu (note, canvas, daily note, template). */
	newNoteMenu: boolean;
	/** Native buttons of the file explorer toolbar hidden by the user (ids from navButtons.ts). */
	navHidden: string[];
	/** Extra buttons added to the file explorer toolbar: any command, with an icon. */
	navCustom: NavCustomButton[];
	/** Shortcut buttons added to the left ribbon (any command, with an icon). */
	ribbonCustom: NavCustomButton[];
	// Editor
	slashMenu: boolean;
	slashTrigger: string;
	selectionToolbar: boolean;
	imageToolbar: boolean;
	/** "@" opens the page picker and inserts a link. */
	mentions: boolean;
	/** Internal links show the page icon (emoji) and a page-link style. */
	linkIcons: boolean;
	/** Extra keyboard shortcuts inside the editor. */
	shortcuts: boolean;
	/** Images added through Ambraia are resized/re-encoded when that makes them smaller. */
	optimizeImages: boolean;
	// Database
	folderViews: Record<string, DbSavedConfig>;
	// Sync
	/** Cloud services kept in sync at the same time (per device: never overwritten by data.json from other devices). */
	syncTargets: SyncTarget[];
	/** Key derivation used for new master keys. */
	syncKdf: KdfType;
	language: string;
	pollSeconds: number;
	backgroundPollSeconds: number;
	pushDelayMs: number;
	syncConfigSettings: boolean;
	syncConfigAppearance: boolean;
	syncConfigPlugins: boolean;
	ignorePatterns: string;
	maxFileSizeMB: number;
	syncStatusBar: boolean;
	notifyConflicts: boolean;
	/** 'merge': one version in the cloud (edits combined / newer wins); 'copy': keep "(conflict)" copies. */
	conflictMode: 'merge' | 'copy';
	/** System notifications for sync problems while Obsidian is in the background. */
	notifySystem: boolean;
	// Shared links
	/** Page that opens shared links (static, it never receives the keys: they stay after "#"). */
	shareViewerUrl: string;
	/** ntfy-compatible relay used by live links. */
	shareRelayUrl: string;
	/** This device answers the live links of the vault while Obsidian is open. */
	shareServe: boolean;
	/** The user has read how live links use the relay. */
	shareRelayConsent: boolean;
	// Maintenance
	/** Space-saving clean-up already applied to this vault (version of the routine). */
	maintenanceVersion: number;
	// AI
	aiEnabled: boolean;
	aiModels: AiModel[];
	aiChatModel: string;
	aiEmbedding: { provider: string; model: string; baseUrl?: string } | null;
	aiProviderUrls: Record<string, string>;
	/** Legacy plaintext keys: moved to the secret storage at load. */
	aiKeysFallback?: Record<string, string>;
	aiTemperature: number;
	aiMaxTokens: number;
	aiSystemPrompt: string;
	aiDefaultMode: AiMode;
	aiIncludeActiveNote: boolean;
	aiWrites: 'ask' | 'auto' | 'never';
	aiPromptsFolder: string;
	aiChatsFolder: string;
	aiAutosave: boolean;
	aiExclude: string;
	aiRelevantNotes: boolean;
	aiHistoryTurns: number;
	aiVaultTopK: number;
	aiContextChars: number;
	// Advanced local tools
	aiWebSearch: 'off' | 'duckduckgo' | 'searxng';
	aiSearxngUrl: string;
	aiWebAccess: boolean;
	/** Marks notes written by the AI with an `ai-generated` / `ai-assisted` property (EU AI Act art. 50). */
	aiMarkOutput: boolean;
	aiMemory: boolean;
	aiMemoryFile: string;
	aiProjectsFolder: string;
	// Calendario
	calendarUseCoreDaily: boolean;
	dailyFolder: string;
	dailyFormat: string;
	dailyTemplate: string;
	weeklyNotes: boolean;
	weeklyFolder: string;
	weeklyFormat: string;
	weeklyTemplate: string;
	calendarWeekStart: 'locale' | 'monday' | 'sunday';
	calendarWeekNumbers: boolean;
	calendarDateFields: string;
	calendarShowTasks: boolean;
	calendarClickCreates: boolean;
	calendarOnStart: boolean;
}

export const DEFAULT_SETTINGS: AmbraiaSettings = {
	notionTheme: true,
	hideProperties: true,
	font: 'standard',
	contentWidth: 'normal',
	showHeader: true,
	bannerHeight: 200,
	iconKey: 'icon',
	bannerKey: 'banner',
	minimalUI: false,
	explorerIcons: true,
	autoIcons: false,
	compactNoteMenu: true,
	folderNotes: true,
	pinned: [],
	spaces: [],
	icons: {},
	expanded: [],
	newNoteMenu: true,
	navHidden: [],
	navCustom: [{ id: 'today', icon: 'calendar-check', command: 'ambraia:daily-today', label: 'Nota di oggi' }],
	ribbonCustom: [],
	slashMenu: true,
	slashTrigger: '/',
	selectionToolbar: true,
	imageToolbar: true,
	mentions: true,
	linkIcons: true,
	shortcuts: true,
	optimizeImages: true,
	folderViews: {},
	syncTargets: [],
	syncKdf: 'argon2id',
	language: 'auto',
	pollSeconds: 8,
	backgroundPollSeconds: 60,
	pushDelayMs: 1500,
	syncConfigSettings: true,
	syncConfigAppearance: true,
	syncConfigPlugins: true,
	ignorePatterns: '',
	maxFileSizeMB: 100,
	syncStatusBar: true,
	notifyConflicts: true,
	conflictMode: 'merge',
	notifySystem: true,
	shareViewerUrl: 'https://d4ruerk1.github.io/Obsidian-Ambraia/share/',
	shareRelayUrl: 'https://ntfy.sh',
	shareServe: true,
	shareRelayConsent: false,
	maintenanceVersion: 0,
	aiEnabled: false,
	aiModels: [],
	aiChatModel: '',
	aiEmbedding: null,
	aiProviderUrls: {},
	aiTemperature: 0.7,
	aiMaxTokens: 0,
	aiSystemPrompt: '',
	aiDefaultMode: 'chat',
	aiIncludeActiveNote: true,
	aiWrites: 'ask',
	aiPromptsFolder: 'Ambraia/Prompt',
	aiChatsFolder: 'Ambraia/Chat',
	aiAutosave: true,
	aiExclude: '',
	aiRelevantNotes: true,
	aiHistoryTurns: 12,
	aiVaultTopK: 8,
	aiContextChars: 16000,
	aiWebSearch: 'off',
	aiSearxngUrl: '',
	aiWebAccess: true,
	aiMarkOutput: true,
	aiMemory: false,
	aiMemoryFile: 'Ambraia/Memoria.md',
	aiProjectsFolder: 'Ambraia/Progetti',
	calendarUseCoreDaily: true,
	dailyFolder: '',
	dailyFormat: 'YYYY-MM-DD',
	dailyTemplate: '',
	weeklyNotes: false,
	weeklyFolder: '',
	weeklyFormat: 'gggg-[W]ww',
	weeklyTemplate: '',
	calendarWeekStart: 'locale',
	calendarWeekNumbers: false,
	calendarDateFields: 'data, date, scadenza, due',
	calendarShowTasks: true,
	calendarClickCreates: false,
	calendarOnStart: false,
};
