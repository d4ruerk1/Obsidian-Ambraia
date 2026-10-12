import { Modal, Notice, setIcon } from 'obsidian';
import type AmbraiaPlugin from '../main';
import { BRANDS } from '../ui/brandData';
import { brandBadge } from '../ui/brands';
import { isEmbeddingModel, normalizeBaseUrl, PRESETS, ProviderPreset } from './providers';
import { tx } from '../i18n';

/** Marker of a successful test (never shown). */
const OK = '\u0000ok:';

/**
 * Three-step wizard: 1) pick a provider  2) URL / API key  3) pick the model, save and test.
 * Designed so a local server (LM Studio, Ollama) works with zero typing.
 */
export class AiSetupModal extends Modal {
	private p: ProviderPreset | null = null;
	private url = '';
	private key = '';
	private models: string[] = [];
	private chosen = '';
	private embedding = '';
	private filter = '';

	constructor(
		private plugin: AmbraiaPlugin,
		private onDone?: () => void,
		providerId?: string,
	) {
		super(plugin.app);
		if (providerId) this.choose(PRESETS.find((x) => x.id === providerId) ?? null);
	}

	onOpen() {
		this.modalEl.addClass('ambraia-ai-setup');
		if (this.p) this.stepConnect();
		else this.stepProvider();
	}

	onClose() {
		this.contentEl.empty();
	}

	private choose(p: ProviderPreset | null) {
		this.p = p;
		if (!p) return;
		this.url = this.plugin.ai.baseUrlFor(p.id);
		this.key = this.plugin.ai.getKey(p.id);
		this.models = [];
		this.chosen = '';
		this.embedding = '';
		this.filter = '';
	}

	private header(step: number, title: string) {
		this.titleEl.setText(tx('Configura Ambraia AI'));
		const c = this.contentEl;
		c.empty();
		const dots = c.createDiv('ambraia-ai-steps');
		[tx('Servizio'), tx('Connessione'), tx('Modello')].forEach((s, i) => dots.createSpan({ cls: 'ambraia-ai-step' + (i + 1 === step ? ' is-active' : i + 1 < step ? ' is-done' : ''), text: `${i + 1}. ${s}` }));
		c.createEl('h3', { text: title });
		return c;
	}

	// ---------------------------------------------------------------- step 1

	stepProvider() {
		const c = this.header(1, tx('Quale AI vuoi usare?'));
		c.createEl('p', { cls: 'setting-item-description', text: tx('Puoi aggiungere altri modelli in qualsiasi momento e sceglierli dalla chat.') });
		const groups: [string, ProviderPreset[]][] = [
			[tx('Locale (privata, gratuita)'), PRESETS.filter((p) => p.local)],
			[tx('Cloud (serve una chiave API)'), PRESETS.filter((p) => !p.local && p.id !== 'custom')],
			[tx('Altro'), PRESETS.filter((p) => p.id === 'custom')],
		];
		for (const [label, list] of groups) {
			c.createDiv({ cls: 'ambraia-ai-group', text: label });
			const grid = c.createDiv('ambraia-ai-cards');
			for (const p of list) {
				const card = grid.createEl('button', { cls: 'ambraia-ai-card', attr: { 'data-provider': p.id } });
				const ic = card.createSpan({ cls: 'ambraia-ai-card-icon' });
				if (BRANDS[p.id]) {
					ic.addClass('has-mark');
					brandBadge(ic, p.id, p.name, '');
				} else if (p.local || p.id === 'custom') setIcon(ic, p.local ? 'hard-drive' : 'plug');
				else ic.setText(p.name.charAt(0).toUpperCase());
				const t = card.createDiv('ambraia-ai-card-text');
				t.createDiv({ cls: 'ambraia-ai-card-name', text: p.name });
				t.createDiv({ cls: 'ambraia-ai-card-hint', text: p.hint });
				if (this.plugin.settings.aiModels.some((m) => m.provider === p.id)) card.createSpan({ cls: 'ambraia-ai-badge', text: tx('Configurato') });
				card.onclick = () => {
					this.choose(p);
					this.stepConnect();
				};
			}
		}
	}

	// ---------------------------------------------------------------- step 2

