import { tx } from '../i18n';
export type ApiKind = 'openai' | 'anthropic';

export interface ProviderPreset {
	id: string;
	name: string;
	kind: ApiKind;
	baseUrl: string;
	needsKey: boolean;
	local?: boolean;
	keyUrl?: string;
	/** One-line description shown in the setup wizard. */
	hint: string;
	icon: string;
	/** Optional notes shown on the configuration step (one per line). */
	steps?: string[];
	supportsEmbeddings: boolean;
}

export const PRESETS: ProviderPreset[] = [
	{
		id: 'lmstudio',
		name: tx('LM Studio'),
		kind: 'openai',
		baseUrl: 'http://localhost:1234/v1',
		needsKey: false,
		local: true,
		icon: '🖥️',
		hint: tx('AI locale e gratuita sul tuo computer: i dati non escono dal dispositivo.'),
		steps: [
			tx('Apri LM Studio e scarica un modello (es. Qwen, Llama, Gemma, Mistral).'),
			tx('Vai nella scheda “Developer” e attiva “Start server” (porta 1234).'),
			tx('Da un altro dispositivo (es. telefono) usa l’indirizzo IP del computer al posto di localhost e attiva “Serve on Local Network”.'),
		],
		supportsEmbeddings: true,
	},
	{
		id: 'ollama',
		name: tx('Ollama'),
		kind: 'openai',
		baseUrl: 'http://localhost:11434/v1',
		needsKey: false,
		local: true,
		icon: '🦙',
		hint: tx('AI locale tramite Ollama.'),
		steps: [
			tx('Installa Ollama e scarica un modello, ad esempio: ollama pull llama3.2'),
			tx('Assicurati che Ollama sia in esecuzione (icona nella barra di sistema).'),
			tx('Per la ricerca semantica puoi scaricare anche: ollama pull nomic-embed-text'),
		],
		supportsEmbeddings: true,
	},
	{
		id: 'openai',
		name: 'OpenAI',
		kind: 'openai',
		baseUrl: 'https://api.openai.com/v1',
		needsKey: true,
		keyUrl: 'https://platform.openai.com/api-keys',
		icon: '🟢',
		hint: tx('Modelli GPT di OpenAI.'),
		supportsEmbeddings: true,
	},
	{
		id: 'anthropic',
		name: tx('Anthropic Claude'),
		kind: 'anthropic',
		baseUrl: 'https://api.anthropic.com/v1',
		needsKey: true,
		keyUrl: 'https://console.anthropic.com/settings/keys',
		icon: '🟠',
		hint: tx('Modelli Claude di Anthropic.'),
		supportsEmbeddings: false,
	},
	{
		id: 'gemini',
		name: tx('Google Gemini'),
		kind: 'openai',
		baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
		needsKey: true,
		keyUrl: 'https://aistudio.google.com/apikey',
		icon: '🔷',
		hint: tx('Modelli Gemini di Google (c’è un piano gratuito).'),
		supportsEmbeddings: true,
	},
	{
		id: 'openrouter',
		name: 'OpenRouter',
		kind: 'openai',
		baseUrl: 'https://openrouter.ai/api/v1',
		needsKey: true,
		keyUrl: 'https://openrouter.ai/keys',
		icon: '🔀',
		hint: tx('Centinaia di modelli con un’unica chiave.'),
		supportsEmbeddings: false,
	},
	{
		id: 'groq',
		name: tx('Groq'),
		kind: 'openai',
		baseUrl: 'https://api.groq.com/openai/v1',
		needsKey: true,
		keyUrl: 'https://console.groq.com/keys',
		icon: '⚡',
		hint: tx('Modelli open molto veloci.'),
		supportsEmbeddings: false,
	},
	{
		id: 'mistral',
		name: tx('Mistral'),
		kind: 'openai',
		baseUrl: 'https://api.mistral.ai/v1',
		needsKey: true,
		keyUrl: 'https://console.mistral.ai/api-keys',
		icon: '🌬️',
		hint: tx('Modelli Mistral (europei).'),
		supportsEmbeddings: true,
	},
	{
		id: 'deepseek',
		name: 'DeepSeek',
		kind: 'openai',
		baseUrl: 'https://api.deepseek.com/v1',
		needsKey: true,
		keyUrl: 'https://platform.deepseek.com/api_keys',
		icon: '🐋',
		hint: tx('Modelli DeepSeek, economici.'),
		supportsEmbeddings: false,
	},
	{
		id: 'xai',
		name: tx('xAI Grok'),
		kind: 'openai',
		baseUrl: 'https://api.x.ai/v1',
		needsKey: true,
		keyUrl: 'https://console.x.ai',
		icon: '✖️',
		hint: tx('Modelli Grok di xAI.'),
		supportsEmbeddings: false,
	},
	{
		id: 'custom',
		name: tx('Altro (compatibile OpenAI)'),
		kind: 'openai',
		baseUrl: 'http://localhost:8080/v1',
		needsKey: false,
		icon: '🔌',
		hint: tx('Qualsiasi server con API in formato OpenAI: llama.cpp, vLLM, Jan, LocalAI, LiteLLM, Azure…'),
		supportsEmbeddings: true,
	},
];

export function preset(id: string): ProviderPreset {
	return PRESETS.find((p) => p.id === id) ?? PRESETS[PRESETS.length - 1];
}

/** A model the user added (shown in the chat model picker). */
export interface AiModel {
	id: string;
	provider: string;
	model: string;
	/** Overrides the provider base URL (custom servers, LAN addresses). */
	baseUrl?: string;
	label?: string;
	/** Set automatically when the model rejects tool calls. */
	noTools?: boolean;
}

export function modelLabel(m: AiModel): string {
	return m.label || `${m.model} · ${preset(m.provider).name}`;
}

export function newModelId(): string {
	return Math.random().toString(36).slice(2, 10);
}

/** Heuristic: is this model id an embedding model? */
export function isEmbeddingModel(id: string): boolean {
	return /embed|bge-|e5-|gte-|nomic|minilm|arctic-embed/i.test(id);
}

export function normalizeBaseUrl(u: string): string {
	let s = u.trim().replace(/\/+$/, '');
	if (s && !/^[a-z]+:\/\//i.test(s)) s = 'http://' + s;
	return s.replace(/\/(chat\/completions|completions|messages|models)$/i, '');
}