	stepConnect(error = '') {
		const p = this.p!;
		const c = this.header(2, p.name);
		c.createEl('p', { cls: 'setting-item-description', text: p.hint });
		if (p.steps?.length) {
			const ol = c.createEl('ol', { cls: 'ambraia-ai-howto' });
			for (const s of p.steps) ol.createEl('li', { text: s });
		}
		const form = c.createDiv('ambraia-ai-form');
		const field = (label: string, desc: string) => {
			const row = form.createDiv('ambraia-ai-field');
			row.createEl('label', { text: label });
			if (desc) row.createDiv({ cls: 'setting-item-description', text: desc });
			return row;
		};
		const showUrl = p.local || p.id === 'custom';
		let urlIn: HTMLInputElement | null = null;
		const urlRow = field(tx('Indirizzo del server'), p.id === 'custom' ? tx('Qualsiasi server compatibile OpenAI (vLLM, llama.cpp, Jan, LocalAI, LiteLLM…), es. http://localhost:8080/v1') : tx('Di solito non va cambiato. Da un altro dispositivo usa l’IP del computer, es. http://192.168.1.10:1234/v1'));
		urlIn = urlRow.createEl('input', { type: 'text', value: this.url, attr: { placeholder: p.baseUrl || 'http://localhost:8080/v1', spellcheck: 'false' } });
		urlIn.oninput = () => (this.url = urlIn.value);
		if (!showUrl) {
			const adv = form.createEl('details', { cls: 'ambraia-ai-adv' });
			adv.createEl('summary', { text: tx('Avanzate: indirizzo personalizzato (proxy, Azure, gateway)') });
			adv.appendChild(urlRow);
		}
		if (p.needsKey || p.id === 'custom') {
			const keyRow = field(p.needsKey ? tx('Chiave API') : tx('Chiave API (facoltativa)'), tx('Salvata nel portachiavi sicuro di Obsidian, non nelle note e non sincronizzata.'));
			const wrap = keyRow.createDiv('ambraia-ai-keywrap');
			const keyIn = wrap.createEl('input', { type: 'password', value: this.key, attr: { placeholder: tx('sk-…'), autocomplete: 'off', spellcheck: 'false' } });
			keyIn.oninput = () => (this.key = keyIn.value.trim());
			const eye = wrap.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Mostra/nascondi' } });
			setIcon(eye, 'eye');
			eye.onclick = () => (keyIn.type = keyIn.type === 'password' ? 'text' : 'password');
			if (p.keyUrl) {
				const a = keyRow.createEl('a', { text: tx('Ottieni una chiave su {0}', p.name), href: p.keyUrl });
				a.setAttr('target', '_blank');
			}
		}
		if (error) {
			const e = c.createDiv('ambraia-ai-error');
			e.setText(error);
		}
		const manual = c.createDiv('ambraia-ai-manual');
		manual.createSpan({ text: tx('Conosci già il nome del modello? ') });
		const manIn = manual.createEl('input', { type: 'text', attr: { placeholder: tx('es. gpt-4o-mini, qwen2.5-7b-instruct') } });
		const bar = c.createDiv('ambraia-ai-bar');
		const back = bar.createEl('button', { text: tx('← Indietro') });
		back.onclick = () => this.stepProvider();
		const go = bar.createEl('button', { cls: 'mod-cta', text: tx('Verifica e carica modelli') });
		go.onclick = async () => {
			if (manIn.value.trim()) {
				this.models = [manIn.value.trim()];
				this.chosen = manIn.value.trim();
				return this.stepModel();
			}
			if (p.needsKey && !this.key) return this.stepConnect(tx('Inserisci la chiave API.'));
			if (!normalizeBaseUrl(this.url)) return this.stepConnect(tx('Inserisci l’indirizzo del server.'));
			go.disabled = true;
			go.setText(tx('Connessione…'));
			try {
				const list = await this.plugin.ai.listModels(p.id, normalizeBaseUrl(this.url), this.key);
				if (!list.length) return this.stepConnect(tx('Connesso, ma il server non ha modelli caricati. In LM Studio/Ollama scarica o carica un modello, oppure scrivi il nome qui sotto.'));
				this.models = list;
				const prev = this.plugin.settings.aiModels.find((m) => m.provider === p.id && list.includes(m.model));
				this.chosen = prev?.model ?? list.find((m) => !isEmbeddingModel(m)) ?? list[0];
				this.embedding = this.plugin.settings.aiEmbedding?.provider === p.id ? this.plugin.settings.aiEmbedding.model : '';
				this.stepModel();
			} catch (e) {
				this.stepConnect(e instanceof Error ? e.message : String(e));
			}
		};
	}

	// ---------------------------------------------------------------- step 3

	stepModel(status = '') {
		const p = this.p!;
		const c = this.header(3, tx('Scegli il modello'));
		const chatModels = this.models.filter((m) => !isEmbeddingModel(m));
		const embModels = this.models.filter(isEmbeddingModel);
		const list = chatModels.length ? chatModels : this.models;
		if (list.length > 8) {
			const f = c.createEl('input', { type: 'search', cls: 'ambraia-ai-filter', value: this.filter, attr: { placeholder: tx('Filtra {0} modelli…', list.length) } });
			f.oninput = () => {
				this.filter = f.value;
				draw();
			};
			window.setTimeout(() => f.focus(), 0);
		}
		const box = c.createDiv('ambraia-ai-models');
		const draw = () => {
			box.empty();
			const q = this.filter.toLowerCase();
			const shown = list.filter((m) => !q || m.toLowerCase().includes(q)).slice(0, 200);
			if (!shown.length) box.createDiv({ cls: 'ambraia-empty', text: tx('Nessun modello corrisponde.') });
			for (const m of shown) {
				const row = box.createDiv({ cls: 'ambraia-ai-model' + (m === this.chosen ? ' is-selected' : ''), text: m });
				row.onclick = () => {
					this.chosen = m;
					draw();
				};
			}
		};
		draw();
		if (embModels.length && p.supportsEmbeddings) {
			const e = c.createDiv('ambraia-ai-field');
			e.createEl('label', { text: tx('Ricerca semantica nel vault (facoltativa)') });
			e.createDiv({ cls: 'setting-item-description', text: tx('Un modello di embedding trova le note per significato e non solo per parole chiave.') });
			const sel = e.createEl('select', { cls: 'dropdown' });
			sel.createEl('option', { value: '', text: tx('Non usare (solo parole chiave)') });
			for (const m of embModels) sel.createEl('option', { value: m, text: m });
			sel.value = this.embedding;
			sel.onchange = () => (this.embedding = sel.value);
		}
		const ok = status.startsWith(OK);
		if (status) {
			const st = c.createDiv({ cls: ok ? 'ambraia-ai-ok' : 'ambraia-ai-error' });
			setIcon(st.createSpan('ambraia-ai-status-icon'), ok ? 'check-circle-2' : 'alert-circle');
			st.createSpan({ text: ok ? status.slice(OK.length) : status });
		}
		const bar = c.createDiv('ambraia-ai-bar');
		const back = bar.createEl('button', { text: tx('← Indietro') });
		back.onclick = () => this.stepConnect();
		const save = bar.createEl('button', { cls: 'mod-cta', text: tx('Salva e prova') });
		save.onclick = async () => {
			if (!this.chosen) return this.stepModel(tx('Seleziona un modello.'));
			save.disabled = true;
			save.setText(tx('Provo il modello…'));
			const msg = await this.save();
			this.stepModel(msg);
		};
		if (ok) {
			save.setText(tx('Salva di nuovo e prova'));
			save.removeClass('mod-cta');
			const done = bar.createEl('button', { cls: 'mod-cta', text: tx('Fine · apri la chat') });
			done.onclick = () => {
				this.close();
				this.onDone?.();
				void this.plugin.activateAiChat();
			};
		}
	}

	/** Persists key, URL and model; returns a status line (starting with OK on success). */
	async save(): Promise<string> {
		const p = this.p!;
		const ai = this.plugin.ai;
		const s = this.plugin.settings;
		if (p.needsKey || p.id === 'custom') await ai.setKey(p.id, this.key);
		const url = normalizeBaseUrl(this.url);
		if (url && url !== normalizeBaseUrl(p.baseUrl)) s.aiProviderUrls[p.id] = url;
		else delete s.aiProviderUrls[p.id];
		s.aiEnabled = true;
		const model = await ai.addModel({ provider: p.id, model: this.chosen });
		if (this.embedding) s.aiEmbedding = { provider: p.id, model: this.embedding };
		else if (s.aiEmbedding?.provider === p.id) s.aiEmbedding = null;
		await this.plugin.saveSettings();
		this.plugin.refreshAiViews();
		try {
			const answer = await ai.test(model);
			return OK + tx('Funziona. Risposta del modello: “{0}”', answer.slice(0, 120));
		} catch (e) {
			new Notice(tx('Modello salvato, ma la prova non è riuscita.'));
			return tx('Salvato, ma la prova non è riuscita: ') + (e instanceof Error ? e.message : String(e));
		}
	}
}
